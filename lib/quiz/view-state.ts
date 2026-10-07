import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
import type {
  QuizAttemptState,
  QuizAttemptWriter,
  QuizCapturePlan,
  QuizDraftInput,
} from '@/lib/quiz/runtime';

export type QuizRuntimeGate =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; attemptId: string };

export interface QuizViewLifetime {
  capture(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createQuizViewLifetime(): QuizViewLifetime {
  let generation = 0;
  return {
    capture: () => generation,
    invalidate: () => {
      generation += 1;
    },
    isCurrent: (token) => token === generation,
  };
}

export async function runQuizPersistenceTransition(
  persist: () => Promise<void>,
  lifetime: QuizViewLifetime,
  onSuccess: () => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const token = lifetime.capture();
  try {
    await persist();
  } catch (error) {
    if (lifetime.isCurrent(token)) onError(error);
    return;
  }
  if (lifetime.isCurrent(token)) onSuccess();
}

export function isQuizRuntimeReady(
  gate: QuizRuntimeGate,
): gate is Extract<QuizRuntimeGate, { status: 'ready' }> {
  return gate.status === 'ready';
}

/**
 * The narrow child-creation receipt (r4 group 2): returned ONLY when THIS
 * call's locked retry write actually CREATED the child session it wrote to.
 * The view redeems the capability for exactly this child on the canonical
 * hydration — nothing else can mint or broaden it.
 */
export interface QuizRetryCreationReceipt {
  kind: 'retry-child-created';
  /** The EXACT child session this write created and landed on. */
  childAttemptId: string;
  parentAttemptId: string;
  stageId: string;
  sceneId: string;
}

/**
 * The PRODUCTION ticket-redemption rule (r4 closing group 2): canonical
 * hydration converts a LIVE creation receipt into the ephemeral
 * original-operation capability for exactly ONE attempt — the child the
 * receipt names, in the receipt's own stage/scene context. Returns the
 * attempt id that gains the capability, or null when the ticket is revoked
 * (no ticket, context mismatch, a lineage-broken receipt, or canonical
 * hydration returning ANY other attempt — including another actor's
 * advanced child Y). An empty canonical read grants only the FIRST-EVER
 * attempt, and only when no live ticket contradicts it.
 */
export function redeemCreationTicket(
  ticket: QuizRetryCreationReceipt | null | undefined,
  hydration: {
    /** The canonical hydration's authoritative attempt id. */
    attemptId: string;
    /** True when hydration found NO stored state for this scene. */
    fromEmpty: boolean;
    stageId: string;
    sceneId: string;
  },
): string | null {
  const liveTicket = ticket ?? null;
  if (hydration.fromEmpty) {
    // First-ever attempt — unless THIS episode's receipt contradicts the
    // empty read (it created a child; an empty store is then a mismatch).
    return liveTicket === null ? hydration.attemptId : null;
  }
  if (liveTicket === null) return null; // no live ticket: nothing to redeem
  if (liveTicket.stageId !== hydration.stageId || liveTicket.sceneId !== hydration.sceneId) {
    return null; // live context moved on — revoked
  }
  if (!liveTicket.childAttemptId.startsWith(`${liveTicket.parentAttemptId}:retry:`)) {
    return null; // receipt no longer names a child of its own lineage
  }
  // Exactly the created child — never any other canonical attempt.
  return hydration.attemptId === liveTicket.childAttemptId ? liveTicket.childAttemptId : null;
}

export async function persistQuizRetry(
  input: { stageId: string; sceneId: string; attemptId: string },
  writer: Pick<QuizAttemptWriter, 'recordPhase'>,
): Promise<QuizRetryCreationReceipt | null> {
  const outcome = await writer.recordPhase({
    ...input,
    phase: 'draft',
    answers: {},
    startNewAttempt: true,
  });
  // Only a session THIS call created (a genuine new child written under the
  // attempt lock) is a creation receipt — a reused/concurrent child or the
  // root itself grants nothing.
  if (!outcome.createdSession || outcome.sessionId === input.attemptId) return null;
  return {
    kind: 'retry-child-created',
    childAttemptId: outcome.sessionId,
    parentAttemptId: input.attemptId,
    stageId: input.stageId,
    sceneId: input.sceneId,
  };
}

export async function persistQuizSubmission(
  input: QuizDraftInput,
  writer: Pick<QuizAttemptWriter, 'recordPhase'>,
): Promise<void> {
  await writer.recordPhase({ ...input, phase: 'submitted' });
}

export async function persistQuizReview(
  input: QuizDraftInput & { results: QuestionResult[]; capturePlan?: QuizCapturePlan },
  writer: Pick<QuizAttemptWriter, 'recordPhase'>,
): Promise<void> {
  await writer.recordPhase({ ...input, phase: 'reviewed' });
}

export interface QuizViewHydratedState {
  phase: 'not_started' | 'answering' | 'reviewing';
  answers: QuizAnswers;
  results: QuestionResult[];
  /** Frozen capture plan (absent on legacy reviews). */
  capturePlan?: QuizCapturePlan;
}

export function quizViewStateFromAttempt(
  state: QuizAttemptState | undefined,
): QuizViewHydratedState {
  if (!state) return { phase: 'not_started', answers: {}, results: [] };
  if (state.phase === 'reviewed') {
    return {
      phase: 'reviewing',
      answers: state.answers,
      results: state.results ?? [],
      ...(state.capturePlan !== undefined ? { capturePlan: state.capturePlan } : {}),
    };
  }
  if (state.phase === 'draft' && Object.keys(state.answers).length === 0) {
    return { phase: 'not_started', answers: {}, results: [] };
  }
  return { phase: 'answering', answers: state.answers, results: [] };
}
