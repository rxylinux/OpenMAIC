/**
 * Retry-upload controller — the page's actual wrong-retry submission path,
 * extracted so the full failure/retry flow is drivable in tests.
 *
 * Contract (R7 + early-review #7/#9): one wrong retry ships THIS attempt's
 * answer under a stable event id, with the ENTIRE event payload frozen at
 * first send — `buildPayload` runs exactly once per event, against the state
 * of the moment (the record snapshot: question text, options, key, analysis,
 * classification), and retries replay that frozen payload verbatim. A record
 * refreshed mid-flight can therefore never swap content under a pending
 * event id (the C outbox requires exactly this). The id is minted on first
 * send, reused for identical-content retries, cleared only after the server
 * commits; a DIFFERENT answer after a failure mints a NEW event with a
 * freshly built payload. An in-flight submission swallows double-clicks; ANY
 * handler exception resolves to 'failed' with the frozen event retained —
 * never a stuck pending, never a fabricated success.
 */
export type RetryUploadOutcome = 'ok' | 'failed' | 'busy';

export interface RetryUploadController {
  /** The stable event id of the submission currently in flight or awaiting retry. */
  currentEventId(): string | null;
  /** Upload one wrong retry. `busy` means a submission is already in flight. */
  submitWrong(picked: readonly string[]): Promise<RetryUploadOutcome>;
}

function samePicked(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].every((value, i) => value === b[i]);
}

export function createRetryUploadController(deps: {
  onWrong: (payload: unknown, eventId: string) => Promise<boolean>;
  mintEventId: () => string;
  /**
   * Builds the FULL event payload for a NEW event from the submission. The
   * default identity builder ships the picked answer itself; the page passes
   * its full capture-payload builder so retries carry the frozen record
   * snapshot, not a rebuild over a refreshed record.
   */
  buildPayload?: (picked: readonly string[], eventId: string) => unknown;
}): RetryUploadController {
  const build = deps.buildPayload ?? ((picked: readonly string[]) => picked);
  let pendingPayload: unknown = null;
  let pendingEventId: string | null = null;
  let pendingPicked: readonly string[] | null = null;
  let inFlight = false;
  return {
    currentEventId: () => pendingEventId,
    async submitWrong(picked) {
      if (inFlight) return 'busy'; // double-click: no second request, no second count
      // Frozen-event semantics: reuse the pending event ONLY for identical
      // content. A different answer after a failed upload is a new
      // submission — and a NEW event rebuilds the payload from the CURRENT
      // record, which is correct: it is a new fact.
      if (pendingEventId === null || pendingPicked === null || !samePicked(picked, pendingPicked)) {
        pendingEventId = deps.mintEventId();
        pendingPayload = build(picked, pendingEventId);
        pendingPicked = picked;
      }
      inFlight = true;
      try {
        const ok = await deps.onWrong(pendingPayload, pendingEventId);
        if (ok) {
          pendingEventId = null; // committed: the next wrong retry is a new event
          pendingPayload = null;
          pendingPicked = null;
        }
        return ok ? 'ok' : 'failed';
      } catch {
        // POST-then-GET failures, network throws, anything: the submission
        // did NOT commit — keep the frozen event for an honest retry.
        return 'failed';
      } finally {
        inFlight = false;
      }
    },
  };
}
