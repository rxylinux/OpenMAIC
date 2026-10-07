/**
 * Whether `error` is the refusal a `redirect: 'error'` (or equivalent
 * reject-redirect) request raises for a 3xx answer. Undici reports it as
 * `TypeError: fetch failed` with an `Error('unexpected redirect')` somewhere in
 * the `cause` chain.
 *
 * Dependency-free on purpose: browser-bundled modules (the settings UI's
 * connectivity probe helper) share it with the server transports.
 */
export function isRejectedRedirectError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && /unexpected redirect/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
