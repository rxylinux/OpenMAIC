/**
 * A bounded, URL-free descriptor for an unknown error.
 *
 * Transport failures can embed the full request URL — for provider-returned
 * signed URLs (presigned uploads, result archives, OSS images) that query
 * string carries credentials, so the message must never be interpolated into
 * a log line or a caller-facing error. `code` and `name` are not trusted
 * either: an arbitrary Error can carry attacker-chosen strings in both, so
 * only an allowlist of known transport tokens is ever emitted, and everything
 * else collapses to a fixed fallback.
 */
const KNOWN_ERROR_CODES = new Set([
  // errno tokens Node's TCP/TLS/DNS layers emit.
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  // undici dispatcher tokens.
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'UND_ERR_DESTROYED',
]);

const KNOWN_ERROR_NAMES = new Set([
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Error',
  'DOMException',
  'AbortError',
  'TimeoutError',
  'UnsafeNetworkTargetError',
  'DownloadSizeLimitError',
  'AggregateError',
]);

/** An allowlisted, fixed-vocabulary token describing `error`, or a fixed fallback. */
export function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) return `code ${code}`;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && KNOWN_ERROR_NAMES.has(name)) return name;
  }
  return 'transport error';
}
