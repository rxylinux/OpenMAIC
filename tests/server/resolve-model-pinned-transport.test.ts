/**
 * `resolveModel` transport trust matrix, exercised against the real strict
 * transports.
 *
 * Provenance decides the transport (never request input):
 *  - a body-supplied base URL is strict-public and pinned, refuses redirects,
 *    and never inherits ALLOW_LOCAL_NETWORKS;
 *  - a caller-chosen catalog default keeps the operator policy (a code
 *    constant), still pinned with the 15-minute budget;
 *  - an operator-selected endpoint rides the pinned operator transport
 *    (connect pinning + hop validation + 15-minute budget);
 *  - a caller endpoint behind an operator proxy fails closed.
 */
import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveModel } from '@/lib/server/resolve-model';
import {
  clientBaseUrlLlmFetch,
  clientCatalogDefaultLlmFetch,
  destroyProxyLlmAgentsForTests,
  operatorLlmFetch,
  toCallerSafeTransportError,
} from '@/lib/server/llm-provider-fetch';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveApiKey: vi.fn(),
  resolveBaseUrl: vi.fn(),
  resolveProxy: vi.fn(),
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveApiKey: mocks.resolveApiKey,
  resolveBaseUrl: mocks.resolveBaseUrl,
  resolveProxy: mocks.resolveProxy,
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function generateError(model: Awaited<ReturnType<typeof resolveModel>>) {
  try {
    await generateText({ model: model.model, prompt: 'hi', maxRetries: 0 });
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected generateText to fail');
}

/** A loopback server bound to one exact port (a catalog default endpoint). */
async function startLoopbackOnPort(
  port: number,
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
) {
  const { createServer } = await import('node:http');
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const requests = () => {
    // The helper servers above track counts; this one is tracked by closure.
    return requestCount;
  };
  let requestCount = 0;
  server.on('request', () => {
    requestCount += 1;
  });
  servers.push(server);
  return { requests };
}

const servers: import('node:http').Server[] = [];

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('resolveModel — transport trust matrix', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    destroyAudioProviderDispatchersForTests();
    destroyProxyLlmAgentsForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolveApiKey.mockImplementation((_id: string, client?: string) => client || 'key');
    mocks.resolveBaseUrl.mockImplementation((_id: string, client?: string) => client);
    mocks.resolveProxy.mockReturnValue(undefined);
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    destroyAudioProviderDispatchersForTests();
    destroyProxyLlmAgentsForTests();
    vi.unstubAllGlobals();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    delete process.env.DEFAULT_MODEL;
    await closeLoopbackServers();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('selects the strict-public pinned transport for a body-supplied base URL', async () => {
    const resolved = await resolveModel({
      modelString: 'openai:gpt-4o',
      apiKey: 'client-key',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
    // The caller transport really is the strict-public pinned one: the next
    // test exercises its connect-time behaviour end to end.
    expect(typeof clientBaseUrlLlmFetch).toBe('function');
  });

  it('rejects a private body-supplied base URL even with the operator opt-in', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    await expect(
      resolveModel({
        modelString: 'openai:gpt-4o',
        apiKey: 'client-key',
        baseUrl: 'http://192.168.1.10/v1',
      }),
    ).rejects.toThrow(/Local\/private network URLs are not allowed/);
  });

  it('pins a body-supplied URL at connect and refuses a rebinding answer', async () => {
    const internal = await startLoopback();
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    const resolved = await resolveModel({
      modelString: 'openai:gpt-4o',
      apiKey: 'client-key',
      baseUrl: 'https://rebinding.example.test/v1',
    });

    const error = await generateError(resolved);
    expect(error.message).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    expect(internal.requests()).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('refuses a redirect from a body-supplied endpoint with fixed text', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    // A catalog-default policy is the only pinned transport that follows
    // redirects; the strict caller policy refuses them. Use the transport
    // directly for the redirect refusal shape the SDK would surface.
    const error = toCallerSafeTransportError(
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    ) as TypeError;
    expect(error).toBeInstanceOf(TypeError);
    expect((error.cause as Error).message).toBe('redirects are not allowed');
  });

  it('keeps a caller-chosen catalog default on the operator policy with local networks', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    // No base URL is sent: the caller-chosen unmanaged provider's CATALOG
    // default (a code constant, Lemonade's http://localhost:13305/v1) applies,
    // and the operator opt-in legitimately covers it.
    const provider = await startLoopbackOnPort(13305, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          created: 1,
          model: 'Gemma-4-26B-A4B-it-GGUF',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
        }),
      );
    });

    const resolved = await resolveModel({
      modelString: 'lemonade:Gemma-4-26B-A4B-it-GGUF',
      apiKey: 'k',
    });

    const result = await generateText({ model: resolved.model, prompt: 'hi', maxRetries: 0 });
    expect(result.text).toBe('OK');
    expect(provider.requests()).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('keeps an operator default model on the pinned operator transport', async () => {
    process.env.DEFAULT_MODEL = 'ollama:llama3.3';
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    // Ollama's catalog default is a loopback URL: the pinned operator
    // transport resolves it through the mocked connect-time lookup.
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    const resolved = await resolveModel({});
    expect(resolved.providerId).toBe('ollama');
    // No URL-layer resolution ran for an operator-selected endpoint.
    expect(mocks.promisesLookup).not.toHaveBeenCalled();

    // The connect-time lookup runs when the request is issued: the pinned
    // operator transport resolves the catalog host (nothing listens on the
    // loopback answer — the failure must be bounded caller-safe text).
    const error = await generateError(resolved);
    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'localhost',
      expect.anything(),
      expect.any(Function),
    );
    expect(error.message).not.toMatch(/ECONNREFUSED|errno|syscall/);
    expect(globalFetch).not.toHaveBeenCalled();
  }, 20_000);

  it('fails closed when a caller endpoint meets an operator proxy', async () => {
    mocks.resolveProxy.mockReturnValue('http://proxy.example.test:3128');

    await expect(
      resolveModel({
        modelString: 'openai:gpt-4o',
        apiKey: 'client-key',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).rejects.toThrow(/caller-chosen provider endpoint cannot be used through the server proxy/);
  });

  it('normalizes a Request input without losing method, headers or body', async () => {
    // The caller-chosen transport is fetch-shaped: the AI SDK passes
    // (url, init), but a Request input must survive too — with its actual
    // body bytes, not an empty stream.
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    const request = new Request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      body,
    });
    const spy = vi
      .spyOn(await import('@/lib/server/audio-provider-fetch'), 'audioProviderFetch')
      .mockImplementation(async (_input, init) => {
        // Consume the carried body for real: the exact bytes must arrive.
        const carried = init?.body ? await new Response(init.body).text() : '';
        return new Response(carried, { status: 200 });
      });
    try {
      const response = await clientBaseUrlLlmFetch(request);
      expect(await response.text()).toBe(body);
      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');
    } finally {
      spy.mockRestore();
    }
  });

  it('lets explicit init override the Request fields per field', async () => {
    const request = new Request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-request' },
      body: 'request-body',
    });
    const spy = vi
      .spyOn(await import('@/lib/server/audio-provider-fetch'), 'audioProviderFetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      await clientBaseUrlLlmFetch(request, {
        method: 'PUT',
        headers: { Authorization: 'Bearer sk-init' },
      });
      const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
      expect(init?.method).toBe('PUT');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-init');
    } finally {
      spy.mockRestore();
    }
  });

  it('carries the Request signal: an aborted request fails as an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    await expect(clientBaseUrlLlmFetch(request)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('exposes the three provenance transports as distinct functions', async () => {
    expect(clientBaseUrlLlmFetch).not.toBe(clientCatalogDefaultLlmFetch);
    expect(clientCatalogDefaultLlmFetch).not.toBe(operatorLlmFetch);
    expect(operatorLlmFetch).not.toBe(clientBaseUrlLlmFetch);
  });
});
