/**
 * Client half of the mistake book: the pure payload builder the quiz view
 * calls after grading, plus the fetch wrappers the mistake-book page uses.
 *
 * Capture is deliberately fire-and-forget from the quiz's point of view: a
 * failed POST (including the 503 a browser-only deployment answers) is logged
 * and dropped — grading and review must never depend on the mistake book.
 */
import type { QuizQuestion } from '@/lib/types/stage';
import type { QuestionResult } from '@/lib/quiz/grading';
import { createLogger } from '@/lib/logger';
import { sha256Hex } from '@/lib/utils/sha256';
import type { MistakeRecordView } from '@/lib/persistence/mistake-book';
import { strictInstanceMatches } from '@/lib/mistake-book/plan-executor';

const log = createLogger('MistakeBook');

export interface MistakeCaptureContextInput {
  stageId: string;
  stageName: string;
  sceneId: string;
  sceneTitle?: string;
  sceneOrder?: number;
  /** Curriculum taxonomy codes from the stage ('math', 'grade-1-up'). */
  subject?: string;
  gradeSemester?: string;
}

export interface MistakeCapturePayload {
  /**
   * Stable id of the grading/retry event this capture belongs to. Contract
   * RESERVED in batch B: the client always sends one, the server currently
   * accepts and ignores it — R9 turns it into owner-scoped dedupe so a
   * replayed event cannot bump wrong_count or clear mastery twice.
   */
  eventId?: string;
  stageId: string;
  stageName: string;
  sceneId: string;
  sceneTitle?: string;
  sceneOrder?: number;
  subject?: string;
  gradeSemester?: string;
  items: Array<{
    questionId: string;
    /** Stable per-question event id (attempt+question). Idempotent capture. */
    eventId: string;
    questionType: QuizQuestion['type'];
    question: string;
    /** QuizOption[] from a live question, or the stored snapshot on retry. */
    options?: unknown;
    correctAnswer?: string[];
    analysis?: string;
    /** The tested knowledge point — drives same-point practice in the mistake book. */
    knowledgePoint?: string;
    userAnswer: unknown;
  }>;
}

/**
 * Length-safe, delimiter-unambiguous event-id encoding (C review): ids are
 * the JSON tuple of their parts — no separator can collide because the
 * tuple itself carries the boundaries — compressed with a strong dual-lane
 * 64-bit FNV fingerprint when the tuple exceeds the budget. Legal ids that
 * contain '#', '~', or any separator cannot alias one another: different
 * tuples always produce different encodings (full tuple when it fits; the
 * fingerprint covers the ENTIRE tuple, never a truncated prefix).
 */
const EVENT_ID_MAX = 200;

function eventFingerprint(tuple: string): string {
  // Real SHA-256 (pure JS — plain-HTTP browser contexts have no WebCrypto):
  // the fingerprint is a cryptographic digest of the ENTIRE tuple, never a
  // truncated-prefix+weak-hash combo (delivery review #4).
  return sha256Hex(tuple).slice(0, 32);
}

export function encodeEventId(parts: readonly string[]): string {
  const tuple = JSON.stringify(parts);
  if (tuple.length <= EVENT_ID_MAX) return tuple;
  return `ev:${eventFingerprint(tuple)}`;
}

/**
 * Mint the stable per-question event id for one graded attempt (R9): the
 * attempt session id plus the question id. The attempt id changes only for a
 * REAL re-answer (the runtime's durable retry child), so grading recovery
 * reuses the same event id and cannot double-count. Encoding is the shared
 * length-safe tuple form (see {@link encodeEventId}).
 */
export function questionEventId(attemptId: string, questionId: string): string {
  return encodeEventId([attemptId, questionId]);
}

/**
 * Build the capture payload from one graded quiz review — only the incorrect
 * questions, each with a full snapshot (text, options, correct answer,
 * analysis) so the record survives course edits and deletion.
 * Returns null when nothing was wrong (nothing to capture).
 */
export function buildMistakeCapturePayload(
  questions: readonly QuizQuestion[],
  answers: Record<string, string | string[]>,
  results: readonly QuestionResult[],
  context: MistakeCaptureContextInput & { attemptId: string },
): MistakeCapturePayload | null {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const items: MistakeCapturePayload['items'] = [];
  for (const result of results) {
    // Confirmed-wrong only: an 'ungraded' result, a legacy null-verdict row,
    // or any contradictory runtime payload (status incorrect without
    // correct === false) must never be captured as a mistake.
    if (result.status !== 'incorrect' || result.correct !== false) continue;
    const question = byId.get(result.questionId);
    if (!question) continue;
    const analysis =
      [question.analysis, result.aiComment].filter(Boolean).join('\n\n') || undefined;
    items.push({
      questionId: question.id,
      eventId: questionEventId(context.attemptId, question.id),
      questionType: question.type,
      question: question.question,
      ...(question.options ? { options: question.options } : {}),
      ...(question.answer ? { correctAnswer: question.answer } : {}),
      ...(analysis ? { analysis } : {}),
      ...(question.knowledgePoint ? { knowledgePoint: question.knowledgePoint } : {}),
      userAnswer: answers[question.id],
    });
  }
  if (items.length === 0) return null;
  return {
    stageId: context.stageId,
    stageName: context.stageName,
    sceneId: context.sceneId,
    ...(context.sceneTitle ? { sceneTitle: context.sceneTitle } : {}),
    ...(context.sceneOrder !== undefined ? { sceneOrder: context.sceneOrder } : {}),
    ...(context.subject ? { subject: context.subject } : {}),
    ...(context.gradeSemester ? { gradeSemester: context.gradeSemester } : {}),
    items,
  };
}

/**
 * Build the re-capture payload for one wrong in-place retry from the stored
 * record. `pickedAnswer` is THIS attempt's answer (never the stale
 * lastUserAnswer) and `eventId` is the stable retry-event id the card minted.
 */
export function buildRetryPayload(
  record: MistakeRecordView,
  pickedAnswer: readonly string[],
  eventId: string,
): MistakeCapturePayload {
  return {
    eventId,
    stageId: record.stageId,
    stageName: record.stageName,
    sceneId: record.sceneId,
    ...(record.sceneTitle != null ? { sceneTitle: record.sceneTitle } : {}),
    ...(record.sceneOrder != null ? { sceneOrder: record.sceneOrder } : {}),
    ...(record.subject != null ? { subject: record.subject } : {}),
    ...(record.gradeSemester != null ? { gradeSemester: record.gradeSemester } : {}),
    items: [
      {
        questionId: record.questionId,
        eventId,
        questionType: record.questionType,
        question: record.question,
        ...(record.options ? { options: record.options } : {}),
        ...(Array.isArray(record.correctAnswer)
          ? { correctAnswer: record.correctAnswer as string[] }
          : {}),
        ...(record.analysis ? { analysis: record.analysis } : {}),
        ...(record.knowledgePoint ? { knowledgePoint: record.knowledgePoint } : {}),
        userAnswer: pickedAnswer,
      },
    ],
  };
}

export type CaptureSubmissionStatus =
  | 'uploaded' // every event of THIS submission committed
  | 'parked' // identity guard: at least one event parked (not lost, recoverable)
  | 'unbound' // this submission's records stay unbound: explicit claim is the only binding path
  | 'conflict' // same id already holds DIFFERENT frozen content, or the server refused this payload (409)
  | 'local-failed' // the queue itself could not persist (honest not-saved)
  | 'unconfigured' // deployment answers 503: nothing stored or claimed
  | 'network-unknown'; // identity probe unreachable: events stay queued

/**
 * Per-question truth (C2 implementation review): each question of THIS
 * submission carries its OWN durable outcome and the REAL record handle
 * (owner-scoped key) — a partial submission never collapses into one blanket
 * verdict, and lifecycle consumers correlate by handle, never by eventId.
 */
export interface CaptureQuestionOutcome {
  questionId: string;
  eventId: string;
  /** Owner-scoped record handle; absent when nothing of this question persisted. */
  handle?: string;
  /** Stable content fingerprint of the frozen payload (receipt identity). */
  fingerprint?: string;
  /** The record's creation token — the INSTANCE identity of receipts. */
  recordToken?: string;
  /** Legacy token-less records: createdAt is the instance identity. */
  recordCreatedAt?: number;
  state:
    | 'uploaded'
    | 'queued' // durable under its owner: parked / network-unknown retry paths
    | 'parked' // identity guard: recoverable, record NOT uploading now
    | 'unbound' // durable but identity-unbound: explicit claim only
    | 'conflict' // permanent for this content (local or server)
    | 'unconfigured'
    | 'local-failed';
}

export interface CaptureSubmissionResult {
  status: CaptureSubmissionStatus;
  /** Event ids committed in this call (subset of THIS submission only). */
  uploaded: string[];
  /** Per-question outcomes with real record handles (C2 implementation review). */
  questions: CaptureQuestionOutcome[];
  /**
   * Handles of THIS submission's records that are durable but NOT yet
   * uploaded — the exact identity a lifecycle flush must confirm (by key or
   * boundFrom) before anyone may call the submission uploaded.
   */
  pendingKeys: string[];
  /** Creation proofs this call holds for its own records (recovery context). */
  recoveryProofs: Array<{ eventId: string; creationToken: string }>;
}

/**
 * Capture one graded batch through the RELIABLE path (R8, C1 gate): EVERY
 * question is its own durable event, frozen and persisted BEFORE any network
 * work; the bounded identity confirmation then flushes per-question events.
 * Results are correlated by the REAL record handles (owner-scoped keys) this
 * submission obtained from enqueue — 'persisted' handles it created, 'reused'
 * handles whose identical frozen content was already queued — never by
 * eventId alone: an old event of another owner/session uploading under the
 * same id can never read as THIS submission's success (C1 gate #5).
 */
export async function captureMistakesFromQuiz(
  payload: MistakeCapturePayload,
  options: {
    /**
     * Recovery context (C2 design): creation proofs THIS operation obtained
     * when it first persisted its records. On a local-failed retry, a reused
     * record whose OWN token matches one of these proofs is still THIS
     * operation's record — binding may continue against it. A reused record
     * with any other (or no) token is an unknown older event: explicit claim
     * only, never auto-bound by a retry.
     */
    recoveryProofs?: ReadonlyArray<{ eventId: string; creationToken: string }>;
  } = {},
): Promise<CaptureSubmissionResult> {
  // Declared OUTSIDE the try so the catch keeps every piece of evidence the
  // already-completed enqueues produced (C2 design #3: honest degradation).
  /** Per-question outcome under construction, indexed like payload.items. */
  const questions: CaptureQuestionOutcome[] = payload.items.map((item) => ({
    questionId: item.questionId,
    eventId: item.eventId,
    state: 'local-failed',
  }));
  /** Proofs valid for continued verification on THIS call (persist + matched reuse). */
  const proofs = new Map<string, string>();
  try {
    const outbox = await import('./outbox');

    // PERSIST FIRST (delivery review #3): every question is its own durable
    // event, frozen and stored BEFORE any network work — leaving the page,
    // a hanging identity probe, or a later local-write failure can never
    // lose an un-persisted answer. Events created while no owner is
    // confirmed persist UNBOUND (claimable later); a confirmed owner binds
    // them at creation. No probe is awaited before these writes.
    const perQuestion: MistakeCapturePayload[] = payload.items.map((item) => ({
      ...payload,
      eventId: item.eventId,
      items: [item],
    }));
    /** Real record handles for THIS submission — persisted or same-content reused. */
    const handles = new Set<string>();
    // Creation tokens prove WHICH durable records this call created: only they
    // may auto-bind to a freshly confirmed owner (C1 gate #4). A reused
    // already-queued record issues NO NEW proof — only a proof-matched
    // recovery reuse keeps verifying the ORIGINAL operation's record.
    const creations: Array<{ eventId: string; creationToken: string }> = [];
    let localConflicts = 0;
    for (const [index, event] of perQuestion.entries()) {
      const outcome = await outbox.enqueueCaptureEvent(event);
      if (outcome.kind === 'persisted') {
        creations.push({ eventId: outcome.eventId, creationToken: outcome.creationToken });
        proofs.set(outcome.eventId, outcome.creationToken);
        handles.add(outcome.handle);
        questions[index] = {
          questionId: event.items[0]!.questionId,
          eventId: outcome.eventId,
          handle: outcome.handle,
          fingerprint: outbox.fingerprintOf(event),
          recordToken: outcome.creationToken,
          state: 'queued',
        };
      } else if (outcome.kind === 'reused') {
        // Same owner+event+identical frozen content: follow THIS exact record
        // through the flush — a 500→200 same-content retransmit must pass.
        handles.add(outcome.handle);
        questions[index] = {
          questionId: event.items[0]!.questionId,
          eventId: outcome.eventId,
          handle: outcome.handle,
          fingerprint: outbox.fingerprintOf(event),
          recordToken: outcome.recordToken,
          ...(outcome.recordCreatedAt !== undefined
            ? { recordCreatedAt: outcome.recordCreatedAt }
            : {}),
          state: 'queued',
        };
        // A reused record carrying THIS operation's original proof is still
        // ours to bind (local-failed recovery). Any other token — or none —
        // belongs to an unknown older session: claim-only, no auto-bind.
        const originalProof = options.recoveryProofs?.find(
          (proof) => proof.eventId === outcome.eventId,
        );
        if (
          outcome.recordToken !== undefined &&
          originalProof !== undefined &&
          outcome.recordToken === originalProof.creationToken
        ) {
          creations.push({ eventId: outcome.eventId, creationToken: outcome.recordToken });
          proofs.set(outcome.eventId, outcome.recordToken);
        }
      } else if (outcome.kind === 'local-conflict') {
        localConflicts += 1; // different content under the same key: kept frozen, not ours
        questions[index] = {
          questionId: event.items[0]!.questionId,
          eventId: outcome.eventId,
          state: 'conflict',
        };
      } else {
        // local-write-failed: nothing of THIS question persisted.
        questions[index] = {
          questionId: event.items[0]!.questionId,
          eventId: event.eventId!,
          state: 'local-failed',
        };
      }
    }
    const finish = (
      status: CaptureSubmissionStatus,
      uploaded: string[],
    ): CaptureSubmissionResult => ({
      status,
      uploaded,
      questions,
      pendingKeys: questions
        .filter((question) => question.handle !== undefined && question.state !== 'uploaded')
        .map((question) => question.handle!),
      /**
       * Creation proofs THIS call holds (persisted + proof-matched reuse) —
       * the recovery context a local-failed retry needs to continue binding
       * its own records (C2 design #2).
       */
      recoveryProofs: [...proofs.entries()].map(([eventId, creationToken]) => ({
        eventId,
        creationToken,
      })),
    });
    if (questions.some((question) => question.state === 'local-failed')) {
      return finish('local-failed', []);
    }
    if (handles.size === 0 && localConflicts === perQuestion.length) {
      // Every event of this submission collides with a DIFFERENT frozen
      // payload: honest conflict — nothing of this submission was stored.
      return finish('conflict', []);
    }

    // Then the bounded identity confirmation and flush. A short ceiling keeps
    // the interactive path responsive; the events are already durable, so a
    // timeout only defers the upload to the next lifecycle flush.
    const probe = await outbox.probeOwnerIdentity();
    if (probe.kind === 'unconfigured') {
      // A conflict is permanent regardless of configuration — never masked.
      for (const question of questions) {
        if (question.state !== 'conflict') question.state = 'unconfigured';
      }
      return finish('unconfigured', []);
    }
    // 'offline' or a mismatched echo: events stay queued; classify below via
    // the flush report.

    const report = await outbox.flushOutbox({ bindNewEvents: creations });
    // Correlate by THIS submission's handles (owner+key) — an uploaded/
    // parked/unbound verdict for a record this call never held is ignored.
    // A record this call persisted unbound and the flush then BOUND carries
    // its pre-bind handle in `boundFrom`, so the key change on adoption
    // never orphans the handle (C1 gate #5). Matching is the SHARED strict
    // rule (P3 §3): key + fingerprint + the token-or-createdAt instance
    // plane, fail-closed on absent metadata.
    const byHandle = new Map<string, CaptureQuestionOutcome>();
    for (const question of questions) {
      if (question.handle !== undefined) byHandle.set(question.handle, question);
    }
    const mine = (
      entries: ReadonlyArray<{
        key: string;
        eventId: string;
        boundFrom?: string;
        fingerprint?: string;
        recordToken?: string | null;
        createdAt?: number;
      }>,
    ) =>
      entries.filter((entry) =>
        questions.some((question) => strictInstanceMatches(entry, question)),
      );
    const resolveEntry = (entry: {
      key: string;
      boundFrom?: string;
      fingerprint?: string;
      recordToken?: string | null;
    }) => questions.find((question) => strictInstanceMatches(entry, question));
    const applyState = (
      entries: ReadonlyArray<{
        key: string;
        eventId: string;
        boundFrom?: string;
        fingerprint?: string;
        recordToken?: string | null;
        createdAt?: number;
      }>,
      state: CaptureQuestionOutcome['state'],
    ) => {
      for (const entry of mine(entries)) {
        const question = resolveEntry(entry);
        if (!question) continue;
        if (question.state === 'uploaded' && state !== 'uploaded') {
          continue; // committed success is terminal: a LATE failure entry for
          // the same record (the flush retried and got 500 after the commit)
          // must never downgrade it.
        }
        if (question.state === 'conflict' && state !== 'conflict') {
          continue; // a permanent refusal is terminal too: the same record
          // also sitting in the unbound/parked lists must not soften it.
        }
        question.state = state;
        // Handle migration (C2 design #1): when this entry got here through
        // a COMMITTED boundFrom alias, entry.key is the record's REAL key
        // now (|event → owner|event). Future operations and lifecycle
        // confirmations must track that key, not the stale pre-bind one.
        if (entry.boundFrom !== undefined && question.handle === entry.boundFrom) {
          question.handle = entry.key;
          byHandle.set(entry.key, question);
        }
      }
    };
    // COMMITTED BIND MIGRATIONS FIRST (mapping review): BEFORE any report
    // state applies — a same-content dedupe's destination carries a
    // DIFFERENT token, and applying verdicts first would reject the
    // legitimate migration (or drop parked/conflict facts). Admission is
    // the SHARED full-plane matcher (r1 §3): key + fingerprint + the
    // token-or-createdAt instance plane — a source naming a different
    // instance never migrates. A legacy token-less destination RESETS the
    // question's token and keeps the destination's createdAt — never only
    // assigning when a string exists.
    for (const mapping of report.committedBinds) {
      for (const question of questions) {
        if (strictInstanceMatches(mapping.source, question)) {
          question.handle = mapping.destination.key;
          if (typeof mapping.destination.recordToken === 'string') {
            question.recordToken = mapping.destination.recordToken;
            question.recordCreatedAt = undefined;
          } else {
            question.recordToken = undefined; // legacy dest: clear source token
          }
          if (typeof mapping.destination.createdAt === 'number') {
            question.recordCreatedAt = mapping.destination.createdAt;
          }
        }
      }
    }
    // COMMITTED MAPPINGS FIRST (closing gate #2): uploads and their handle
    // migrations, then PERMANENT refusals — before any failure-ish state can
    // touch the same questions.
    applyState(report.uploaded, 'uploaded');
    applyState(report.rejected, 'conflict');
    applyState(report.conflicts, 'conflict');
    // THEN the durable-but-uncommitted states (the terminal-uploaded guard
    // inside applyState keeps committed successes safe from late 500s).
    applyState(report.parked, 'parked');
    // Transient failures (5xx / network): the record IS durable — the queue
    // owns the retry (early review run4).
    applyState(report.failed, 'queued');
    applyState(report.unbound, 'unbound');
    // FINALLY strict receipt confirmation (C2 design): a background flush may
    // have committed AND deleted our records before THIS flush read the
    // queue — an empty report is not a failure verdict. Only the exact
    // owner-scoped key AND frozen content fingerprint count; receipts never
    // confirm a permanent conflict or an already-committed question anew.
    const reportConfirmed = new Set(mine(report.uploaded).map((entry) => entry.key));
    // Receipts confirm ONLY records this flush left identity-consistent and
    // merely unconfirmed ('queued'). A parked (identity-guarded) or unbound
    // record reflects a CURRENT identity fact of this very result — an old
    // same-key/same-content receipt from a PREVIOUS record must never
    // overwrite it (closing-gate #2 addendum); permanent conflicts likewise.
    const receiptCandidates = questions.filter(
      (question) =>
        question.handle !== undefined &&
        question.fingerprint !== undefined &&
        !reportConfirmed.has(question.handle) &&
        question.state === 'queued',
    );
    if (receiptCandidates.length > 0) {
      const receiptResult = await outbox.readReceipts(
        receiptCandidates.map((question) => ({
          key: question.handle!,
          fingerprint: question.fingerprint!,
          recordToken: question.recordToken ?? null,
          ...(question.recordCreatedAt !== undefined
            ? { createdAt: question.recordCreatedAt }
            : {}),
        })),
      );
      // ok === false (unreadable receipts): proves nothing — questions keep
      // their 'queued' state; only strictly matched ROWS upgrade.
      if (receiptResult.ok) {
        const confirmedKeys = new Set(receiptResult.matched.map((side) => side.key));
        for (const question of receiptCandidates) {
          if (confirmedKeys.has(question.handle!)) question.state = 'uploaded';
        }
      }
    }
    const uploaded = questions
      .filter((question) => question.state === 'uploaded')
      .map((q) => q.eventId);
    if (localConflicts > 0 || questions.some((question) => question.state === 'conflict')) {
      // A frozen different-content original, a server-side payload conflict,
      // or a bind that found the target holding different content: permanent
      // for this submission's content — never retried into a fake success,
      // and never masked by other questions uploading.
      return finish('conflict', uploaded);
    }
    if (uploaded.length === handles.size && handles.size > 0) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('openmaic:mistakes-changed'));
      }
      return finish('uploaded', uploaded);
    }
    if (questions.some((question) => question.state === 'parked')) {
      return finish('parked', uploaded);
    }
    if (questions.some((question) => question.state === 'unbound')) {
      return finish('unbound', uploaded);
    }
    if (uploaded.length > 0) return finish('parked', uploaded); // partial commit
    return finish('network-unknown', uploaded);
  } catch (error) {
    log.warn('Mistake capture request failed:', error);
    // Honest degradation (C2 design #3): without the flush report we know
    // only what enqueue PROVED. A question holding a real handle WAS
    // persisted (durable, unconfirmed — queued); anything without evidence
    // was never stored and must not be advertised as "saved offline".
    const durable = questions.filter((question) => question.handle !== undefined);
    const status: CaptureSubmissionStatus =
      durable.length === questions.length && questions.length > 0
        ? 'network-unknown'
        : 'local-failed';
    return {
      status,
      uploaded: [],
      questions,
      pendingKeys: durable
        .filter((question) => question.state !== 'uploaded')
        .map((question) => question.handle!),
      recoveryProofs: [...proofs.entries()].map(([eventId, creationToken]) => ({
        eventId,
        creationToken,
      })),
    };
  }
}

export interface MistakeListResult {
  mistakes: MistakeRecordView[];
  configured: boolean;
}

export async function fetchMistakes(
  filter: 'all' | 'unmastered' | 'mastered' = 'all',
  options: { signal?: AbortSignal } = {},
): Promise<MistakeListResult> {
  const response = await fetch(`/api/mistakes?filter=${filter}`, { signal: options.signal });
  void import('./outbox').then((outbox) => outbox.observeOwner(response.headers.get('x-owner-id')));
  if (response.status === 503) return { mistakes: [], configured: false };
  if (!response.ok) throw new Error(`Failed to load mistakes (${response.status})`);
  const json = (await response.json()) as { data?: { mistakes?: MistakeRecordView[] } };
  return { mistakes: json.data?.mistakes ?? [], configured: true };
}

export async function setMistakeMastered(
  key: { stageId: string; sceneId: string; questionId: string },
  mastered: boolean,
): Promise<boolean> {
  const response = await fetch('/api/mistakes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...key, mastered }),
  });
  return response.ok;
}

export async function reportRetryWrong(payload: MistakeCapturePayload): Promise<boolean> {
  // A wrong retry is just another capture: wrong_count+1, back to unmastered.
  // Committed ⇔ every event of THIS retry uploaded (honest per-submission
  // semantics; parked/unbound/local-failed read as not-saved, retryable).
  const result = await captureMistakesFromQuiz(payload);
  return result.status === 'uploaded';
}

/**
 * Manual classification: ONE server-side command. Tri-state per field —
 * omitted = keep, null = clear, code = set — and the server atomically
 * rewrites the classification authority, the owner's mistake rows, and the
 * course metadata when the course exists there. Never throws; a non-OK
 * response resolves to false so the UI can keep the dialog open for retry.
 */
export async function classifyStage(
  stageId: string,
  classification: { subject?: string | null; gradeSemester?: string | null },
): Promise<boolean> {
  try {
    const response = await fetch('/api/mistakes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classifyStage: true, stageId, ...classification }),
    });
    return response.ok;
  } catch (error) {
    log.warn('Mistake classification request failed:', error);
    return false;
  }
}

export async function deleteMistakeRecord(
  scope:
    | { kind: 'one'; stageId: string; sceneId: string; questionId: string }
    | { kind: 'stage'; stageId: string }
    | { kind: 'all' },
): Promise<boolean> {
  const body =
    scope.kind === 'one'
      ? { stageId: scope.stageId, sceneId: scope.sceneId, questionId: scope.questionId }
      : scope.kind === 'stage'
        ? { stageId: scope.stageId }
        : { all: true };
  const response = await fetch('/api/mistakes', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.ok;
}

/** Lightweight unmastered count for the home badge (R11). */
export async function fetchMistakeCount(): Promise<number | null> {
  try {
    const response = await fetch('/api/mistakes?count=unmastered');
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: { count?: number } };
    return typeof json.data?.count === 'number' ? json.data.count : null;
  } catch {
    return null;
  }
}
