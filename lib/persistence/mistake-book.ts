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
 * Same raw-SQL pattern as `owner-materials.ts`: a pinned
 * `CREATE TABLE IF NOT EXISTS` schema ensured at provider bootstrap, and
 * owner-scoped queries. Upserts keep the natural composite key
 * (owner, stage, scene, question) — answering the same question wrong again
 * bumps `wrong_count`, refreshes the snapshot, and clears `mastered_at`, so a
 * lapsed question returns to the unmastered pool on its own.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';

export const MISTAKE_QUESTION_TYPES = ['single', 'multiple', 'short_answer'] as const;
export type MistakeQuestionType = (typeof MISTAKE_QUESTION_TYPES)[number];

export type MistakeListFilter = 'all' | 'unmastered' | 'mastered';

/** One wrong answer, as sent by the client right after a quiz review. */
export interface MistakeCaptureItem {
  questionId: string;
  questionType: MistakeQuestionType;
  question: string;
  /** QuizOption[] snapshot; absent for short answers. */
  options?: unknown;
  /** Correct answer values; absent for short answers. */
  correctAnswer?: unknown;
  analysis?: string;
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
    lastUserAnswer: record.lastUserAnswer,
    wrongCount: record.wrongCount,
    firstWrongAt: new Date(record.firstWrongAt).toISOString(),
    lastWrongAt: new Date(record.lastWrongAt).toISOString(),
    masteredAt: record.masteredAt === null ? null : new Date(record.masteredAt).toISOString(),
  };
}

/**
 * Upsert one graded batch. Re-answering the same question wrong bumps
 * `wrong_count`, refreshes the question snapshot (courses get edited), and
 * clears `mastered_at` so the question rejoins the unmastered pool.
 */
export async function captureMistakes(
  queryable: Queryable,
  ownerId: string,
  context: MistakeCaptureContext,
  items: readonly MistakeCaptureItem[],
): Promise<void> {
  const now = Date.now();
  for (const item of items) {
    await queryable.query(
      `INSERT INTO mistake_record (
        owner_id, stage_id, scene_id, question_id,
        stage_name, scene_title, scene_order, subject, grade_semester,
        question_type, question, options, correct_answer, analysis,
        last_user_answer, wrong_count, first_wrong_at, last_wrong_at, mastered_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, $16, NULL)
      ON CONFLICT (owner_id, stage_id, scene_id, question_id) DO UPDATE SET
        stage_name = EXCLUDED.stage_name,
        scene_title = EXCLUDED.scene_title,
        scene_order = EXCLUDED.scene_order,
        -- A capture from an unclassified stage (NULL) must not erase a manual
        -- classification a previous capture or the classify endpoint recorded.
        subject = COALESCE(EXCLUDED.subject, mistake_record.subject),
        grade_semester = COALESCE(EXCLUDED.grade_semester, mistake_record.grade_semester),
        question_type = EXCLUDED.question_type,
        question = EXCLUDED.question,
        options = EXCLUDED.options,
        correct_answer = EXCLUDED.correct_answer,
        analysis = EXCLUDED.analysis,
        last_user_answer = EXCLUDED.last_user_answer,
        wrong_count = mistake_record.wrong_count + 1,
        last_wrong_at = EXCLUDED.last_wrong_at,
        mastered_at = NULL`,
      [
        ownerId,
        context.stageId,
        context.sceneId,
        item.questionId,
        context.stageName,
        context.sceneTitle ?? null,
        context.sceneOrder ?? null,
        context.subject ?? null,
        context.gradeSemester ?? null,
        item.questionType,
        item.question,
        item.options === undefined ? null : encodeJson(item.options, 'mistake options'),
        item.correctAnswer === undefined
          ? null
          : encodeJson(item.correctAnswer, 'mistake correctAnswer'),
        item.analysis ?? null,
        encodeJson(item.userAnswer, 'mistake userAnswer'),
        now,
      ],
    );
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

/**
 * Bulk-set the curriculum classification of every mistake of one stage (the
 * manual-classify path: the caller also updates the stage metadata, so future
 * captures agree with the manual choice). Returns the number of rows updated.
 */
export async function classifyStageMistakes(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
  classification: { subject?: string; gradeSemester?: string },
): Promise<number> {
  const result = await queryable.query(
    `UPDATE mistake_record
     SET subject = $3, grade_semester = $4
     WHERE owner_id = $1 AND stage_id = $2
     RETURNING question_id`,
    [ownerId, stageId, classification.subject ?? null, classification.gradeSemester ?? null],
  );
  return result.rows.length;
}
