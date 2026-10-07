/**
 * The anchored-relevance payload predicate for `setSessionStatusIfLatest`
 * (internal, shared by the browser and PostgreSQL backends).
 *
 * The guard's `relevantSceneId` form must decide "would the CANONICAL quiz
 * reader adopt this newer sibling over the repair target?" EXACTLY as the app
 * reader does: it takes the sibling's LATEST scene-filtered record — never
 * "any anchored record" — and adopts it only when the payload carries
 * `payloadVersion: 1`, a real quiz phase, and a plain (non-array, non-null)
 * `answers` record. This module mirrors that reader check field-for-field; a
 * stored record that passes the write-time skeleton gate but would be SKIPPED
 * by the reader (e.g. a missing/foreign `payloadVersion`) must not block a
 * legitimate repair, and one the reader would adopt must.
 *
 * Plan (`capturePlan`) validity is deliberately NOT consulted here: the reader
 * treats a present-but-corrupt plan as a LOUD error after adoption, so plan
 * corruption remains the reader's failure, never a guard input.
 */
export function isAdoptableQuizAttemptPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as { payloadVersion?: unknown; phase?: unknown; answers?: unknown };
  if (candidate.payloadVersion !== 1) return false;
  if (
    candidate.phase !== 'draft' &&
    candidate.phase !== 'submitted' &&
    candidate.phase !== 'reviewed'
  ) {
    return false;
  }
  return (
    typeof candidate.answers === 'object' &&
    candidate.answers !== null &&
    !Array.isArray(candidate.answers)
  );
}
