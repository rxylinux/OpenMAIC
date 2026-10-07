/**
 * Shared STRICT plan-consumer rules (P3 §3 + r1 + r2): the fail-closed
 * identity matching, evidence resolution, durable-binding recovery,
 * attempt-owner resolution, and report-consumption order every capture
 * consumer uses — the QuizView plan executor, its lifecycle flush, and the
 * client capture helper. Matching always requires the key, the
 * frozen-content fingerprint, AND the instance plane (modern token, or
 * both-token-less legacy + equal createdAt): absent metadata never
 * upgrades anything.
 *
 * r2 additions: every plan identity is built from the FROZEN
 * plan.learnerKey (a resolved learner that no longer matches is an honest
 * stale outcome — never a write into another partition); the durable
 * binding bridge handles every tagged write result (a concurrent exact
 * migration is canonically reread and accepted only when the identical
 * frozen plan holds the exact destination, contradictions are explicit
 * conflicts, and authority write outcomes are checked — a durable
 * migration with a pending authority repair stays retryable); and the
 * attempt owner for NEW items is resolved FRESH right before their
 * enqueue — never cached across a helper that can commit authority — with
 * repair from the exact committed progress/journal evidence.
 */
import type {
  ActualIdentity,
  AttemptHeaderIdentity,
  AuthorityBindProof,
  CommittedBindEvidence,
  PlanIdentity,
} from '@/lib/mistake-book/progress';
import type { QuizCapturePlan, QuizCapturePlanItem } from '@/lib/quiz/runtime';
import type { FlushReport, QueueSideIdentity } from '@/lib/mistake-book/outbox';

// ── Ledger target (the REAL shape QuizView stores per question) ────────────

/** One plan item's ledger target: the full adopted queue identity. */
export interface PlanLedgerTarget {
  questionId: string;
  eventId: string;
  /** Per-question operation sequence: results from older ops are dropped. */
  opSeq: number;
  state: string;
  /** Latest VERIFIED record key (owner-scoped; migrated on committed binds). */
  handle?: string;
  /** Stable content fingerprint of the frozen payload (receipt identity). */
  fingerprint?: string;
  /** The record's creation token — the modern instance identity. */
  recordToken?: string;
  /** Legacy token-less records: createdAt is the instance identity. */
  recordCreatedAt?: number;
}

/**
 * Adopt a successful enqueue outcome into a ledger target (r1 §1 + r2 §5):
 * the item leaves 'saving' (the LOCAL durable write completed) and carries
 * the REAL instance's complete identity — the other plane's stale value is
 * cleared so later verdicts can never cross planes. The state follows the
 * REAL enqueue owner (r2 §5): a record created under NO owner is 'unbound'
 * (claim-only — it cannot "sync when back online"), a bound owner's record
 * is 'queued'.
 */
export function adoptEnqueuedOutcome<T extends PlanLedgerTarget>(
  target: T,
  outcome:
    | { kind: 'persisted'; handle: string; fingerprint: string; creationToken: string }
    | {
        kind: 'reused';
        handle: string;
        fingerprint: string;
        recordToken?: string;
        recordCreatedAt?: number;
      },
  enqueueOwner: string,
): T {
  const unbound = enqueueOwner === '';
  return {
    ...target,
    state: unbound ? 'unbound' : 'queued',
    handle: outcome.handle,
    fingerprint: outcome.fingerprint,
    ...(outcome.kind === 'persisted'
      ? { recordToken: outcome.creationToken, recordCreatedAt: undefined }
      : outcome.recordToken !== undefined
        ? { recordToken: outcome.recordToken, recordCreatedAt: undefined }
        : { recordToken: undefined, recordCreatedAt: outcome.recordCreatedAt }),
  };
}

/**
 * Adopt a strictly-matched evidence side into a ledger target (r1 §1 +
 * r2 §5): the side's OWN complete identity (never expected values). The
 * state follows the side's REAL owner — an unbound record is 'unbound'
 * (claim-only), never a 'queued' sync promise; 'uploaded' only after the
 * durable confirm committed.
 */
export function adoptEvidenceSide<T extends PlanLedgerTarget>(
  target: T,
  side: QueueSideIdentity,
  state: 'queued' | 'uploaded',
): T {
  const resolved = side.owner === '' ? 'unbound' : state;
  return {
    ...target,
    state: resolved,
    handle: side.key,
    fingerprint: side.fingerprint,
    ...(side.recordToken != null
      ? { recordToken: side.recordToken, recordCreatedAt: undefined }
      : { recordToken: undefined, recordCreatedAt: side.createdAt }),
  };
}

/**
 * The single ledger-patch rule shared by every consumer wiring (r2 §6): a
 * patch decided under an older operation NEVER lands on a newer target,
 * and terminal facts (uploaded / conflict) are never downgraded by late
 * verdicts. Returns the patched target, or null when the patch must be
 * dropped.
 */
export function applyPlanLedgerPatch<T extends PlanLedgerTarget>(
  current: T,
  patch: Partial<PlanLedgerTarget>,
): T | null {
  if (patch.opSeq !== undefined && patch.opSeq !== current.opSeq) {
    return null; // superseded operation — stale result never lands
  }
  if (current.state === 'uploaded' && patch.state !== undefined && patch.state !== 'uploaded') {
    return null; // uploaded is terminal
  }
  if (current.state === 'conflict' && patch.state !== undefined && patch.state !== 'conflict') {
    return null; // a permanent refusal is terminal too
  }
  return { ...current, ...patch } as T;
}

// ── Identity helpers ────────────────────────────────────────────────────────

/**
 * The FULL immutable plan identity for one item (every field required).
 * r2 §6: the LEARNER plane comes from the FROZEN plan header — never from
 * the currently resolved learner, so a learner switch can never read or
 * write another partition under this frozen plan.
 */
export function planItemIdentity(
  plan: QuizCapturePlan,
  item: QuizCapturePlanItem,
  fingerprint: string,
): PlanIdentity {
  return {
    learnerKey: plan.learnerKey,
    attemptId: plan.attemptId,
    sceneId: plan.sceneId,
    originEpisodeId: plan.originEpisodeId,
    originOwner: plan.originOwner,
    questionId: item.questionId,
    eventId: item.eventId,
    planRecordToken: item.recordToken,
    frozenPayloadFingerprint: fingerprint,
  };
}

/** The attempt header identity a plan belongs to (authority scope). */
export function planHeaderIdentity(plan: QuizCapturePlan): AttemptHeaderIdentity {
  return {
    learnerKey: plan.learnerKey,
    attemptId: plan.attemptId,
    sceneId: plan.sceneId,
    originEpisodeId: plan.originEpisodeId,
    originOwner: plan.originOwner,
  };
}

/**
 * The plan's OWN expected queue instance: created bound under the frozen
 * origin owner (known A) or unbound ('' — claim-only until a legal bind).
 * Used strictly as a QUERY for real evidence — the returned side of any
 * match always carries the stored row's own metadata.
 */
export function planExpectedActual(
  plan: QuizCapturePlan,
  item: QuizCapturePlanItem,
  fingerprint: string,
): ActualIdentity {
  return {
    kind: 'modern',
    key: `${plan.originOwner}|${item.eventId}`,
    owner: plan.originOwner,
    eventId: item.eventId,
    fingerprint,
    recordToken: item.recordToken,
  };
}

/**
 * r2 §6 learner guard: resolve the CURRENT learner and require strict
 * equality with the frozen plan header. Unavailable or mismatched → the
 * caller takes an honest stale/error outcome and performs NO evidence,
 * progress, journal, or authority side effect — never a new partition.
 */
async function currentLearnerMatches(
  deps: { getLearnerKey: () => Promise<string> },
  plan: QuizCapturePlan,
): Promise<boolean> {
  try {
    return (await deps.getLearnerKey()) === plan.learnerKey;
  } catch {
    return false;
  }
}

/**
 * Fail-closed instance matching shared by every consumer (P3 §3): key (or
 * its committed boundFrom alias) + fingerprint + the token-or-createdAt
 * plane. Missing metadata on EITHER side never matches — a metadata-less
 * verdict is never a proof.
 */
export function strictInstanceMatches(
  entry: {
    key: string;
    boundFrom?: string;
    eventId?: string;
    fingerprint?: string;
    recordToken?: string | null;
    createdAt?: number;
  },
  target: {
    handle?: string;
    eventId?: string;
    fingerprint?: string;
    recordToken?: string;
    recordCreatedAt?: number;
  },
): boolean {
  if (target.handle === undefined) return false;
  if (entry.key !== target.handle && entry.boundFrom !== target.handle) return false;
  if (
    entry.eventId !== undefined &&
    target.eventId !== undefined &&
    entry.eventId !== target.eventId
  ) {
    return false; // a verdict naming another event never applies
  }
  if (entry.fingerprint === undefined || target.fingerprint === undefined) return false;
  if (entry.fingerprint !== target.fingerprint) return false;
  if (entry.recordToken !== undefined && entry.recordToken !== null) {
    // The verdict names a SPECIFIC modern instance: the token must match.
    return target.recordToken !== undefined && entry.recordToken === target.recordToken;
  }
  if (entry.recordToken === null) {
    // A token-LESS (legacy) verdict: only a legacy target with the SAME
    // createdAt matches.
    return (
      target.recordToken === undefined &&
      entry.createdAt !== undefined &&
      target.recordCreatedAt === entry.createdAt
    );
  }
  return false; // recordToken undefined → metadata ABSENT → fail closed
}

// ── Precheck (progress → durable-binding bridge → strict evidence) ─────────

/** What one plan item's durable state says before any execution. */
export type ItemPrecheck =
  | { action: 'confirmed' }
  | { action: 'conflict' }
  | { action: 'unreadable' }
  /** r2 §6: the resolved learner no longer matches the frozen plan — an
   *  honest stale outcome; NO side effect may touch either partition. */
  | { action: 'learner-stale' }
  | {
      action: 'evidence';
      /** Real queue/receipt metadata for the STRICTLY matched instance. */
      evidence:
        | { status: 'queued'; side: QueueSideIdentity }
        | { status: 'receipt'; side: QueueSideIdentity }
        | { status: 'conflict' }
        | { status: 'unreadable' };
    }
  | { action: 'enqueue' };

/** Minimal executor dependencies: the learner identity source. */
export interface ExecutorDeps {
  getLearnerKey: () => Promise<string>;
}

// ── Durable-binding recovery bridge (r2 §4: every tagged result handled) ────

export type DurableBridgeOutcome =
  | { status: 'recovered'; actual: ActualIdentity }
  | { status: 'absent' }
  /** The scope/proof contradicts this plan — an explicit conflict, never
   *  an enqueue (r2 §4). */
  | { status: 'conflict' }
  /** The migration committed but the authority repair could not — keep the
   *  durable migration and expose the retryable failure (r2 §4). */
  | { status: 'retryable'; actual: ActualIdentity }
  | { status: 'unreadable' };

/**
 * Durable-binding recovery bridge (r1 §7 + r2 §4): for an UNBOUND source
 * instance, consult the outbox's same-transaction binding journal — a
 * crash between the queue move and the progress/authority commits still
 * left the exact committed mapping. On a hit, the progress migrates along
 * the journal's full mapping and (only when the source IS this plan's own
 * instance) the attempt authority is wired with the journal's reason —
 * with the authority writer's TAGGED outcome honored. A concurrent exact
 * migration is canonically reread and accepted only when the identical
 * frozen plan now holds the exact destination. Never scans other owners
 * or bare event ids.
 */
export async function recoverDurableBinding(
  plan: QuizCapturePlan,
  item: QuizCapturePlanItem,
  source: ActualIdentity,
  fingerprint: string,
  deps: ExecutorDeps,
): Promise<DurableBridgeOutcome> {
  if (!(await currentLearnerMatches(deps, plan))) return { status: 'unreadable' };
  const outbox = await import('@/lib/mistake-book/outbox');
  const progress = await import('@/lib/mistake-book/progress');
  const identity = planItemIdentity(plan, item, fingerprint);
  const journal = await outbox.readBindingJournal({
    key: source.key,
    eventId: source.eventId,
    fingerprint: source.fingerprint,
    ...(source.kind === 'modern'
      ? { recordToken: source.recordToken }
      : { recordToken: null, recordCreatedAt: source.recordCreatedAt }),
  });
  if (journal.status === 'unreadable') return { status: 'unreadable' };
  if (journal.status === 'absent') return { status: 'absent' };
  const destination = progress.actualIdentityFromQueueSide(
    journal.binding.destination,
    item.eventId,
    source.fingerprint,
  );
  if (destination === null) return { status: 'unreadable' }; // torn journal metadata
  const migrate = await progress.writeCaptureProgress(identity, {
    kind: 'migrate-actual',
    source,
    destination,
  });
  if (migrate.kind === 'conflict-plan') return { status: 'conflict' };
  if (migrate.kind === 'unreadable') return { status: 'unreadable' };
  if (migrate.kind === 'write-failed') return { status: 'unreadable' }; // nothing committed
  if (migrate.kind === 'conflict-actual') {
    // r2 §4: a POSSIBLE concurrent exact migration — canonically reread the
    // progress with the same frozen identity and accept ONLY the identical
    // plan holding the exact destination.
    let reread;
    try {
      reread = await progress.readCaptureProgress(identity);
    } catch {
      return { status: 'unreadable' };
    }
    if (
      (reread.status === 'pending' || reread.status === 'confirmed') &&
      reread.actual !== undefined &&
      progressActualEquals(reread.actual, destination)
    ) {
      // the concurrent writer committed the exact migration
    } else {
      return { status: 'conflict' };
    }
  }
  // Authority only when the journal's source IS this plan's own instance —
  // a foreign-token record bound in this attempt's flush never proves
  // attempt ownership (P3 §2), and known-origin plans never migrate.
  if (source.kind === 'modern' && source.recordToken === item.recordToken) {
    const authority = await progress.recordAttemptOwnerAuthority(planHeaderIdentity(plan), {
      kind:
        journal.binding.reason === 'explicit-claim' ? 'explicit-claim' : 'active-operation-bind',
      sourcePlan: identity,
      source,
      destination,
    });
    // r2 §4: the authority writer's TAGGED outcome is honored — a failed or
    // refused repair keeps the durable migration and stays retryable/conflict.
    if (authority.kind === 'conflict-owner') return { status: 'conflict' };
    if (authority.kind === 'unreadable' || authority.kind === 'write-failed') {
      return { status: 'retryable', actual: destination };
    }
  }
  return { status: 'recovered', actual: destination };
}

/** Field-exact actual equality used for the concurrent-migration reread. */
function progressActualEquals(a: ActualIdentity, b: ActualIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (
    a.key !== b.key ||
    a.owner !== b.owner ||
    a.eventId !== b.eventId ||
    a.fingerprint !== b.fingerprint ||
    (a.recordToken ?? null) !== (b.recordToken ?? null)
  ) {
    return false;
  }
  if (a.kind === 'legacy' && b.kind === 'legacy') return a.recordCreatedAt === b.recordCreatedAt;
  return true;
}

/**
 * Resolve one plan item's pre-execution state (P3 §1): read the durable
 * progress with the FULL frozen identity; recover any durable binding for
 * an unbound source; then query the REAL queue/receipt evidence for the
 * adopted (or expected) instance. Every result is a distinct honest
 * branch — 'unreadable' and 'learner-stale' are never an 'enqueue'.
 */
export async function precheckItem(
  plan: QuizCapturePlan,
  item: QuizCapturePlanItem,
  deps: ExecutorDeps,
): Promise<ItemPrecheck> {
  const progress = await import('@/lib/mistake-book/progress');
  const outbox = await import('@/lib/mistake-book/outbox');
  // r2 §6: the frozen learner partition is the ONLY partition this plan may
  // touch — a mismatched/unavailable current learner is an honest stale
  // outcome before ANY side effect.
  if (!(await currentLearnerMatches(deps, plan))) return { action: 'learner-stale' };
  const fingerprint = outbox.fingerprintOf(item.payload);
  const identity = planItemIdentity(plan, item, fingerprint);
  let verdict;
  try {
    verdict = await progress.readCaptureProgress(identity);
  } catch {
    return { action: 'unreadable' }; // a failed read is never a green light
  }
  if (verdict.status === 'confirmed') return { action: 'confirmed' };
  if (verdict.status === 'conflict') return { action: 'conflict' };
  if (verdict.status === 'unreadable') return { action: 'unreadable' };
  // 'pending' (with or without an adopted actual) or 'absent': recover any
  // durable binding for an unbound source first, then query the evidence.
  let actual =
    verdict.status === 'pending' && verdict.actual !== undefined
      ? verdict.actual
      : planExpectedActual(plan, item, fingerprint);
  if (actual.owner === '') {
    const bridge = await recoverDurableBinding(plan, item, actual, fingerprint, deps);
    if (bridge.status === 'unreadable') return { action: 'unreadable' };
    if (bridge.status === 'conflict') return { action: 'conflict' };
    // 'retryable': the migration itself committed — continue with the
    // bridged actual; the pending AUTHORITY repair surfaces honestly at the
    // new-item owner resolution (resolveAttemptOwner), never as a bind.
    if ((bridge.status === 'recovered' || bridge.status === 'retryable') && bridge.actual) {
      actual = bridge.actual;
    }
  }
  const evidence = await outbox.readCaptureEvidence({
    owner: actual.owner,
    eventId: item.eventId,
    fingerprint,
    ...(actual.kind === 'modern'
      ? { recordToken: actual.recordToken }
      : { recordToken: null, recordCreatedAt: actual.recordCreatedAt }),
  });
  if (evidence.status === 'absent') return { action: 'enqueue' };
  return { action: 'evidence', evidence };
}

// ── Attempt-owner resolution (r2 §2: fresh, with committed-evidence repair) ──

export type AttemptOwnerResolution =
  | { status: 'proven'; owner: string; proof: AuthorityBindProof }
  | { status: 'absent' }
  | { status: 'conflict' }
  /** Read/repair failure — retryable, honestly blocks NEW-owner decisions. */
  | { status: 'unreadable' };

/**
 * The PROVEN attempt owner for an unknown-origin plan, resolved FRESH at
 * every NEW-item enqueue (r2 §2 — never cached across a helper that can
 * commit authority). When no authority row exists, it is REPAIRED from the
 * exact committed evidence before deciding: each item's stored
 * committedBind proof (source = this plan's own unbound instance) or, for
 * a lost/unbound progress row, the durable binding journal — reconstructing
 * the authority even when the progress already migrated or confirmed. The
 * authority writer's tagged outcome is honored: a failed repair is an
 * honest retryable 'unreadable', a refusal is 'conflict'; the frozen
 * originOwner is never rewritten.
 */
export async function resolveAttemptOwner(
  plan: QuizCapturePlan,
  deps: ExecutorDeps,
): Promise<AttemptOwnerResolution> {
  if (plan.originOwner !== '') return { status: 'absent' }; // known-origin: no authority
  const progress = await import('@/lib/mistake-book/progress');
  const outbox = await import('@/lib/mistake-book/outbox');
  let current;
  try {
    current = await progress.readAttemptOwnerAuthority(planHeaderIdentity(plan));
  } catch {
    return { status: 'unreadable' };
  }
  if (current.status === 'proven') {
    return { status: 'proven', owner: current.effectiveOwner, proof: current.proof };
  }
  if (current.status === 'unreadable') return { status: 'unreadable' };
  if (current.status === 'conflict') return { status: 'conflict' };
  // 'absent': repair from the exact committed evidence (r2 §2).
  if (!(await currentLearnerMatches(deps, plan))) return { status: 'unreadable' };
  for (const item of plan.items) {
    const fingerprint = outbox.fingerprintOf(item.payload);
    const identity = planItemIdentity(plan, item, fingerprint);
    let candidate: {
      source: ActualIdentity;
      destination: ActualIdentity;
      kind: 'active-operation-bind' | 'explicit-claim';
    } | null = null;
    let row;
    try {
      row = await progress.readCaptureProgress(identity);
    } catch {
      return { status: 'unreadable' };
    }
    if (row.status === 'unreadable') return { status: 'unreadable' };
    if (row.status === 'pending' || row.status === 'confirmed') {
      const bind = row.committedBind as CommittedBindEvidence | undefined;
      if (
        bind !== undefined &&
        bind.source.owner === '' &&
        bind.source.kind === 'modern' &&
        bind.source.recordToken === item.recordToken
      ) {
        // The stored committed-bind proof names THIS plan's own MODERN
        // instance — an original-operation bind.
        candidate = {
          source: bind.source,
          destination: bind.destination,
          kind: 'active-operation-bind',
        };
      } else if (
        bind !== undefined &&
        bind.source.owner === '' &&
        (bind.source.kind !== 'modern' || bind.source.recordToken !== item.recordToken)
      ) {
        // r3 group 4: the plan strictly ADOPTED a legacy/foreign-token
        // source (a legal same-content reuse). ONLY the user's EXPLICIT
        // CLAIM can have bound it — recover the authority from the exact
        // same-transaction journal entry whose full source instance equals
        // this committed-bind source AND whose reason is explicit-claim;
        // never recast the claim as an active bind, and never broaden
        // active-bind permissions to foreign tokens.
        const journal = await outbox.readBindingJournal({
          key: bind.source.key,
          eventId: bind.source.eventId,
          fingerprint: bind.source.fingerprint,
          ...(bind.source.kind === 'modern'
            ? { recordToken: bind.source.recordToken }
            : { recordToken: null, recordCreatedAt: bind.source.recordCreatedAt }),
        });
        if (journal.status === 'unreadable') return { status: 'unreadable' };
        if (journal.status === 'found') {
          if (journal.binding.reason !== 'explicit-claim') {
            return { status: 'conflict' }; // an active-bind proof for a foreign instance: refuse
          }
          const claimedDestination = progress.actualIdentityFromQueueSide(
            journal.binding.destination,
            item.eventId,
            bind.source.fingerprint,
          );
          if (claimedDestination === null) return { status: 'unreadable' };
          candidate = {
            source: bind.source,
            destination: claimedDestination,
            kind: 'explicit-claim',
          };
        }
      } else if (row.actual !== undefined && row.actual.owner === '') {
        const bridged = await journalCandidateFor(outbox, progress, row.actual, item);
        if (bridged.status === 'unreadable') return { status: 'unreadable' };
        candidate = bridged.candidate;
      }
    } else if (row.status === 'absent') {
      // The progress write was lost entirely: the journal for the EXPECTED
      // unbound instance is the surviving committed proof.
      const expected = planExpectedActual(plan, item, fingerprint);
      const bridged = await journalCandidateFor(outbox, progress, expected, item);
      if (bridged.status === 'unreadable') return { status: 'unreadable' };
      candidate = bridged.candidate;
    }
    // row.status === 'conflict': another plan owns this item's scope — not
    // this plan's proof; continue with the other items.
    if (candidate === null) continue;
    const write = await progress.recordAttemptOwnerAuthority(planHeaderIdentity(plan), {
      kind: candidate.kind,
      sourcePlan: identity,
      source: candidate.source,
      destination: candidate.destination,
    });
    if (write.kind === 'written') {
      return {
        status: 'proven',
        owner: candidate.destination.owner,
        proof: {
          kind: candidate.kind,
          sourcePlan: identity,
          source: candidate.source,
          destination: candidate.destination,
        },
      };
    }
    if (write.kind === 'conflict-owner') return { status: 'conflict' };
    return { status: 'unreadable' }; // write-failed / unreadable: retryable
  }
  return { status: 'absent' };
}

/** Journal-backed authority candidate for one unbound source instance. */
async function journalCandidateFor(
  outbox: typeof import('@/lib/mistake-book/outbox'),
  progress: typeof import('@/lib/mistake-book/progress'),
  source: ActualIdentity,
  item: QuizCapturePlanItem,
): Promise<{
  candidate: null | {
    source: ActualIdentity;
    destination: ActualIdentity;
    kind: 'active-operation-bind' | 'explicit-claim';
  };
  status: 'ok' | 'unreadable';
}> {
  const journal = await outbox.readBindingJournal({
    key: source.key,
    eventId: source.eventId,
    fingerprint: source.fingerprint,
    ...(source.kind === 'modern'
      ? { recordToken: source.recordToken }
      : { recordToken: null, recordCreatedAt: source.recordCreatedAt }),
  });
  if (journal.status === 'unreadable') return { candidate: null, status: 'unreadable' };
  if (journal.status === 'absent') return { candidate: null, status: 'ok' };
  // r3 group 4: kind follows the JOURNAL's exact reason AND the source's
  // relationship to the plan. The plan's OWN modern instance may bind as an
  // active operation OR be claimed (both legal for it); a legacy/foreign
  // token source is ONLY provable by an explicit claim — an active-bind
  // journal reason for it proves nothing for this plan's authority.
  const isOwnModernInstance = source.kind === 'modern' && source.recordToken === item.recordToken;
  if (!isOwnModernInstance && journal.binding.reason !== 'explicit-claim') {
    return { candidate: null, status: 'ok' }; // no admissible proof
  }
  const destination = progress.actualIdentityFromQueueSide(
    journal.binding.destination,
    item.eventId,
    source.fingerprint,
  );
  if (destination === null) return { candidate: null, status: 'unreadable' };
  return {
    candidate: {
      source,
      destination,
      kind:
        journal.binding.reason === 'explicit-claim' ? 'explicit-claim' : 'active-operation-bind',
    },
    status: 'ok',
  };
}

/**
 * The RAW persisted authority read (kept for callers that only observe).
 * Owner DECISIONS must use {@link resolveAttemptOwner}.
 */
export type AuthorityResolution =
  | { status: 'absent' }
  | { status: 'proven'; owner: string; proof: AuthorityBindProof }
  | { status: 'unreadable' }
  | { status: 'conflict' };

export async function authoritativeOwnerFor(plan: QuizCapturePlan): Promise<AuthorityResolution> {
  const progress = await import('@/lib/mistake-book/progress');
  try {
    const verdict = await progress.readAttemptOwnerAuthority(planHeaderIdentity(plan));
    if (verdict.status === 'proven') {
      return { status: 'proven', owner: verdict.effectiveOwner, proof: verdict.proof };
    }
    if (verdict.status === 'unreadable') return { status: 'unreadable' };
    if (verdict.status === 'conflict') return { status: 'conflict' };
    return { status: 'absent' };
  } catch {
    return { status: 'unreadable' };
  }
}

/** Durable pending-progress note for one enqueued item (honest, awaited). */
export async function noteEnqueuedActual(
  plan: QuizCapturePlan,
  item: QuizCapturePlanItem,
  fingerprint: string,
  outcome:
    | {
        kind: 'persisted';
        eventId: string;
        handle: string;
        fingerprint: string;
        creationToken: string;
      }
    | {
        kind: 'reused';
        eventId: string;
        handle: string;
        fingerprint: string;
        recordToken?: string;
        recordCreatedAt?: number;
      }
    | { kind: 'conflict'; eventId: string }
    | { kind: 'local-failed' },
  deps: ExecutorDeps,
  authority?: AuthorityBindProof,
): Promise<boolean> {
  const progress = await import('@/lib/mistake-book/progress');
  const { actualIdentityFromQueueSide } = progress;
  if (outcome.kind !== 'persisted' && outcome.kind !== 'reused') return false;
  // r2 §6: a mismatched current learner writes NOTHING — never the other
  // partition, never this one under a wrong identity.
  if (!(await currentLearnerMatches(deps, plan))) return false;
  let actual: ActualIdentity;
  if (outcome.kind === 'persisted') {
    // Our OWN freshly created record: the plan token under the enqueue
    // owner (the frozen owner, or the PROVEN attempt owner for later
    // items of an unknown-origin attempt — supplied via `authority`).
    const owner =
      authority !== undefined && plan.originOwner === ''
        ? authority.destination.owner
        : plan.originOwner;
    actual = {
      kind: 'modern',
      key: outcome.handle,
      owner,
      eventId: item.eventId,
      fingerprint,
      recordToken: outcome.creationToken,
    };
  } else {
    const reused = actualIdentityFromQueueSide(
      {
        key: outcome.handle,
        eventId: outcome.eventId,
        fingerprint: outcome.fingerprint,
        recordToken: outcome.recordToken,
        createdAt: outcome.recordCreatedAt,
      },
      item.eventId,
      fingerprint,
    );
    if (reused === null) return false; // insufficient real identity — stays pending
    actual = reused;
  }
  const basis =
    authority !== undefined && plan.originOwner === '' && actual.owner !== ''
      ? 'attempt-authority'
      : outcome.kind === 'persisted'
        ? 'enqueue-persisted'
        : 'enqueue-reused';
  const result = await progress.writeCaptureProgress(planItemIdentity(plan, item, fingerprint), {
    kind: 'note-actual',
    actual,
    basis,
    ...(basis === 'attempt-authority' ? { authority } : {}),
  });
  return result.kind === 'written';
}

/**
 * Durable upload/receipt confirmation for one plan item (P3 §3): the ledger
 * may claim 'uploaded' ONLY after this returns true — a failed confirm
 * keeps the item recoverable.
 */
export async function confirmItemActual(
  plan: QuizCapturePlan,
  item: QuizCapturePlanItem,
  actual: ActualIdentity,
  basis: 'upload' | 'receipt',
  deps: ExecutorDeps,
): Promise<boolean> {
  const progress = await import('@/lib/mistake-book/progress');
  const outbox = await import('@/lib/mistake-book/outbox');
  // r2 §6: never confirm under a mismatched current learner.
  if (!(await currentLearnerMatches(deps, plan))) return false;
  const result = await progress.writeCaptureProgress(
    planItemIdentity(plan, item, outbox.fingerprintOf(item.payload)),
    { kind: 'confirm', actual, basis },
  );
  return result.kind === 'written';
}

export interface ConsumeReportDeps extends ExecutorDeps {
  /** Mount + attempt guard — checked before AND after EVERY await. */
  stillCurrent: () => boolean;
  /** The item's current ledger target (opSeq + FULL identity snapshot). */
  getTarget: (questionId: string) => PlanLedgerTarget | undefined;
  /**
   * Apply a ledger patch — only called with the patch's opSeq equal to the
   * target's CURRENT opSeq (the consumer re-checks before applying). The
   * patch states are the consumer's legal verdict states only.
   */
  patchLedger: (
    questionId: string,
    patch: Partial<Omit<PlanLedgerTarget, 'state'>> & {
      state?: 'uploaded' | 'queued' | 'parked' | 'unbound' | 'conflict';
      opSeq?: number;
    },
  ) => void;
}

/**
 * Consume one flush report for a plan (P3 §3 + r1 §3), in the mandated
 * order: committed mappings first (checking the REAL migrate result and
 * the legal adoption source — a conflicting plan's mapping is never a new
 * success), then upload/refusal verdicts, then parked/unbound, and finally
 * strict receipt replay with the rows' own identity. Ledger 'uploaded'
 * claims land only AFTER the progress confirm committed; a failed confirm
 * keeps the prior (recoverable) state. Legacy destinations clear the old
 * token and record the target's REAL date. Returns false when a guard
 * (mount/attempt or the frozen-learner check) aborted the consumption.
 */
export async function consumeReportForPlan(
  plan: QuizCapturePlan,
  report: FlushReport,
  deps: ConsumeReportDeps,
): Promise<boolean> {
  const progress = await import('@/lib/mistake-book/progress');
  const outbox = await import('@/lib/mistake-book/outbox');
  const fingerprintOf = outbox.fingerprintOf;
  const { actualIdentityFromQueueSide } = progress;
  if (!(await currentLearnerMatches(deps, plan))) return false;
  if (!deps.stillCurrent()) return false;

  // 1. COMMITTED BIND MAPPINGS FIRST — strict full sides only.
  for (const mapping of report.committedBinds) {
    for (const item of plan.items) {
      const fingerprint = fingerprintOf(item.payload);
      const source = actualIdentityFromQueueSide(mapping.source, item.eventId, fingerprint);
      const destination = actualIdentityFromQueueSide(
        mapping.destination,
        item.eventId,
        fingerprint,
      );
      if (source === null || destination === null) continue; // not this item's event/content
      const identity = planItemIdentity(plan, item, fingerprint);
      if (!deps.stillCurrent()) return false; // verify BEFORE the durable write
      const migrate = await progress.writeCaptureProgress(identity, {
        kind: 'migrate-actual',
        source,
        destination,
      });
      if (!deps.stillCurrent()) return false;
      if (migrate.kind === 'written') {
        // The attempt authority follows ONLY the plan's own instance (its
        // modern plan-token source); a foreign-token source bound in this
        // flush never proves attempt ownership.
        if (
          source.owner === '' &&
          source.kind === 'modern' &&
          source.recordToken === item.recordToken
        ) {
          try {
            await progress.recordAttemptOwnerAuthority(planHeaderIdentity(plan), {
              kind: 'active-operation-bind',
              sourcePlan: identity,
              source,
              destination,
            });
          } catch {
            /* retried on the next pass — the migration is already durable */
          }
          if (!deps.stillCurrent()) return false;
        }
        // Migrate the ledger's tracked identity along the SAME mapping:
        // a legacy destination CLEARS the old token and keeps its real date.
        const snapshot = deps.getTarget(item.questionId);
        if (snapshot !== undefined && strictInstanceMatches(mapping.source, snapshot)) {
          deps.patchLedger(item.questionId, {
            opSeq: snapshot.opSeq,
            state: 'queued',
            handle: mapping.destination.key,
            ...(mapping.destination.recordToken != null
              ? { recordToken: mapping.destination.recordToken, recordCreatedAt: undefined }
              : {
                  recordToken: undefined,
                  ...(mapping.destination.createdAt !== undefined
                    ? { recordCreatedAt: mapping.destination.createdAt }
                    : {}),
                }),
          });
        }
      }
      // migrate.kind !== 'written' (conflict/unreadable/write-failed): the
      // progress did NOT advance — an honest, non-success outcome; the
      // ledger keeps its prior identity (no borrowed mapping).
    }
  }

  // 2. PER-PASS VERDICTS — uploads and refusals before anything softer.
  for (const item of plan.items) {
    if (!deps.stillCurrent()) return false;
    const snapshot = deps.getTarget(item.questionId);
    if (!snapshot || snapshot.state === 'uploaded' || snapshot.state === 'local-failed') {
      continue;
    }
    const fingerprint = fingerprintOf(item.payload);
    const uploaded = report.uploaded.find((entry) => strictInstanceMatches(entry, snapshot));
    if (uploaded !== undefined) {
      const actual = actualIdentityFromQueueSide(uploaded, item.eventId, fingerprint);
      if (actual === null) continue; // verdict lacks a full instance identity
      // Progress confirm FIRST; only a committed confirm promotes the
      // ledger (a failed write keeps the recoverable prior state).
      if (!deps.stillCurrent()) return false;
      const confirmed = await confirmItemActual(plan, item, actual, 'upload', deps);
      if (!deps.stillCurrent()) return false;
      if (confirmed) {
        const current = deps.getTarget(item.questionId);
        if (current === undefined || current.opSeq !== snapshot.opSeq) continue; // superseded
        deps.patchLedger(item.questionId, {
          opSeq: snapshot.opSeq,
          state: 'uploaded',
          handle: uploaded.key,
          ...(uploaded.recordToken != null
            ? { recordToken: uploaded.recordToken, recordCreatedAt: undefined }
            : {}),
        });
      }
      continue;
    }
    const refused =
      report.rejected.find((entry) => strictInstanceMatches(entry, snapshot)) ??
      report.conflicts.find((entry) => strictInstanceMatches(entry, snapshot));
    if (refused !== undefined && snapshot.state !== 'conflict') {
      deps.patchLedger(item.questionId, { opSeq: snapshot.opSeq, state: 'conflict' });
      continue;
    }
    const parked = report.parked.find((entry) => strictInstanceMatches(entry, snapshot));
    if (parked !== undefined && snapshot.state !== 'conflict') {
      deps.patchLedger(item.questionId, {
        opSeq: snapshot.opSeq,
        state: 'parked',
        handle: parked.key,
      });
      continue;
    }
    const unbound = report.unbound.find((entry) => strictInstanceMatches(entry, snapshot));
    if (unbound !== undefined && snapshot.state !== 'conflict') {
      deps.patchLedger(item.questionId, {
        opSeq: snapshot.opSeq,
        state: 'unbound',
        handle: unbound.key,
      });
      continue;
    }
    if (report.failed.some((entry) => strictInstanceMatches(entry, snapshot))) {
      continue; // transient 5xx: the queue owns the retry — stays queued
    }
  }

  // 3. STRICT RECEIPT REPLAY LAST — only still-queued items with a full
  // tracked identity; parked/unbound/conflicted keep their current facts.
  const receiptCandidates = plan.items.filter((item_) => {
    const target = deps.getTarget(item_.questionId);
    return (
      target !== undefined &&
      target.state === 'queued' &&
      target.handle !== undefined &&
      target.fingerprint !== undefined
    );
  });
  if (receiptCandidates.length > 0) {
    const result = await outbox.readReceipts(
      receiptCandidates.map((item_) => {
        const target = deps.getTarget(item_.questionId)!;
        return {
          key: target.handle!,
          fingerprint: target.fingerprint!,
          recordToken: target.recordToken ?? null,
          ...(target.recordCreatedAt !== undefined ? { createdAt: target.recordCreatedAt } : {}),
        };
      }),
    );
    if (!deps.stillCurrent()) return false;
    if (result.ok) {
      for (const item of receiptCandidates) {
        const snapshot = deps.getTarget(item.questionId);
        if (
          snapshot === undefined ||
          snapshot.state !== 'queued' ||
          snapshot.handle === undefined
        ) {
          continue; // decided or superseded since the query
        }
        const row = result.matched.find((side) => side.key === snapshot.handle);
        if (row === undefined) continue;
        const fingerprint = fingerprintOf(item.payload);
        const actual = actualIdentityFromQueueSide(row, item.eventId, fingerprint);
        if (actual === null) continue; // row metadata incomplete — no claim
        if (!deps.stillCurrent()) return false;
        const confirmed = await confirmItemActual(plan, item, actual, 'receipt', deps);
        if (!deps.stillCurrent()) return false;
        if (confirmed) {
          const current = deps.getTarget(item.questionId);
          if (current === undefined || current.opSeq !== snapshot.opSeq) continue;
          deps.patchLedger(item.questionId, {
            opSeq: snapshot.opSeq,
            state: 'uploaded',
            handle: row.key,
          });
        }
      }
    }
    // ok === false: unreadable receipts prove nothing — items stay queued.
  }
  return true;
}
