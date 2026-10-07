/**
 * Owner-scoped mistake book — the server-side store behind `/api/mistakes`.
 *
 * Every quiz question a learner answers incorrectly (in-lesson quizzes and the
 * after-class practice finale alike) is upserted here as a durable record, so
 * wrong answers stop disappearing with the scene's latest-attempt state. The
 * row snapshots the full question (text, options, correct answer, analysis):
 * the source course may later be edited or deleted, but the mistake stays
 * reviewable.
 *
 * Classification runs through a per-(owner, stage) authority row
 * (`mistake_classification`) that outlives the course: captures follow it (a
 * client snapshot only initializes it, never overrides a recorded decision),
 * and the manual classify command rewrites it, the owner's mistake rows, and —
 * when the course exists on the server and belongs to this owner — the course
 * metadata, all inside ONE transaction on ONE checked-out connection, under
 * the same advisory lock domain as capture.
 *
 * Same raw-SQL pattern as `owner-materials.ts`: a pinned
 * `CREATE TABLE IF NOT EXISTS` schema ensured at provider bootstrap, and
 * owner-scoped queries. Upserts keep the natural composite key
 * (owner, stage, scene, question) — answering the same question wrong again
 * bumps `wrong_count`, refreshes the snapshot, and clears `mastered_at`, so a
 * lapsed question returns to the unmastered pool on its own.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';
import { PgDocumentStore } from '@openmaic/storage/document/pg';
import type { Stage as StageLike } from '@openmaic/dsl';
import type { PoolClientLike, TransactionSource } from './owner-bound-document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

export const MISTAKE_QUESTION_TYPES = ['single', 'multiple', 'short_answer'] as const;
export type MistakeQuestionType = (typeof MISTAKE_QUESTION_TYPES)[number];

export type MistakeListFilter = 'all' | 'unmastered' | 'mastered';

/** One wrong answer, as sent by the client right after a quiz review. */
export interface MistakeCaptureItem {
  questionId: string;
  /**
   * Stable per-question event id (attempt+question identity). Present =
   * idempotent capture; absent = legacy payload with NO idempotence claim.
   */
  eventId?: string;
  questionType: MistakeQuestionType;
  question: string;
  /** QuizOption[] snapshot; absent for short answers. */
  options?: unknown;
  /** Correct answer values; absent for short answers. */
  correctAnswer?: unknown;
  analysis?: string;
  /** The tested knowledge point; drives same-point practice. */
  knowledgePoint?: string;
  /** The learner's wrong answer, in the quiz's own answer encoding. */
  userAnswer: unknown;
}

/** Shared context for one capture batch (one graded quiz scene). */
export interface MistakeCaptureContext {
  stageId: string;
  stageName: string;
  sceneId: string;
  sceneTitle?: string;
  sceneOrder?: number;
  /** Curriculum taxonomy codes from the stage ('math', 'grade-1-up'). */
  subject?: string;
  gradeSemester?: string;
}

export interface MistakeRecord {
  ownerId: string;
  stageId: string;
  sceneId: string;
  questionId: string;
  stageName: string;
  sceneTitle: string | null;
  sceneOrder: number | null;
  subject: string | null;
  gradeSemester: string | null;
  questionType: MistakeQuestionType;
  question: string;
  options: unknown;
  correctAnswer: unknown;
  analysis: string | null;
  knowledgePoint: string | null;
  lastUserAnswer: unknown;
  wrongCount: number;
  firstWrongAt: number;
  lastWrongAt: number;
  masteredAt: number | null;
}

/** The API-facing shape: epoch millis serialized as ISO strings. */
export interface MistakeRecordView {
  stageId: string;
  stageName: string;
  sceneId: string;
  sceneTitle: string | null;
  sceneOrder: number | null;
  subject: string | null;
  gradeSemester: string | null;
  questionId: string;
  questionType: MistakeQuestionType;
  question: string;
  options: unknown;
  correctAnswer: unknown;
  analysis: string | null;
  knowledgePoint: string | null;
  lastUserAnswer: unknown;
  wrongCount: number;
  firstWrongAt: string;
  lastWrongAt: string;
  masteredAt: string | null;
}

export const MISTAKE_BOOK_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS mistake_record (
  owner_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  scene_title TEXT,
  scene_order INTEGER,
  subject TEXT,
  grade_semester TEXT,
  question_type TEXT NOT NULL,
  question TEXT NOT NULL,
  options JSONB,
  correct_answer JSONB,
  analysis TEXT,
  knowledge_point TEXT,
  last_user_answer JSONB NOT NULL,
  wrong_count INTEGER NOT NULL DEFAULT 1,
  first_wrong_at DOUBLE PRECISION NOT NULL,
  last_wrong_at DOUBLE PRECISION NOT NULL,
  mastered_at DOUBLE PRECISION,
  PRIMARY KEY (owner_id, stage_id, scene_id, question_id)
);

CREATE INDEX IF NOT EXISTS mistake_record_owner_mastered_idx
  ON mistake_record (owner_id, mastered_at);

CREATE INDEX IF NOT EXISTS mistake_record_owner_stage_idx
  ON mistake_record (owner_id, stage_id);

-- Databases created before the curriculum taxonomy carry the table without
-- the two classification columns; CREATE TABLE IF NOT EXISTS leaves such
-- tables untouched, so add them here (NULL = unclassified).
ALTER TABLE mistake_record ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE mistake_record ADD COLUMN IF NOT EXISTS grade_semester TEXT;

-- Same-point practice: the tested knowledge point of a question. Older
-- captures predate the column; NULL = infer it from the question snapshot
-- at practice time instead of blocking capture.
ALTER TABLE mistake_record ADD COLUMN IF NOT EXISTS knowledge_point TEXT;

-- The classification authority: one row per (owner, stage), independent of
-- whether the source course still exists. Captures follow it and never let a
-- client snapshot override a decision already recorded here; the manual
-- classify command is the only writer of source='manual' rows.
-- Owner-scoped capture-event dedupe (R9): one row per (owner, event) with
-- the payload fingerprint it committed. A replay of the same event with the
-- same content is a no-op (no extra wrong_count, no mastery reset); the same
-- eventId with DIFFERENT content is rejected loudly, never silently
-- overwritten. Legacy events (no eventId) carry NULL and are explicitly NOT
-- idempotent — a NULL event id dedupes nothing.
ALTER TABLE mistake_record ADD COLUMN IF NOT EXISTS last_event_id TEXT;

CREATE TABLE IF NOT EXISTS mistake_capture_event (
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  captured_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, event_id)
);

CREATE TABLE IF NOT EXISTS mistake_classification (
  owner_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  subject TEXT,
  grade_semester TEXT,
  source TEXT NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, stage_id)
);
`;

export async function ensureMistakeBookSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(MISTAKE_BOOK_PG_SCHEMA)) {
    await queryable.query(statement);
  }
}

interface RawMistakeRow extends Record<string, unknown> {
  owner_id: string;
  stage_id: string;
  scene_id: string;
  question_id: string;
  stage_name: string;
  scene_title: string | null;
  scene_order: number | null;
  subject: string | null;
  grade_semester: string | null;
  question_type: string;
  question: string;
  options: unknown;
  correct_answer: unknown;
  analysis: string | null;
  knowledge_point: string | null;
  last_user_answer: unknown;
  wrong_count: number | string;
  first_wrong_at: number | string;
  last_wrong_at: number | string;
  mastered_at: number | string | null;
}

const MISTAKE_COLUMNS = `owner_id,
  stage_id,
  scene_id,
  question_id,
  stage_name,
  scene_title,
  scene_order,
  subject,
  grade_semester,
  question_type,
  question,
  options,
  correct_answer,
  analysis,
  knowledge_point,
  last_user_answer,
  wrong_count,
  first_wrong_at,
  last_wrong_at,
  mastered_at`;

function rowToRecord(row: RawMistakeRow): MistakeRecord {
  return {
    ownerId: row.owner_id,
    stageId: row.stage_id,
    sceneId: row.scene_id,
    questionId: row.question_id,
    stageName: row.stage_name,
    sceneTitle: row.scene_title,
    sceneOrder: row.scene_order === null ? null : Number(row.scene_order),
    subject: row.subject ?? null,
    gradeSemester: row.grade_semester ?? null,
    questionType: row.question_type as MistakeQuestionType,
    question: row.question,
    options: row.options ?? null,
    correctAnswer: row.correct_answer ?? null,
    analysis: row.analysis,
    knowledgePoint: row.knowledge_point ?? null,
    lastUserAnswer: row.last_user_answer,
    wrongCount: Number(row.wrong_count),
    firstWrongAt: Number(row.first_wrong_at),
    lastWrongAt: Number(row.last_wrong_at),
    masteredAt: row.mastered_at === null ? null : Number(row.mastered_at),
  };
}

export function mistakeRecordView(record: MistakeRecord): MistakeRecordView {
  return {
    stageId: record.stageId,
    stageName: record.stageName,
    sceneId: record.sceneId,
    sceneTitle: record.sceneTitle,
    sceneOrder: record.sceneOrder,
    subject: record.subject,
    gradeSemester: record.gradeSemester,
    questionId: record.questionId,
    questionType: record.questionType,
    question: record.question,
    options: record.options,
    correctAnswer: record.correctAnswer,
    analysis: record.analysis,
    knowledgePoint: record.knowledgePoint,
    lastUserAnswer: record.lastUserAnswer,
    wrongCount: record.wrongCount,
    firstWrongAt: new Date(record.firstWrongAt).toISOString(),
    lastWrongAt: new Date(record.lastWrongAt).toISOString(),
    masteredAt: record.masteredAt === null ? null : new Date(record.masteredAt).toISOString(),
  };
}

// ── Classification authority ─────────────────────────────────────────────────

export type ClassificationSource = 'manual' | 'inferred';

export interface StageClassification {
  subject: string | null;
  gradeSemester: string | null;
  source: ClassificationSource;
  updatedAt: number;
}

interface RawClassificationRow extends Record<string, unknown> {
  subject: string | null;
  grade_semester: string | null;
  source: string;
  updated_at: number | string;
}

/**
 * Tri-state classification patch: an omitted field keeps the current value,
 * `null` clears it, a valid code sets it. Normalization to the canonical
 * taxonomy happens at the API boundary; the store trusts its inputs.
 */
export interface ClassificationPatch {
  subject?: string | null;
  gradeSemester?: string | null;
}

/** The advisory-lock domain shared by capture and classify for one (owner, stage). */
function classificationLockKey(ownerId: string, stageId: string): string {
  return `mistake-classification:${ownerId}:${stageId}`;
}

/**
 * The advisory-lock domain of one capture EVENT (R9): (owner, eventId). The
 * event receipt's uniqueness lives on this key, NOT on the stage — the same
 * event id arriving under two different stages must serialize here so the
 * second transaction sees the first's committed receipt and answers
 * duplicate/conflict instead of racing past an INSERT ... DO NOTHING.
 */
function captureEventLockKey(ownerId: string, eventId: string): string {
  return `mistake-capture-event:${ownerId}:${eventId}`;
}

async function lockCaptureEvent(
  client: PoolClientLike,
  ownerId: string,
  eventId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    captureEventLockKey(ownerId, eventId),
  ]);
}

/** A Queryable view over one checked-out pool client (the open transaction). */
function queryableForClient(client: PoolClientLike): Queryable {
  return {
    async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await client.query(text, params);
      return { rows: result.rows as TRow[] };
    },
  };
}

async function lockClassificationDomain(
  client: PoolClientLike,
  ownerId: string,
  stageId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    classificationLockKey(ownerId, stageId),
  ]);
}

async function loadClassification(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
): Promise<StageClassification | null> {
  const result = await queryable.query(
    'SELECT subject, grade_semester, source, updated_at FROM mistake_classification WHERE owner_id = $1 AND stage_id = $2',
    [ownerId, stageId],
  );
  const row = (result.rows as RawClassificationRow[])[0];
  if (!row) return null;
  return {
    subject: row.subject ?? null,
    gradeSemester: row.grade_semester ?? null,
    source: row.source === 'manual' ? 'manual' : 'inferred',
    updatedAt: Number(row.updated_at),
  };
}

async function writeClassification(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
  classification: StageClassification,
): Promise<void> {
  await queryable.query(
    `INSERT INTO mistake_classification (owner_id, stage_id, subject, grade_semester, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_id, stage_id) DO UPDATE SET
       subject = EXCLUDED.subject,
       grade_semester = EXCLUDED.grade_semester,
       source = EXCLUDED.source,
       updated_at = EXCLUDED.updated_at`,
    [
      ownerId,
      stageId,
      classification.subject,
      classification.gradeSemester,
      classification.source,
      classification.updatedAt,
    ],
  );
}

async function syncStageMistakeClassification(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
  subject: string | null,
  gradeSemester: string | null,
): Promise<number> {
  const result = await queryable.query(
    `UPDATE mistake_record
     SET subject = $3, grade_semester = $4
     WHERE owner_id = $1 AND stage_id = $2
     RETURNING question_id`,
    [ownerId, stageId, subject, gradeSemester],
  );
  return result.rows.length;
}

/**
 * What the owner's own data already says about one classification field,
 * BEFORE any client snapshot is considered. Exactly one distinct non-null
 * value = that value (a known decision); more than one = `conflict` (legacy
 * rows disagree — conservative null, recorded, never a random pick).
 */
interface FieldConsensus {
  value: string | null;
  conflict: boolean;
  known: boolean;
}

async function mistakeFieldConsensus(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
): Promise<{ subject: FieldConsensus; gradeSemester: FieldConsensus }> {
  const result = await queryable.query<{ subject: string | null; grade_semester: string | null }>(
    `SELECT DISTINCT subject, grade_semester FROM mistake_record
     WHERE owner_id = $1 AND stage_id = $2 AND (subject IS NOT NULL OR grade_semester IS NOT NULL)`,
    [ownerId, stageId],
  );
  const subjectValues = new Set<string>();
  const gradeValues = new Set<string>();
  for (const row of result.rows) {
    if (row.subject !== null) subjectValues.add(row.subject);
    if (row.grade_semester !== null) gradeValues.add(row.grade_semester);
  }
  const consensus = (values: Set<string>): FieldConsensus => {
    if (values.size === 1) return { value: [...values][0]!, conflict: false, known: true };
    if (values.size > 1) return { value: null, conflict: true, known: true };
    return { value: null, conflict: false, known: false };
  };
  return { subject: consensus(subjectValues), gradeSemester: consensus(gradeValues) };
}

/** Merge a course-carried value into a rows-derived consensus for one field. */
function mergeCourseValue(
  consensus: FieldConsensus,
  courseValue: string | null | undefined,
): FieldConsensus {
  if (courseValue == null || consensus.known) return consensus;
  return { value: courseValue, conflict: false, known: true };
}

/**
 * Upsert one graded batch, under the classification lock domain and in ONE
 * transaction with the authority handling. Re-answering the same question
 * wrong bumps `wrong_count`, refreshes the question snapshot, and clears
 * `mastered_at` so the question rejoins the unmastered pool.
 *
 * Classification follows the authority: when a row exists (manual or
 * inferred), its values win over the capture payload — an old retry payload
 * or a stale page can never regress a recorded decision. When no authority
 * exists (a legacy, pre-upgrade database), initialization reads the OWNER'S
 * EXISTING ROWS first: one distinct known value per field wins over the
 * incoming snapshot, disagreeing values resolve conservatively to NULL (and
 * the resolution is recorded), and the snapshot only fills fields nobody
 * has decided yet. All questions are always kept — only their grouping
 * unifies.
 */
export interface MistakeCaptureReceipt {
  /** Question ids newly captured (first ever) in this event. */
  created: string[];
  /** Question ids whose wrong_count incremented in this event. */
  counted: string[];
  /** Question ids skipped as exact replays of an already-committed event. */
  duplicates: string[];
}

const PAYLOAD_HASH_VERSION = 'v2';

/**
 * Canonical serialization for the payload hash (implementation review):
 * object keys are sorted RECURSIVELY — a JSONB round-trip on the server may
 * legally reorder the keys inside options/userAnswer, and semantically
 * identical payloads must hash identically — while array order is preserved
 * (it is data). Every persisted field still participates; nothing is dropped.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * Structured, order-stable serialization of everything an event PERSISTS —
 * the stage/scene identity AND display fields it writes (stageName,
 * sceneTitle, sceneOrder), the classification snapshot it shipped, and every
 * item's full content. SHA-256 over that canonical JSON is the conflict
 * fingerprint: no delimiter-collision ambiguity, and a renamed stage under
 * the same event id is a CONFLICT, not an exact replay.
 *
 * Exported for the hash-compatibility regression test: fields added after
 * the first release (knowledgePoint) must be emitted conditionally so an
 * event frozen BEFORE the field exists keeps hashing identically on replay.
 */
export function canonicalEventContent(
  context: MistakeCaptureContext,
  items: readonly MistakeCaptureItem[],
): unknown {
  return {
    v: PAYLOAD_HASH_VERSION,
    stage: {
      id: context.stageId,
      name: context.stageName,
      sceneId: context.sceneId,
      sceneTitle: context.sceneTitle ?? null,
      sceneOrder: context.sceneOrder ?? null,
      subject: context.subject ?? null,
      gradeSemester: context.gradeSemester ?? null,
    },
    items: items.map((item) => ({
      questionId: item.questionId,
      questionType: item.questionType,
      question: item.question,
      options: item.options ?? null,
      correctAnswer: item.correctAnswer ?? null,
      analysis: item.analysis ?? null,
      // Emitted ONLY when the payload carries it: events frozen before this
      // field existed must keep hashing identically on replay, or every
      // legacy outbox event would report a payload conflict after upgrade.
      ...(item.knowledgePoint !== undefined ? { knowledgePoint: item.knowledgePoint } : {}),
      userAnswer: item.userAnswer ?? null,
    })),
  };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function captureEventHash(
  context: MistakeCaptureContext,
  items: readonly MistakeCaptureItem[],
): Promise<string> {
  return sha256Hex(stableStringify(canonicalEventContent(context, items)));
}

export async function captureMistakes(
  pool: TransactionSource,
  ownerId: string,
  context: MistakeCaptureContext,
  items: readonly MistakeCaptureItem[],
  options: { eventIds?: readonly (string | undefined)[] } = {},
): Promise<MistakeCaptureReceipt> {
  const client = await pool.connect();
  const queryable = queryableForClient(client);
  try {
    await client.query('BEGIN');
    try {
      await lockClassificationDomain(client, ownerId, context.stageId);
      const authority = await loadClassification(queryable, ownerId, context.stageId);

      let effectiveSubject: string | null;
      let effectiveGrade: string | null;
      let recordResolution = false;
      if (authority) {
        effectiveSubject = authority.subject;
        effectiveGrade = authority.gradeSemester;
      } else {
        const consensus = await mistakeFieldConsensus(queryable, ownerId, context.stageId);
        // Known decisions (or a recorded conflict) beat the snapshot; the
        // snapshot only initializes fields nobody has spoken on. Either way
        // the outcome is recorded as the inferred authority so later captures
        // stay deterministic — nothing flaps, nothing regresses.
        effectiveSubject = consensus.subject.known
          ? consensus.subject.value
          : (context.subject ?? null);
        effectiveGrade = consensus.gradeSemester.known
          ? consensus.gradeSemester.value
          : (context.gradeSemester ?? null);
        recordResolution =
          consensus.subject.known ||
          consensus.gradeSemester.known ||
          effectiveSubject !== null ||
          effectiveGrade !== null;
      }

      const now = Date.now();
      const receipt: MistakeCaptureReceipt = { created: [], counted: [], duplicates: [] };
      // Event ids default to the items' own contract (each item carries its
      // stable eventId); an explicit array overrides (route normalization).
      const eventIds = options.eventIds ?? items.map((item) => item.eventId);

      // Batch-level validation BEFORE any write (R9): a duplicate question id
      // inside one batch is a malformed single answer, not two events — the
      // whole batch is refused (duplicate EVENT ids land here too, since one
      // question-event id equals one question identity per batch).
      if (new Set(items.map((item) => item.questionId)).size !== items.length) {
        throw new Error('DUPLICATE_QUESTION_IN_BATCH');
      }

      // Event locks (R9): every event id in this batch is locked in its own
      // (owner, eventId) domain — SORTED, so two batches sharing ids always
      // lock in the same order and cannot deadlock. Locking BEFORE the
      // receipt INSERT means a racing same-id transaction waits here, then
      // sees the winner's committed receipt below: no DO NOTHING blind spot.
      const batchEventIds = [
        ...new Set((eventIds ?? []).filter((id): id is string => id !== undefined)),
      ].sort();
      for (const eventId of batchEventIds) {
        await lockCaptureEvent(client, ownerId, eventId);
      }

      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        const eventId = eventIds?.[index];

        // Event-level dedupe/conflict (owner-scoped). No eventId = legacy
        // payload: no idempotence claim, always processed.
        if (eventId !== undefined) {
          const hash = await captureEventHash(context, [item]);
          const seen = await queryable.query<{ payload_hash: string } & Record<string, unknown>>(
            'SELECT payload_hash FROM mistake_capture_event WHERE owner_id = $1 AND event_id = $2',
            [ownerId, eventId],
          );
          const prior = seen.rows[0];
          if (prior) {
            if (prior.payload_hash !== hash) {
              // Same event id shipping different content is a caller bug or
              // corruption — refuse loudly, never overwrite.
              throw new Error('EVENT_PAYLOAD_CONFLICT');
            }
            receipt.duplicates.push(item.questionId); // exact replay: no-op
            continue;
          }
          // Winner check: only the transaction that actually CREATED the
          // receipt may process the event. A lost race would otherwise write
          // the mistake row a second time after DO NOTHING swallowed its
          // insert.
          const inserted = await queryable.query<{ event_id: string } & Record<string, unknown>>(
            `INSERT INTO mistake_capture_event (owner_id, event_id, payload_hash, captured_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (owner_id, event_id) DO NOTHING
             RETURNING event_id`,
            [ownerId, eventId, hash, now],
          );
          if (inserted.rows.length === 0) {
            // Lost the race (possible when callers bypass the lock): re-read
            // the winner's receipt and judge duplicate/conflict against it.
            const winner = await queryable.query<
              { payload_hash: string } & Record<string, unknown>
            >(
              'SELECT payload_hash FROM mistake_capture_event WHERE owner_id = $1 AND event_id = $2',
              [ownerId, eventId],
            );
            if (winner.rows[0] && winner.rows[0].payload_hash !== hash) {
              throw new Error('EVENT_PAYLOAD_CONFLICT');
            }
            receipt.duplicates.push(item.questionId);
            continue;
          }
        }

        const result = await client.query(
          `INSERT INTO mistake_record (
            owner_id, stage_id, scene_id, question_id,
            stage_name, scene_title, scene_order, subject, grade_semester,
            question_type, question, options, correct_answer, analysis, knowledge_point,
            last_user_answer, wrong_count, first_wrong_at, last_wrong_at, mastered_at, last_event_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1, $17, $17, NULL, $18)
          ON CONFLICT (owner_id, stage_id, scene_id, question_id) DO UPDATE SET
            stage_name = EXCLUDED.stage_name,
            scene_title = EXCLUDED.scene_title,
            scene_order = EXCLUDED.scene_order,
            subject = EXCLUDED.subject,
            grade_semester = EXCLUDED.grade_semester,
            question_type = EXCLUDED.question_type,
            question = EXCLUDED.question,
            options = EXCLUDED.options,
            correct_answer = EXCLUDED.correct_answer,
            analysis = EXCLUDED.analysis,
            -- COALESCE on purpose: an event that ships no knowledge point
            -- (legacy capture, original-question retry of a pre-upgrade
            -- record) must not erase a point an earlier event recorded.
            knowledge_point = COALESCE(EXCLUDED.knowledge_point, mistake_record.knowledge_point),
            last_user_answer = EXCLUDED.last_user_answer,
            wrong_count = mistake_record.wrong_count + 1,
            last_wrong_at = EXCLUDED.last_wrong_at,
            mastered_at = NULL,
            last_event_id = EXCLUDED.last_event_id
          RETURNING (xmax = 0) AS inserted`,
          [
            ownerId,
            context.stageId,
            context.sceneId,
            item.questionId,
            context.stageName,
            context.sceneTitle ?? null,
            context.sceneOrder ?? null,
            effectiveSubject,
            effectiveGrade,
            item.questionType,
            item.question,
            item.options === undefined ? null : encodeJson(item.options, 'mistake options'),
            item.correctAnswer === undefined
              ? null
              : encodeJson(item.correctAnswer, 'mistake correctAnswer'),
            item.analysis ?? null,
            item.knowledgePoint ?? null,
            encodeJson(item.userAnswer, 'mistake userAnswer'),
            now,
            eventId ?? null,
          ],
        );
        const inserted = (result.rows[0] as { inserted: boolean } | undefined)?.inserted;
        if (inserted) receipt.created.push(item.questionId);
        else receipt.counted.push(item.questionId);
      }

      // Keep every row of the stage on one classification once a decision is
      // known — including rows written before the authority table existed.
      if (authority || recordResolution) {
        if (!authority) {
          await writeClassification(queryable, ownerId, context.stageId, {
            subject: effectiveSubject,
            gradeSemester: effectiveGrade,
            source: 'inferred',
            updatedAt: now,
          });
        }
        await syncStageMistakeClassification(
          queryable,
          ownerId,
          context.stageId,
          effectiveSubject,
          effectiveGrade,
        );
      }

      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

export interface ClassifyStageOutcome {
  /** False when no authority, no mistake rows, and no updatable course exist. */
  matched: boolean;
  classification: StageClassification | null;
  mistakeRows: number;
  /** True when the owner's live server-side course metadata was updated. */
  courseUpdated: boolean;
}

/**
 * Test-only failure injection points around each write phase; each hook runs
 * INSIDE the open transaction, so a thrown error proves rollback atomicity.
 */
export interface ClassificationFaults {
  beforeAuthorityWrite?: () => void | Promise<void>;
  beforeMistakeUpdate?: () => void | Promise<void>;
  beforeCourseUpdate?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
}

interface StageMetaOwnershipRow extends Record<string, unknown> {
  owner_id: string;
  deleted_at: Date | string | null;
}

/**
 * The single server-side classification command: authority + the owner's
 * mistake rows + (when the course exists on the server, belongs to this
 * owner, and is alive) the course metadata — one transaction, one
 * checked-out connection, one lock domain shared with capture. Requires only
 * the persistence provider, never the agent runtime; a deleted or
 * browser-local course simply means `courseUpdated: false`.
 */
export async function applyStageClassification(
  pool: TransactionSource,
  input: { ownerId: string; stageId: string },
  patch: ClassificationPatch,
  faults: ClassificationFaults = {},
): Promise<ClassifyStageOutcome> {
  const client = await pool.connect();
  const queryable = queryableForClient(client);
  try {
    await client.query('BEGIN');
    try {
      await lockClassificationDomain(client, input.ownerId, input.stageId);

      const authority = await loadClassification(queryable, input.ownerId, input.stageId);
      const mistakes = await queryable.query(
        'SELECT question_id FROM mistake_record WHERE owner_id = $1 AND stage_id = $2',
        [input.ownerId, input.stageId],
      );
      // Same gate the owner-bound store enforces on mutations: the stage_meta
      // row, locked FOR UPDATE, decides ownership and liveness. No row (never
      // claimed, or a browser-local classic course) means no course update.
      const stageMeta = await queryable.query<StageMetaOwnershipRow & Record<string, unknown>>(
        'SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1 FOR UPDATE',
        [input.stageId],
      );
      const metaRow = stageMeta.rows[0];
      const courseUpdatable =
        !!metaRow && metaRow.owner_id === input.ownerId && metaRow.deleted_at === null;

      if (!authority && mistakes.rows.length === 0 && !courseUpdatable) {
        // Defined no-match: nothing of this owner's exists for the stage.
        await client.query('COMMIT');
        return {
          matched: false,
          classification: null,
          mistakeRows: 0,
          courseUpdated: false,
        };
      }

      // Baseline for OMITTED fields, in priority order: a recorded authority,
      // then the owner's own known data — existing mistake rows' consensus,
      // merged with the live course's carried classification when only that
      // exists. A legacy database with rows but no authority therefore keeps
      // its known subject/grade on a single-field manual patch, and a
      // live-course-only stage reads the course's own values. Conflicting
      // known values resolve conservatively to null.
      let baselineSubject: string | null;
      let baselineGrade: string | null;
      if (authority) {
        baselineSubject = authority.subject;
        baselineGrade = authority.gradeSemester;
      } else {
        const consensus = await mistakeFieldConsensus(queryable, input.ownerId, input.stageId);
        let courseSubject: string | null = null;
        let courseGrade: string | null = null;
        if (courseUpdatable) {
          const existing = await queryable.query<{ data: Record<string, unknown> }>(
            'SELECT data FROM document_stages WHERE id = $1 AND owner_id = $2',
            [input.stageId, input.ownerId],
          );
          const data = existing.rows[0]?.data;
          if (data) {
            if (typeof data.subject === 'string') courseSubject = data.subject;
            if (typeof data.gradeSemester === 'string') courseGrade = data.gradeSemester;
          }
        }
        baselineSubject = mergeCourseValue(consensus.subject, courseSubject).value;
        baselineGrade = mergeCourseValue(consensus.gradeSemester, courseGrade).value;
      }

      const nextSubject = patch.subject === undefined ? baselineSubject : patch.subject;
      const nextGrade = patch.gradeSemester === undefined ? baselineGrade : patch.gradeSemester;
      const next: StageClassification = {
        subject: nextSubject,
        gradeSemester: nextGrade,
        source: 'manual',
        updatedAt: Date.now(),
      };

      await faults.beforeAuthorityWrite?.();
      await writeClassification(queryable, input.ownerId, input.stageId, next);
      await faults.beforeMistakeUpdate?.();
      const mistakeRows = await syncStageMistakeClassification(
        queryable,
        input.ownerId,
        input.stageId,
        next.subject,
        next.gradeSemester,
      );

      await faults.beforeCourseUpdate?.();
      let courseUpdated = false;
      if (courseUpdatable) {
        // Reuse the package document store PINNED to this transaction (the
        // same single-use construction owner-bound uses internally): full
        // stage validation, DSL version checks, and asset-reference sync all
        // join this transaction instead of opening their own.
        const pinned = new PgDocumentStore<never, StageLike>(queryable, {
          ownerId: input.ownerId,
          validateScene: validateAppScene,
          validateStage: validateAppStage,
          trackAssetReferences: true,
          withTransaction: (body) => body(queryable),
        });
        const document = await pinned.loadDocument(input.stageId);
        if (document) {
          // The course carries the FINAL effective classification — never a
          // half-patched mix that could keep disagreeing with the authority —
          // and the server modification time advances in the same write.
          const stage: Record<string, unknown> = { ...document.stage };
          if (next.subject === null) delete stage.subject;
          else stage.subject = next.subject;
          if (next.gradeSemester === null) delete stage.gradeSemester;
          else stage.gradeSemester = next.gradeSemester;
          stage.updatedAt = Date.now();
          await pinned.putStage(input.stageId, stage as unknown as StageLike);
          courseUpdated = true;
        }
      }

      await faults.beforeCommit?.();
      await client.query('COMMIT');
      return { matched: true, classification: next, mistakeRows, courseUpdated };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function listMistakes(
  queryable: Queryable,
  ownerId: string,
  options: { filter?: MistakeListFilter; stageId?: string } = {},
): Promise<MistakeRecord[]> {
  const filter = options.filter ?? 'all';
  const conditions = ['owner_id = $1'];
  const params: unknown[] = [ownerId];
  if (options.stageId) {
    params.push(options.stageId);
    conditions.push(`stage_id = $${params.length}`);
  }
  if (filter === 'unmastered') conditions.push('mastered_at IS NULL');
  if (filter === 'mastered') conditions.push('mastered_at IS NOT NULL');

  const result = await queryable.query(
    `SELECT ${MISTAKE_COLUMNS}
     FROM mistake_record
     WHERE ${conditions.join(' AND ')}
     ORDER BY last_wrong_at DESC`,
    params,
  );
  return (result.rows as RawMistakeRow[]).map((row) => rowToRecord(row));
}

/** Key of one mistake row, as accepted by update/delete operations. */
export interface MistakeKey {
  stageId: string;
  sceneId: string;
  questionId: string;
}

export async function setMistakeMastered(
  queryable: Queryable,
  ownerId: string,
  key: MistakeKey,
  mastered: boolean,
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE mistake_record
     SET mastered_at = $5
     WHERE owner_id = $1 AND stage_id = $2 AND scene_id = $3 AND question_id = $4
     RETURNING question_id`,
    [ownerId, key.stageId, key.sceneId, key.questionId, mastered ? Date.now() : null],
  );
  return result.rows.length > 0;
}

export async function deleteMistake(
  queryable: Queryable,
  ownerId: string,
  key: MistakeKey,
): Promise<boolean> {
  const result = await queryable.query(
    `DELETE FROM mistake_record
     WHERE owner_id = $1 AND stage_id = $2 AND scene_id = $3 AND question_id = $4
     RETURNING question_id`,
    [ownerId, key.stageId, key.sceneId, key.questionId],
  );
  return result.rows.length > 0;
}

export async function deleteStageMistakes(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
): Promise<number> {
  const result = await queryable.query(
    'DELETE FROM mistake_record WHERE owner_id = $1 AND stage_id = $2 RETURNING question_id',
    [ownerId, stageId],
  );
  return result.rows.length;
}

export async function deleteAllMistakes(queryable: Queryable, ownerId: string): Promise<number> {
  const result = await queryable.query(
    'DELETE FROM mistake_record WHERE owner_id = $1 RETURNING question_id',
    [ownerId],
  );
  return result.rows.length;
}
