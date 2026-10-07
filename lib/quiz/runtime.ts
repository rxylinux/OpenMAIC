import type {
  QuizAttemptPhase,
  QuizAttemptSkeleton,
  RuntimeRecord,
  RuntimeSession,
} from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { MistakeCapturePayload } from '@/lib/mistake-book/client';
import { questionEventId } from '@/lib/mistake-book/client';
import {
  clearDraftRecovery,
  clearLegacyQuizStateSnapshot,
  readLegacyQuizStateSnapshot,
  type QuizAnswers,
} from '@/lib/quiz/persistence';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

/**
 * One frozen per-question capture plan entry (Codex intent-design v1):
 * everything needed to execute/recover THIS question's capture on its
 * ORIGINAL identity — never rebuilt, never re-owned. `originOwner` is the
 * owner fact at plan-build time ('' = explicitly unknown → claim-only).
 */
export interface QuizCapturePlanItem {
  questionId: string;
  eventId: string;
  /** The COMPLETE frozen per-question capture payload. */
  payload: MistakeCapturePayload;
  /** Creation identity minted ONCE at plan build; never re-minted. */
  recordToken: string;
}

/**
 * The attempt-scoped capture plan (design §1): a HEADER frozen on the
 * attempt's FIRST new-pipeline review (even with zero wrong items) plus
 * per-question items merged only as NEW decided-wrong results arrive. The
 * header's originOwner governs every later item of the SAME attempt — a
 * cookie/cache switch to B can never claim the old attempt's new wrongs.
 */
export interface QuizCapturePlan {
  planVersion: 1;
  /** Owner fact at first plan build ('' = explicitly unknown → claim-only). */
  originOwner: string;
  /** The episode (attempt) the plan was born in — never changes on merge. */
  originEpisodeId: string;
  attemptId: string;
  sceneId: string;
  learnerKey: string;
  /**
   * Historical-exemption baseline (P3 §4): question ids that were ALREADY
   * decided wrong in this attempt's real no-plan (legacy) reviews — frozen
   * when the first modern plan upgrades the attempt and carried immutably
   * on every merge. They never enter `items` (their historical zero-re-
   * capture fact stays durable through modern reloads and further
   * regrading); a genuinely NEW attempt builds a fresh header without them.
   */
  legacyExemptQuestions?: string[];
  items: QuizCapturePlanItem[];
}

export interface QuizAttemptPayload extends QuizAttemptSkeleton {
  payloadVersion: 1;
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
  /**
   * Frozen capture plan persisted WITH this review (Codex intent-design):
   * present ONLY on reviews written by the new pipeline — legacy reviews
   * carry no plan and keep their historical zero-re-capture semantics.
   */
  capturePlan?: QuizCapturePlan;
}

export interface QuizAttemptRecordInput {
  stageId: string;
  sceneId: string;
  attemptId: string;
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
  /** Forwarded verbatim to the stored payload (Codex intent-design §1). */
  capturePlan?: QuizCapturePlan;
  /** Begin a distinct retry even when the prior attempt has the same payload. */
  startNewAttempt?: boolean;
}

export interface LegacyQuizAttemptInput {
  stageId: string;
  sceneId: string;
  attemptId: string;
  draftAnswers?: QuizAnswers;
  submittedAnswers?: QuizAnswers;
  results?: QuestionResult[];
}

export interface QuizAttemptRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
}

export class QuizRetryProgressedError extends Error {
  constructor(sessionId: string) {
    super(`Quiz retry ${JSON.stringify(sessionId)} already progressed in another tab`);
    this.name = 'QuizRetryProgressedError';
  }
}

export interface QuizAttemptState {
  sessionId: string;
  status: RuntimeSession['status'];
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
  /** See QuizAttemptPayload.capturePlan (absent on legacy reviews). */
  capturePlan?: QuizCapturePlan;
}

export interface LoadedQuizAttemptState {
  /** Learner-scoped deterministic root id used by every new write/retry. */
  attemptId: string;
  state?: QuizAttemptState;
}

export interface QuizAttemptStateInput {
  stageId: string;
  sceneId: string;
}

export type QuizDraftInput = Omit<QuizAttemptRecordInput, 'phase' | 'results'>;

export interface QuizAttemptWriter {
  scheduleDraft(input: QuizDraftInput): void;
  flushDraft(): Promise<QuizAttemptWriteOutcome | void>;
  recordPhase(input: QuizAttemptRecordInput): Promise<QuizAttemptWriteOutcome>;
  cancelDraft(): void;
}

export interface QuizAttemptWriterOptions {
  debounceMs?: number;
  write?: (input: QuizAttemptRecordInput) => Promise<QuizAttemptWriteOutcome>;
  onError?: (error: unknown) => void;
}

const PHASE_ORDER: Record<QuizAttemptPhase, number> = {
  draft: 0,
  submitted: 1,
  reviewed: 2,
};

const queues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();
const writerTails = new Map<string, Set<Promise<void>>>();

async function awaitQueuedWriterLineage(attemptId: string): Promise<void> {
  let queueKey = attemptId;
  while (true) {
    while (true) {
      const pending = writerTails.get(queueKey);
      if (!pending?.size) break;
      await Promise.all(pending);
    }
    const parent = queueKey.replace(/:retry:\d+$/, '');
    if (parent === queueKey) return;
    queueKey = parent;
  }
}

async function awaitQueuedAttemptLineage(store: RuntimeStore, attemptId: string): Promise<void> {
  let queueKey = attemptId;
  while (true) {
    const queued = queues.get(store)?.get(queueKey);
    if (queued) await queued;
    const parent = queueKey.replace(/:retry:\d+$/, '');
    if (parent === queueKey) return;
    queueKey = parent;
  }
}

/**
 * Coalesce draft snapshots and serialize every phase through one local chain.
 * `recordPhase` synchronously queues a pending draft first, so submitted and
 * reviewed can never overtake the latest answers even though UI callers remain
 * fire-and-forget.
 */
export function createQuizAttemptWriter(options: QuizAttemptWriterOptions = {}): QuizAttemptWriter {
  const debounceMs = options.debounceMs ?? 500;
  const write =
    options.write ??
    (async (input) => {
      const outcome = await recordQuizAttempt(input);
      clearDraftRecovery(input.sceneId, input.attemptId, input.answers);
      return outcome;
    });
  const onError = options.onError ?? (() => {});
  let pendingDraft: QuizDraftInput | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const run = (input: QuizAttemptRecordInput): Promise<QuizAttemptWriteOutcome> => {
    const operation = tail.then(() => write(input));
    void operation.catch(onError);
    const settled: Promise<void> = operation.then(
      () => undefined,
      () => undefined,
    );
    tail = settled;
    let attemptTails = writerTails.get(input.attemptId);
    if (!attemptTails) {
      attemptTails = new Set();
      writerTails.set(input.attemptId, attemptTails);
    }
    attemptTails.add(settled);
    void settled.finally(() => {
      attemptTails.delete(settled);
      if (attemptTails.size === 0 && writerTails.get(input.attemptId) === attemptTails) {
        writerTails.delete(input.attemptId);
      }
    });
    return operation;
  };

  const flushDraft = (): Promise<QuizAttemptWriteOutcome | void> => {
    clearTimer();
    if (!pendingDraft) return tail;
    const input = pendingDraft;
    pendingDraft = undefined;
    return run({ ...input, phase: 'draft' });
  };

  return {
    scheduleDraft(input) {
      pendingDraft = input;
      clearTimer();
      timer = setTimeout(() => {
        void flushDraft();
      }, debounceMs);
    },
    flushDraft,
    recordPhase(input) {
      void flushDraft();
      return run(input);
    },
    cancelDraft() {
      clearTimer();
      pendingDraft = undefined;
    },
  };
}

function enqueue<T>(store: RuntimeStore, attemptId: string, work: () => Promise<T>): Promise<T> {
  let storeQueues = queues.get(store);
  if (!storeQueues) {
    storeQueues = new Map();
    queues.set(store, storeQueues);
  }
  const prior = storeQueues.get(attemptId) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  storeQueues.set(attemptId, settled);
  void settled.finally(() => {
    if (storeQueues.get(attemptId) === settled) storeQueues.delete(attemptId);
  });
  return current;
}

async function withAttemptLock<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`maic:quiz-attempt:${attemptId}`, work);
  }
  return work();
}

function mintId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `quiz-record:${suffix}`;
}

function asQuizPayload(record: RuntimeRecord | undefined): QuizAttemptPayload | undefined {
  if (!record || typeof record.payload !== 'object' || record.payload === null) return undefined;
  const payload = record.payload as Partial<QuizAttemptPayload>;
  if (
    payload.payloadVersion !== 1 ||
    (payload.phase !== 'draft' && payload.phase !== 'submitted' && payload.phase !== 'reviewed') ||
    typeof payload.answers !== 'object' ||
    payload.answers === null ||
    Array.isArray(payload.answers)
  ) {
    return undefined;
  }
  return payload as QuizAttemptPayload;
}

/**
 * P1 (sequential-repair): validate a stored capturePlan. A plan field that
 * is PRESENT but structurally wrong or identity-inconsistent is a LOUD error
 * — never silently treated as legacy (only a genuinely ABSENT field is
 * legacy). Returns an error string on corruption, undefined when absent,
 * and null when the plan is valid.
 */
function validateCapturePlan(
  plan: unknown,
  expected: {
    attemptId: string;
    sceneId: string;
    learnerKey: string;
    stageId: string;
  },
): string | undefined | null {
  if (plan === undefined) return undefined; // legacy review — no plan field
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return 'capturePlan present but not an object';
  }
  const header = plan as Partial<QuizCapturePlan>;
  if (
    header.planVersion !== 1 ||
    typeof header.originOwner !== 'string' ||
    typeof header.originEpisodeId !== 'string' ||
    typeof header.attemptId !== 'string' ||
    typeof header.sceneId !== 'string' ||
    typeof header.learnerKey !== 'string' ||
    !Array.isArray(header.items)
  ) {
    return 'capturePlan header missing or malformed (planVersion/owner/episode/attempt/scene/learner/items)';
  }
  if (header.attemptId !== expected.attemptId || header.sceneId !== expected.sceneId) {
    return 'capturePlan header attempt/scene does not match this attempt';
  }
  if (header.learnerKey !== expected.learnerKey) {
    return 'capturePlan header learner does not match this learner partition';
  }
  if (header.legacyExemptQuestions !== undefined) {
    // P3 §4: the exemption baseline is an immutable set of non-empty ids —
    // duplicates or a non-array make the whole plan corrupt (loud, never
    // silently ignored: a malformed baseline could silently re-capture or
    // silently exempt the wrong questions).
    if (
      !Array.isArray(header.legacyExemptQuestions) ||
      header.legacyExemptQuestions.some((id) => typeof id !== 'string' || id === '') ||
      new Set(header.legacyExemptQuestions).size !== header.legacyExemptQuestions.length
    ) {
      return 'capturePlan legacyExemptQuestions malformed (unique non-empty strings)';
    }
  }
  for (const item of header.items as Array<Partial<QuizCapturePlanItem>>) {
    if (
      typeof item.questionId !== 'string' ||
      typeof item.eventId !== 'string' ||
      typeof item.recordToken !== 'string' ||
      item.recordToken === '' ||
      typeof item.payload !== 'object' ||
      item.payload === null
    ) {
      return 'capturePlan item malformed (questionId/eventId/non-empty recordToken/payload)';
    }
    if (item.eventId !== planItemEventId(header.attemptId, item.questionId ?? '')) {
      return 'capturePlan item eventId does not belong to this attempt/question';
    }
    const payload = item.payload as Partial<{
      stageId: unknown;
      sceneId: unknown;
      eventId: unknown;
      items: unknown;
    }>;
    if (payload.stageId !== expected.stageId) {
      return 'capturePlan item payload stageId does not match this stage';
    }
    if (
      payload.sceneId !== header.sceneId ||
      payload.eventId !== item.eventId ||
      !Array.isArray(payload.items)
    ) {
      return 'capturePlan item payload is not a frozen per-question capture snapshot';
    }
    // EXACTLY ONE inner item — it IS this question's event, never a batch.
    const inner = payload.items as Array<Partial<{ questionId: unknown; eventId: unknown }>>;
    if (
      inner.length !== 1 ||
      inner[0]?.questionId !== item.questionId ||
      inner[0]?.eventId !== item.eventId
    ) {
      return 'capturePlan item payload must freeze exactly this question/event';
    }
  }
  return null; // valid
}

/**
 * The canonical per-question event id (P1 review): the SAME encoding the
 * mistake-book client mints — the JSON tuple when it fits the 200-char
 * budget, otherwise `ev:` + SHA-256 of the tuple. Plans and captures must
 * agree bit-for-bit or long ids would diverge across a refresh.
 */
function planItemEventId(attemptId: string, questionId: string): string {
  return questionEventId(attemptId, questionId);
}

/**
 * Historical-exemption baseline for an attempt's first MODERN plan (P3 §4):
 * when the attempt has NO plan yet (a real legacy review), every question
 * ALREADY decided wrong in that historical review is exempt — its zero-re-
 * capture fact must survive the modern upgrade. Once a plan exists, its own
 * frozen baseline carries forward immutably. Only pre-existing DECIDED-wrong
 * results count: a modern not-yet-enqueued wrong is never marked historical.
 */
export function legacyExemptQuestionIds(
  prevPlan: QuizCapturePlan | null | undefined,
  priorResults: ReadonlyArray<QuestionResult>,
): string[] {
  if (prevPlan) return prevPlan.legacyExemptQuestions ?? [];
  return priorResults
    .filter((result) => result.correct === false && result.status === 'incorrect')
    .map((result) => result.questionId);
}

function attemptIdSegment(value: string): string {
  return encodeURIComponent(value);
}

export function quizAttemptId(stageId: string, sceneId: string, learnerKey: string): string {
  return [
    'quiz-attempt',
    attemptIdSegment(stageId),
    attemptIdSegment(sceneId),
    attemptIdSegment(learnerKey),
  ].join(':');
}

async function readLatestQuizAttemptState(
  input: QuizAttemptStateInput,
  store: RuntimeStore,
  learnerKey: string,
): Promise<QuizAttemptState | undefined> {
  const sessions = await store.listSessions(input.stageId, learnerKey);
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (session.kind !== 'quizAttempt') continue;
    const records = await store.listRecords(session.id, { sceneId: input.sceneId });
    const payload = asQuizPayload(records.at(-1));
    if (!payload) continue;
    // P1: a present-but-corrupt plan is an ERROR (honest gate), only a truly
    // absent plan keeps legacy semantics.
    const planError = validateCapturePlan((payload as { capturePlan?: unknown }).capturePlan, {
      attemptId: session.id,
      sceneId: input.sceneId,
      learnerKey,
      stageId: input.stageId,
    });
    if (typeof planError === 'string') {
      throw new Error(`quiz attempt ${JSON.stringify(session.id)}: ${planError}`);
    }
    return {
      sessionId: session.id,
      status: session.status,
      phase: payload.phase,
      answers: payload.answers,
      ...(payload.phase === 'reviewed'
        ? { results: Array.isArray(payload.results) ? payload.results : [] }
        : {}),
      ...(payload.capturePlan !== undefined ? { capturePlan: payload.capturePlan } : {}),
    };
  }
  return undefined;
}

async function migrateLegacyQuizState(
  input: QuizAttemptStateInput,
  store: RuntimeStore,
  learnerKey: string,
  deps: QuizAttemptRuntimeDeps,
): Promise<void> {
  const legacySnapshot = readLegacyQuizStateSnapshot(input.sceneId);
  if (!legacySnapshot.hasState) return;

  const existing = await readLatestQuizAttemptState(input, store, learnerKey);
  const { submitted, draft, attemptId: legacyAttemptId } = legacySnapshot;
  const legacyPhase: QuizAttemptPhase | undefined =
    submitted?.kind === 'reviewing'
      ? 'reviewed'
      : submitted?.kind === 'answering'
        ? 'submitted'
        : draft
          ? 'draft'
          : undefined;
  const legacyPointsToNewAttempt =
    legacyAttemptId !== null &&
    (!existing ||
      (existing.sessionId !== legacyAttemptId &&
        !existing.sessionId.startsWith(`${legacyAttemptId}:retry:`)));
  const legacyPayloadMatchesExisting =
    existing !== undefined &&
    legacyPhase === existing.phase &&
    (legacyPhase === 'reviewed' && submitted?.kind === 'reviewing'
      ? sameAnswers(submitted.answers, existing.answers) &&
        JSON.stringify(submitted.results) === JSON.stringify(existing.results ?? [])
      : legacyPhase === 'submitted' && submitted?.kind === 'answering'
        ? sameAnswers(submitted.answers, existing.answers)
        : legacyPhase === 'draft' && draft !== null
          ? sameAnswers(draft, existing.answers)
          : false);
  const shouldMigrate =
    legacyPointsToNewAttempt ||
    (legacyPhase !== undefined &&
      (!existing ||
        PHASE_ORDER[legacyPhase] > PHASE_ORDER[existing.phase] ||
        (PHASE_ORDER[legacyPhase] === PHASE_ORDER[existing.phase] &&
          !legacyPayloadMatchesExisting)));

  if (shouldMigrate) {
    const attemptId =
      (legacyPointsToNewAttempt ? legacyAttemptId : existing?.sessionId) ??
      quizAttemptId(input.stageId, input.sceneId, learnerKey);
    if (submitted?.kind === 'reviewing') {
      await backfillQuizAttempt(
        {
          ...input,
          attemptId,
          submittedAnswers: submitted.answers,
          results: submitted.results,
        },
        { ...deps, store, learnerKey },
      );
    } else if (submitted?.kind === 'answering') {
      await backfillQuizAttempt(
        { ...input, attemptId, submittedAnswers: submitted.answers },
        { ...deps, store, learnerKey },
      );
    } else if (draft) {
      await backfillQuizAttempt(
        { ...input, attemptId, draftAnswers: draft },
        { ...deps, store, learnerKey },
      );
    } else if (legacyPointsToNewAttempt) {
      await recordQuizAttempt(
        { ...input, attemptId, phase: 'draft', answers: {} },
        { ...deps, store, learnerKey },
      );
    }
  }

  // Legacy state is deleted only after every required runtime write succeeds.
  // Delete only the values this migration read; a newer recovery journal may
  // have arrived while its RuntimeStore writes were in flight.
  clearLegacyQuizStateSnapshot(input.sceneId, legacySnapshot);
}

/** Load the learner's latest quiz state, migrating legacy localStorage once. */
export async function loadQuizAttemptState(
  input: QuizAttemptStateInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<LoadedQuizAttemptState> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const attemptId = quizAttemptId(input.stageId, input.sceneId, learnerKey);
  // A UI transition can expose the next consumer while its fire-and-forget
  // writer is still queued. Wait for both its private phase tail and the
  // RuntimeStore queue before opening a read.
  await awaitQueuedWriterLineage(attemptId);
  await awaitQueuedAttemptLineage(store, attemptId);
  await migrateLegacyQuizState(input, store, learnerKey, deps);
  let state = await withAttemptLock(attemptId, () =>
    readLatestQuizAttemptState(input, store, learnerKey),
  );
  if (state && state.sessionId !== attemptId) {
    // A shadow-written or rolled-over attempt can queue its next write under
    // this non-root session id, even after the session itself is completed.
    // Drain that lineage before choosing the authoritative latest attempt.
    await awaitQueuedWriterLineage(state.sessionId);
    await awaitQueuedAttemptLineage(store, state.sessionId);
    state = await withAttemptLock(rootAttemptId(state.sessionId), () =>
      readLatestQuizAttemptState(input, store, learnerKey),
    );
  }

  // Legacy completed-but-undecided repair (closing gate #5): a historical
  // client completed a session whose latest review still holds an UNDECIDED
  // verdict (correct:null / status 'ungraded'). Left as-is, a re-grade would
  // ROLL OVER into a new attempt instead of appending the recovery to the
  // original. Under the attempt lock: re-read the tail; only when it still
  // proves the wrong completion (completed + undecided review tail) does the
  // tail-CAS reactivate it. Concurrent tail changes re-read and re-verify;
  // decided reviews and results-less historical completions are untouched,
  // and no session or event id is ever created here.
  if (state?.phase === 'reviewed' && state.status === 'completed') {
    const undecidedState: QuizAttemptState | undefined = state;
    const hasUndecided = (undecidedState.results ?? []).some(isExplicitlyUndecidedResult);
    if (hasUndecided && undecidedState.results !== undefined) {
      await withAttemptLock(rootAttemptId(undecidedState.sessionId), async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // AUTHORITATIVE re-read inside the lock (repair review): if a real
          // retry already exists for this learner/scene, the latest session
          // is no longer our legacy root — never reopen the old one.
          const authoritative = await readLatestQuizAttemptState(input, store, learnerKey);
          if (
            !authoritative ||
            authoritative.sessionId !== undecidedState.sessionId ||
            authoritative.phase !== 'reviewed' ||
            authoritative.status !== 'completed'
          ) {
            state = authoritative ?? undefined;
            return;
          }
          const session = await store.getSession(authoritative.sessionId);
          if (!session || session.status !== 'completed') return;
          // Partition/kind/scene re-verification on the session itself.
          assertPartition(session, input.stageId, learnerKey);
          if (session.kind !== 'quizAttempt') {
            state = (await readLatestQuizAttemptState(input, store, learnerKey)) ?? undefined;
            return;
          }
          const records = await store.listRecords(session.id, { sceneId: input.sceneId });
          const tail = records.at(-1);
          const tailPayload = asQuizPayload(tail);
          if (
            !tail ||
            (tail.sceneId !== undefined && tail.sceneId !== input.sceneId) ||
            !tailPayload ||
            tailPayload.phase !== 'reviewed' ||
            !Array.isArray(tailPayload.results) ||
            !tailPayload.results.some(isExplicitlyUndecidedResult)
          ) {
            // Bail: tail changed or the completion is legitimate — the
            // caller gets the CANONICAL current state, not the stale snapshot.
            state = (await readLatestQuizAttemptState(input, store, learnerKey)) ?? undefined;
            return;
          }
          // ATOMIC lineage guard (P4 final review + supplement): when the
          // store provides setSessionStatusIfLatest, the "is this root still
          // the latest RELEVANT attempt of this scene" precondition is
          // validated INSIDE the status-write transaction (browser IDB /
          // PostgreSQL advisory-lock serialization; the HTTP transport's
          // server-side store enforces it over the wire). A child minted
          // between the authoritative read and this write can never observe
          // or adopt an incorrectly reactivated root — the obsolete
          // activation NEVER COMMITS. Stores WITHOUT the method cannot
          // provide the atomic precondition: the repair HONESTLY REFUSES to
          // reactivate (no mutate-then-compensate window) and returns the
          // canonical state.
          const writeIfLatest = store.setSessionStatusIfLatest;
          if (writeIfLatest === undefined) {
            // Honest refusal on an unsupported store: never an unsafe write.
            state = (await readLatestQuizAttemptState(input, store, learnerKey)) ?? undefined;
            return;
          }
          let wrote: boolean;
          try {
            wrote = await writeIfLatest.call(
              store,
              session.id,
              'active',
              new Date().toISOString(),
              {
                expectedLastSeq: tail.seq,
                relevantSceneId: input.sceneId,
              },
            );
          } catch (error) {
            if (error instanceof RuntimeAppendConflictError) continue; // tail raced: re-read
            throw error;
          }
          if (!wrote) {
            // A relevant newer sibling committed (a real retry of THIS
            // scene): the old root was never touched — return the canonical
            // newer state.
            state = (await readLatestQuizAttemptState(input, store, learnerKey)) ?? undefined;
            return;
          }
          state = (await readLatestQuizAttemptState(input, store, learnerKey)) ?? undefined;
          return;
        }
        // CAS retries exhausted: still return the canonical current state.
        state = (await readLatestQuizAttemptState(input, store, learnerKey)) ?? undefined;
      });
    }
  }

  // Older shadow writers could append reviewed and crash before completing
  // the session. Replaying the same fact invokes the atomic tail-CAS repair.
  if (state?.phase === 'reviewed' && state.status === 'active') {
    await recordQuizAttempt(
      {
        ...input,
        attemptId: state.sessionId,
        phase: 'reviewed',
        answers: state.answers,
        results: state.results ?? [],
        // P1: the completion replay forwards the FULL modern plan — a
        // shadow-written active review must not lose its capturePlan (that
        // would silently downgrade a modern review to legacy semantics).
        ...(state.capturePlan !== undefined ? { capturePlan: state.capturePlan } : {}),
      },
      { ...deps, store, learnerKey },
    );
    state = await readLatestQuizAttemptState(input, store, learnerKey);
  }

  return {
    // The attemptId callers should USE going forward is the session the
    // latest state itself lives in — including a COMPLETED retry child: the
    // current answer's source identity must not reset to the root lineage
    // after the child finishes (hydration, capture, and grade recovery all
    // key on this id). Only a scene with no state at all falls back to the
    // canonical root id. startNewAttempt callers still pass this id to
    // recordQuizAttempt, which derives the root lineage itself, so retry
    // minting is unchanged.
    attemptId: state ? state.sessionId : attemptId,
    state,
  };
}

function samePayload(left: QuizAttemptPayload, right: QuizAttemptPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAnswers(left: QuizAnswers, right: QuizAnswers): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rolloverAttemptId(attemptId: string, index: number): string {
  return `${attemptId}:retry:${index}`;
}

function rootAttemptId(attemptId: string): string {
  return attemptId.replace(/(?::retry:\d+)+$/, '');
}

/**
 * Explicitly undecided verdict (closing gate #5): no decided status AND a
 * null correct. A legacy row whose status field claims a decision keeps its
 * historical completed fact — only provably-undecided reviews reactivate.
 */
function isExplicitlyUndecidedResult(result: QuestionResult): boolean {
  return (
    result.correct !== true &&
    result.correct !== false &&
    (result.status === undefined || result.status === 'ungraded')
  );
}

function compareSessionCreationOrder(left: RuntimeSession, right: RuntimeSession): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function isInactiveSessionAppendError(error: unknown, sessionId: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(
    `cannot append to session ${JSON.stringify(sessionId)} with status`,
  );
}

function assertPartition(session: RuntimeSession, stageId: string, learnerKey: string): void {
  if (
    session.kind !== 'quizAttempt' ||
    session.stageId !== stageId ||
    session.learnerKey !== learnerKey
  ) {
    throw new Error(
      `Quiz attempt ${JSON.stringify(session.id)} does not belong to stage ` +
        `${JSON.stringify(stageId)} and learner ${JSON.stringify(learnerKey)}`,
    );
  }
}

/**
 * Append one immutable quiz lifecycle fact. Calls for one attempt are serialized
 * so rapid draft writes cannot overtake submit or review writes.
 */

/**
 * A reviewed payload completes its session only when every result carries a
 * DECIDED verdict. A review that still holds ungraded results keeps the
 * attempt active, so grading recovery appends the decided review to the SAME
 * session instead of minting a retry (the attempt identity — and the capture
 * event ids that hang off it — must survive an unresolved grading). Legacy
 * reviewed payloads without results keep completing: that is a historical
 * fact, never rewritten.
 */
function completesAttempt(payload: QuizAttemptPayload): boolean {
  if (payload.phase !== 'reviewed') return false;
  if (payload.results === undefined) return true;
  return payload.results.every((result) => result.correct === true || result.correct === false);
}

/**
 * The typed outcome of one record write (r4 group 2): WHICH session the
 * write landed on, and whether THIS call CREATED it. A retry transition
 * turns this into the narrow child-creation receipt — the only legitimate
 * source of the ephemeral original-operation capability for a re-answer.
 */
export interface QuizAttemptWriteOutcome {
  /** The session this write landed on (the retry child when one was made). */
  sessionId: string;
  /** True only when THIS call's createSession call created the session. */
  createdSession: boolean;
}

export async function recordQuizAttempt(
  input: QuizAttemptRecordInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<QuizAttemptWriteOutcome> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const now = deps.now ?? (() => new Date().toISOString());
  const mintRecordId = deps.mintRecordId ?? mintId;
  const rootId = rootAttemptId(input.attemptId);

  return enqueue(store, rootId, () =>
    withAttemptLock(rootId, async (): Promise<QuizAttemptWriteOutcome> => {
      const timestamp = now();
      const latestState = input.startNewAttempt
        ? await readLatestQuizAttemptState(input, store, learnerKey)
        : undefined;
      const authoritativeCompletedSession =
        latestState?.status === 'completed'
          ? await store.getSession(latestState.sessionId)
          : undefined;
      const payload: QuizAttemptPayload = {
        payloadVersion: 1,
        phase: input.phase,
        answers: input.answers,
        ...(input.results === undefined ? {} : { results: input.results }),
        ...(input.capturePlan !== undefined ? { capturePlan: input.capturePlan } : {}),
      };
      let rolloverIndex = 0;
      let sessionId = input.attemptId;
      let originSession: RuntimeSession | undefined;
      /**
       * The EXACT session ids THIS call created (r4 closing group 2): the
       * receipt is computed for the RETURNED target only — creation of X
       * never transfers to an existing Y after an append/completion race
       * rolls the target forward. Retrying the SAME created session after a
       * tail-CAS conflict keeps its membership (the set is never cleared).
       */
      const createdSessionIds = new Set<string>();

      while (true) {
        let session = await store.getSession(sessionId);
        let created = false;
        if (!session) {
          try {
            session = await store.createSession({
              id: sessionId,
              kind: 'quizAttempt',
              stageId: input.stageId,
              learnerKey,
              status: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            created = true;
            createdSessionIds.add(sessionId);
          } catch (error) {
            // Without Web Locks, another tab may win the deterministic create
            // after our read. Re-read the winner instead of losing this write.
            session = await store.getSession(sessionId);
            if (!session) throw error;
          }
        }
        assertPartition(session, input.stageId, learnerKey);
        if (sessionId === input.attemptId) originSession = session;

        const records = await store.listRecords(sessionId);
        const foreignAnchor = records.find(
          (record) => record.sceneId !== undefined && record.sceneId !== input.sceneId,
        );
        if (foreignAnchor) {
          throw new Error(
            `Quiz attempt ${JSON.stringify(sessionId)} is already anchored to scene ` +
              `${JSON.stringify(foreignAnchor.sceneId)}`,
          );
        }

        // Canonical retry ids are scanned from one, but a stale caller may
        // already point at a later flat retry or a newer nested legacy retry.
        // Never move that caller backward onto an older active sibling.
        if (
          !created &&
          sessionId !== input.attemptId &&
          originSession &&
          compareSessionCreationOrder(session, originSession) <= 0
        ) {
          rolloverIndex += 1;
          sessionId = rolloverAttemptId(rootId, rolloverIndex);
          continue;
        }

        const lastRecord = records.at(-1);
        const last = asQuizPayload(lastRecord);

        if (input.startNewAttempt && !created) {
          // A concurrent retry may already have created the first active child.
          // Reuse it instead of minting a second active branch whose newer
          // session ordering would hide writes that still resolve to this one.
          if (sessionId !== input.attemptId && session.status === 'active') {
            // A child with a durable fact already represents the retry. An
            // empty child can remain after create succeeds but append fails;
            // fall through so this call writes the missing draft marker.
            if (last?.phase === 'draft' && Object.keys(last.answers).length === 0)
              return { sessionId, createdSession: createdSessionIds.has(sessionId) };
            if (
              last &&
              authoritativeCompletedSession &&
              authoritativeCompletedSession.id !== sessionId &&
              compareSessionCreationOrder(session, authoritativeCompletedSession) < 0
            ) {
              rolloverIndex += 1;
              sessionId = rolloverAttemptId(rootId, rolloverIndex);
              continue;
            }
            if (last) throw new QuizRetryProgressedError(sessionId);
          } else {
            rolloverIndex += 1;
            sessionId = rolloverAttemptId(rootId, rolloverIndex);
            continue;
          }
        }

        if (session.status === 'active') {
          if (last && PHASE_ORDER[payload.phase] < PHASE_ORDER[last.phase])
            return { sessionId, createdSession: createdSessionIds.has(sessionId) };

          // An active session with a reviewed tail can exist from an older
          // client that appended before its separate completion write. Heal
          // only the status, guarded by the record tail in the same transaction.
          if (last && samePayload(last, payload) && payload.phase !== 'reviewed')
            return { sessionId, createdSession: createdSessionIds.has(sessionId) };
          if (last && lastRecord && samePayload(last, payload)) {
            // An unresolved review replayed verbatim stays active — the
            // recovery is still owed. Only a decided review completes.
            if (completesAttempt(payload)) {
              try {
                await store.setSessionStatus(sessionId, 'completed', timestamp, {
                  expectedLastSeq: lastRecord.seq,
                });
              } catch (error) {
                if (error instanceof RuntimeAppendConflictError) continue;
                throw error;
              }
            }
            return { sessionId, createdSession: createdSessionIds.has(sessionId) };
          }

          try {
            await store.appendRecord(
              {
                id: mintRecordId(),
                sessionId,
                sceneId: input.sceneId,
                createdAt: timestamp,
                payload,
              },
              {
                expectedLastSeq: lastRecord?.seq ?? null,
                ...(completesAttempt(payload)
                  ? { sessionTransition: { status: 'completed' as const, updatedAt: timestamp } }
                  : {}),
              },
            );
          } catch (error) {
            if (error instanceof RuntimeAppendConflictError) continue;
            if (!isInactiveSessionAppendError(error, sessionId)) throw error;
            const raced = await store.getSession(sessionId);
            if (!raced || raced.status === 'active') throw error;
            assertPartition(raced, input.stageId, learnerKey);
            // Another tab completed between our active read and append. Re-run
            // the loop so the immutable completed attempt rolls forward.
            continue;
          }
          return { sessionId, createdSession: createdSessionIds.has(sessionId) };
        }

        if (last && samePayload(last, payload)) {
          return { sessionId, createdSession: createdSessionIds.has(sessionId) };
        }
        if (
          last &&
          PHASE_ORDER[payload.phase] < PHASE_ORDER[last.phase] &&
          sameAnswers(payload.answers, last.answers)
        ) {
          return { sessionId, createdSession: createdSessionIds.has(sessionId) };
        }

        rolloverIndex += 1;
        sessionId = rolloverAttemptId(rootId, rolloverIndex);
      }
    }),
  );
}

/** Backfill the strongest legacy localStorage state without deleting legacy keys. */
export async function backfillQuizAttempt(
  input: LegacyQuizAttemptInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<void> {
  const base = {
    stageId: input.stageId,
    sceneId: input.sceneId,
    attemptId: input.attemptId,
  };
  if (input.submittedAnswers) {
    await recordQuizAttempt({ ...base, phase: 'submitted', answers: input.submittedAnswers }, deps);
    if (input.results !== undefined) {
      await recordQuizAttempt(
        {
          ...base,
          phase: 'reviewed',
          answers: input.submittedAnswers,
          results: input.results,
        },
        deps,
      );
    }
    return;
  }
  if (input.draftAnswers) {
    await recordQuizAttempt({ ...base, phase: 'draft', answers: input.draftAnswers }, deps);
  }
}
