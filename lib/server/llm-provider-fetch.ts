/**
 * The pinned transport for LLM calls to a caller-chosen endpoint (a
 * client-supplied base URL or an unmanaged provider's catalog default).
 */
import { STATUS_CODES } from 'node:http';

import { LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';
import { createLogger } from '@/lib/logger';
import {
  providerFetch,
  resolveAllowLocalNetworks,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';
import {
  findUnsafeNetworkTargetError,
  UnsafeNetworkTargetError,
  validateUrlForSSRFWithPolicy,
} from '@/lib/server/ssrf-guard';
import {
  fetchWithRedirectValidation,
  type RedirectValidationFetch,
} from '@/lib/server/fetch-with-redirect-validation';
import { isRejectedRedirectError } from '@/lib/utils/rejected-redirect';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const log = createLogger('LLM Provider Fetch');

// ── Address-policy trust matrix ──────────────────────────────────────────────
//
// Who chose the endpoint decides the address policy; the transport is the same
// strict pinned providerFetch either way (connect-time DNS pinning, 3xx
// refused, 15-minute budget):
//
//  - a URL from the request body (client BYOK) is arbitrary caller input and
//    runs under the strict public policy: private/loopback/CGNAT targets are
//    refused even when the operator opted into ALLOW_LOCAL_NETWORKS, because
//    the operator's opt-in is about *their* endpoints, not the client's;
//  - an unmanaged provider's catalog default is a code constant (not caller
//    input), so it keeps the operator policy — a self-hosted Ollama deployment
//    with ALLOW_LOCAL_NETWORKS=true keeps working when the caller names
//    `ollama:…` without sending a base URL. Cloud metadata is refused under
//    every policy;
//  - a server-managed endpoint or an operator-selected model (MODEL_ROUTES /
//    DEFAULT_MODEL) never reaches this module: resolveModel keeps it on the
//    operator transport (redirect hop validation), or on the proxy transport
//    below when the operator configured a proxy.
const CLIENT_BASE_URL_LLM_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: false,
  rejectRedirects: true,
  headersTimeout: LLM_FETCH_TIMEOUT_MS,
  bodyTimeout: LLM_FETCH_TIMEOUT_MS,
};

const CLIENT_CATALOG_DEFAULT_LLM_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: undefined,
  rejectRedirects: true,
  headersTimeout: LLM_FETCH_TIMEOUT_MS,
  bodyTimeout: LLM_FETCH_TIMEOUT_MS,
};

const TIMEOUT_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

function hasErrorCode(error: unknown, codes: Set<string>): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * The error a failed request surfaces to callers. Routes relay LLM error
 * messages, and the AI SDK turns a `fetch failed` cause into "Cannot connect to
 * API: <cause message>", so the cause carries a fixed reason only (the system
 * error text names addresses, ports and resolver answers). The shape stays a
 * `TypeError('fetch failed')` with a cause so the SDK still classifies it as a
 * retryable connection failure. Address-policy refusals (fixed guard text) and
 * caller aborts pass through unchanged.
 */
export function toCallerSafeTransportError(error: unknown): unknown {
  if (isAbortError(error) || findUnsafeNetworkTargetError(error)) return error;
  const reason = isRejectedRedirectError(error)
    ? 'redirects are not allowed'
    : hasErrorCode(error, TIMEOUT_ERROR_CODES)
      ? 'request timed out'
      : 'connection failed';
  return new TypeError('fetch failed', { cause: new Error(reason) });
}

// Entity headers describe the replaced body; everything else (retry-after,
// rate-limit and request-id headers) is kept for the SDK's retry handling.
const DROPPED_ERROR_HEADERS = ['content-type', 'content-length', 'content-encoding'];

// How much of an error body is kept for the server log, and how long reading
// it may take. The body is only logged, so a large or trickling one is cut
// short and cancelled instead of being buffered.
const ERROR_BODY_LOG_BYTES = 1024;
const ERROR_BODY_LOG_WAIT_MS = 1000;

async function readErrorBodyPreview(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ERROR_BODY_LOG_WAIT_MS);
  });
  try {
    while (total < ERROR_BODY_LOG_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout' || next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    // An unreadable body only loses the log preview.
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, ERROR_BODY_LOG_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Replace an HTTP error response with an empty body and the standard reason
 * phrase. The AI SDK builds the error message from the provider's error JSON
 * (or the status text when the body is empty), and routes relay that message,
 * so a caller-chosen endpoint's response text never reaches the caller. The
 * status and headers are kept, so retry and status classification still work;
 * a status outside the range a `Response` accepts (600-999 pass through the
 * transport) is reported as 502.
 */
async function withoutErrorBody(response: Response): Promise<Response> {
  const preview = await readErrorBodyPreview(response);
  log.warn(`LLM provider answered HTTP ${response.status}: ${preview.slice(0, 500)}`);
  const status = response.status <= 599 ? response.status : 502;
  const headers = new Headers(response.headers);
  for (const name of DROPPED_ERROR_HEADERS) headers.delete(name);
  return new Response(null, {
    status,
    statusText: STATUS_CODES[status] ?? '',
    headers,
  });
}

/**
 * Normalize a `fetch` call whose input is a `Request` into a (url, init) pair.
 * `providerFetch` takes a string URL, so a bare `Request` would otherwise lose
 * its method, headers, body and signal. Explicit `init` fields win per field,
 * mirroring `fetch(request, init)` merging semantics; a streaming request body
 * carried over from the `Request` needs undici's `duplex: 'half'`.
 */
function requestToUrlInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): { url: string; init?: RequestInit } {
  if (!(input instanceof Request)) {
    return { url: input instanceof URL ? input.toString() : input, init };
  }
  const merged: RequestInit = {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal,
    ...(init ?? {}),
  };
  if (merged.body === input.body && input.body !== null) {
    (merged as RequestInit & { duplex?: 'half' }).duplex = 'half';
  }
  return { url: input.url, init: merged };
}

/**
 * `fetch` for LLM calls to a caller-chosen endpoint. Any dispatcher already on
 * the request (the default timeout-only one) is replaced by the pinned one.
 * Transport failures and HTTP error bodies are reduced to fixed text; details
 * are logged server-side.
 */
export function createCallerChosenLlmFetch(policy: ProviderFetchPolicy): typeof fetch {
  return async (input, init) => {
    const { url, init: mergedInit } = requestToUrlInit(input, init);
    let response: Response;
    try {
      response = await providerFetch(url, mergedInit, policy);
    } catch (error) {
      if (!isAbortError(error)) log.warn('LLM provider request failed:', error);
      throw toCallerSafeTransportError(error);
    }
    return response.status >= 400 ? withoutErrorBody(response) : response;
  };
}

/** Transport for a base URL the request body supplied: strict public policy. */
export const clientBaseUrlLlmFetch: typeof fetch = createCallerChosenLlmFetch(
  CLIENT_BASE_URL_LLM_POLICY,
);

/**
 * Transport for a caller-chosen unmanaged provider's catalog default: the URL
 * is a code constant, so the operator address policy applies (the operator's
 * ALLOW_LOCAL_NETWORKS opt-in covers their self-hosted defaults).
 */
export const clientCatalogDefaultLlmFetch: typeof fetch = createCallerChosenLlmFetch(
  CLIENT_CATALOG_DEFAULT_LLM_POLICY,
);

// ── Operator transport ────────────────────────────────────────────────────────
//
// An operator-selected endpoint keeps redirect-hop re-validation (the operator
// chose the origin, not where it redirects), and since D it also gets the
// connect-time half of the defence: the request rides the strict provider
// transport, whose pinned dispatcher resolves and vets every DNS answer at
// connect (cloud metadata refused regardless of the opt-in), with the same
// 15-minute headers/body budget as every other LLM transport.

const OPERATOR_LLM_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: undefined,
  headersTimeout: LLM_FETCH_TIMEOUT_MS,
  bodyTimeout: LLM_FETCH_TIMEOUT_MS,
};

/**
 * `fetch` for LLM calls to an operator-selected endpoint. Transport failures
 * and HTTP error bodies are reduced to fixed text like every other LLM
 * transport: routes relay LLM error messages, and the system error text names
 * addresses, ports and resolver answers.
 */
export const operatorLlmFetch: typeof fetch = async (input, init) => {
  const { url, init: mergedInit } = requestToUrlInit(input, init);
  let response: Response;
  try {
    response = await providerFetch(url, mergedInit, OPERATOR_LLM_POLICY);
  } catch (error) {
    if (!isAbortError(error)) log.warn('LLM provider request failed:', error);
    throw toCallerSafeTransportError(error);
  }
  return response.status >= 400 ? withoutErrorBody(response) : response;
};

// ── Operator proxy transport ─────────────────────────────────────────────────
//
// A proxied LLM request cannot pin the target's DNS the way the direct strict
// transport does: the proxy resolves the target hostname, so the connect-time
// pin would only ever see the proxy's own address. The equivalent guarantees
// this transport provides instead are:
//
//  - the target endpoint was chosen by the operator (a caller-chosen endpoint
//    behind a proxy is refused in resolveModel — fail closed, because the
//    proxy can be pointed at any host the caller names);
//  - the first-hop URL was validated at the URL layer by resolveModel; and
//  - every redirect hop is re-validated at the URL layer under the operator
//    policy before the request is issued through the proxy, so a 3xx cannot
//    steer the proxied request at an internal address.
//
// The proxy URI itself is operator configuration (server-only `proxy` field in
// the provider config) and is trusted like every other operator endpoint; the
// proxy keeps the same 15-minute headers/body budget as the direct dispatcher.

/** One ProxyAgent per proxy URI, reused across requests. */
const proxyAgents = new Map<string, ProxyAgent>();

function proxyAgentFor(proxy: string): ProxyAgent {
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent({
      uri: proxy,
      // (http/https proxies only — undici's Socks5ProxyAgent drops these
      // options, so socks5:// proxies keep undici's default 300 s cap.)
      headersTimeout: LLM_FETCH_TIMEOUT_MS,
      bodyTimeout: LLM_FETCH_TIMEOUT_MS,
    });
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

/** Tear down the pooled proxy agents between tests. */
export function destroyProxyLlmAgentsForTests(): void {
  for (const agent of proxyAgents.values()) {
    void agent.destroy().catch(() => undefined);
  }
  proxyAgents.clear();
}

/**
 * `fetch` for LLM calls to an operator-selected endpoint through an operator
 * HTTP proxy. Redirects are followed only after each hop target passes the URL
 * guard under the operator address policy; every hop is issued through the
 * proxy with the extended LLM timeouts.
 */
export function createProxyLlmFetch(proxy: string): typeof fetch {
  const agent = proxyAgentFor(proxy);
  const proxyTransport: RedirectValidationFetch = (input, init) =>
    undiciFetch(input, {
      ...(init as Record<string, unknown>),
      redirect: 'manual',
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  return async (input, init) => {
    const { url, init: mergedInit } = requestToUrlInit(input, init);
    // The first hop is validated here, explicitly under the operator policy:
    // the hop loop only validates redirect targets, and `resolveModel` only
    // pre-validates caller-chosen endpoints — an operator-configured endpoint
    // reaches this branch unchecked otherwise. Cloud metadata is refused under
    // every policy; a local endpoint is allowed only with the operator opt-in
    // (the operator selected it), and nothing is sent to the proxy before the
    // check passes.
    const firstHopError = await validateUrlForSSRFWithPolicy(url, {
      allowLocalNetworks: resolveAllowLocalNetworks(),
    });
    if (firstHopError) throw new UnsafeNetworkTargetError(firstHopError);
    let response: Response;
    try {
      response = await fetchWithRedirectValidation(url, mergedInit, {
        fetchImpl: proxyTransport,
      });
    } catch (error) {
      if (!isAbortError(error)) log.warn('LLM provider request (proxied) failed:', error);
      throw toCallerSafeTransportError(error);
    }
    return response.status >= 400 ? withoutErrorBody(response) : response;
  };
}
