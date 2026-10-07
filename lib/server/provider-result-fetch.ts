/**
 * Fetch a URL a media provider returned in its response (a generated image,
 * video or poster).
 *
 * The URL comes from the provider, not from configuration, so it is held to
 * the strict public policy whatever address policy the provider's own base URL
 * runs under: HTTPS only, public addresses only (never the operator's
 * ALLOW_LOCAL_NETWORKS opt-in). The strict transport re-validates every
 * redirect hop under the same policy and pins connect-time DNS to the vetted
 * answers. A `data:` URL (some adapters inline their result) is decoded locally
 * and never touches the network; callers pass their byte limit, which refuses
 * an oversized payload before it is decoded.
 */
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
import { UnsafeNetworkTargetError, validateUrlForSSRFWithPolicy } from '@/lib/server/ssrf-guard';
import { safeErrorCode } from '@/lib/utils/safe-error-code';

export const PROVIDER_RESULT_URL_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: false,
  requireHttps: true,
};

/**
 * The exact number of UTF-8 bytes `Buffer.from(decodeURIComponent(rawData),
 * 'utf8')` will produce, computed by a bounded scan that never materializes
 * the decoded string. A percent triplet contributes its one decoded byte of a
 * (re-encodable) UTF-8 sequence; a raw ASCII unit is one byte; a raw Latin-1
 * supplement unit is two; other BMP units are three; a surrogate pair is four
 * (counted on the lead unit); a lone surrogate re-encodes as the three-byte
 * U+FFFD replacement character.
 */
function estimateDecodedLength(rawData: string, isBase64: boolean): number {
  if (isBase64) {
    const padding = rawData.endsWith('==') ? 2 : rawData.endsWith('=') ? 1 : 0;
    return Math.ceil((rawData.length * 3) / 4) - padding;
  }
  let total = 0;
  for (let i = 0; i < rawData.length; ) {
    const code = rawData.charCodeAt(i);
    if (code === 0x25 /* % */ && i + 2 < rawData.length) {
      i += 3;
      total += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff /* lead surrogate */) {
      const next = rawData.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        total += 4;
        continue;
      }
      i += 1;
      total += 3; // re-encoded as U+FFFD
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff /* lone trail surrogate */) {
      i += 1;
      total += 3; // re-encoded as U+FFFD
      continue;
    }
    i += 1;
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return total;
}

/** Decode a `data:` URL into its bytes and declared MIME type, refusing over `maxBytes`. */
export function decodeDataUrl(url: string, maxBytes?: number): { bytes: Buffer; mimeType: string } {
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Invalid data URL: missing comma');
  }
  const meta = url.slice(5, commaIndex);
  const rawData = url.slice(commaIndex + 1);
  const params = meta.split(';');
  const isBase64 = params.includes('base64');
  // Refuse over the limit before building any buffer: the estimate never
  // understates the decoded length, so an oversized payload is rejected
  // without materializing it first.
  if (maxBytes !== undefined && estimateDecodedLength(rawData, isBase64) > maxBytes) {
    throw new Error(`data: URL payload exceeds the ${maxBytes}-byte limit`);
  }
  const bytes = isBase64
    ? Buffer.from(rawData, 'base64')
    : Buffer.from(decodeURIComponent(rawData), 'utf8');
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new Error(`data: URL payload exceeds the ${maxBytes}-byte limit`);
  }
  return { bytes, mimeType: params[0]?.trim().toLowerCase() || 'application/octet-stream' };
}

export async function fetchProviderResultUrl(
  url: string,
  init: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<Response> {
  if (url.startsWith('data:')) {
    const { bytes, mimeType } = decodeDataUrl(url, init.maxBytes);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': mimeType, 'content-length': String(bytes.byteLength) },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Download failed: invalid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Download failed: URL must use https (${parsed.protocol})`);
  }

  const ssrfError = await validateUrlForSSRFWithPolicy(parsed.href, { allowLocalNetworks: false });
  if (ssrfError) throw new UnsafeNetworkTargetError(ssrfError);

  const requestInit: RequestInit = init.signal ? { signal: init.signal } : {};
  try {
    return await providerFetch(url, requestInit, {
      ...PROVIDER_RESULT_URL_POLICY,
      rejectRedirects: true,
    });
  } catch (error) {
    // A transport failure's message (or its `cause`) can embed the provider's
    // signed result URL, so it is never propagated or logged downstream: the
    // caller gets a fixed message plus the error's code/class only. Guard
    // refusals (fixed text) pass through unchanged. Abort/timeout keep their
    // recognizable standard names for cancel/timeout semantics, but as NEW
    // errors with fixed messages — the original message, `cause` and any
    // custom fields could all carry the signed URL.
    if (error instanceof UnsafeNetworkTargetError) throw error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new DOMException('Provider result download aborted', 'AbortError');
      }
      if (error.name === 'TimeoutError') {
        throw new DOMException('Provider result download timed out', 'TimeoutError');
      }
    }
    throw new Error(`Provider result download failed: ${safeErrorCode(error)}`);
  }
}
