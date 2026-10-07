/**
 * Internal HTTP error type of the runtime/asset/document handlers.
 *
 * NOT part of the package's public surface (it is not re-exported from the
 * package index): the handler is the only legitimate constructor, so an
 * `instanceof RuntimeHttpError` in `mappedError` reliably identifies
 * handler-authored status codes rather than arbitrary host errors. Tests in
 * this package import the class directly to prove the ≥500 redaction
 * boundary holds even when a host callback (store or authenticate) somehow
 * throws one carrying sensitive content.
 */
export class RuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * The ONE deliberate ≥500 response that must reach the client verbatim: a
 * store without `setSessionStatusIfLatest` honestly refusing the guarded
 * status route (501 LINEAGE_GUARD_UNSUPPORTED) instead of silently
 * downgrading to an unguarded write. `mappedError` emits FIXED literal
 * public fields for this type — never instance-controlled content — so this
 * sentinel is the only path by which a ≥500 body leaves the handler
 * untranslated.
 */
export class LineageGuardUnsupportedHttpError extends Error {
  constructor() {
    super('@openmaic/storage: this runtime store does not support the atomic lineage guard');
    this.name = 'LineageGuardUnsupportedHttpError';
  }
}
