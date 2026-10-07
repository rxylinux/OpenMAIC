/**
 * Real-SQL isolation tests for the classification store (Batch A, R1-R4 of
 * the remediation contract). Runs against PGlite — a real PostgreSQL, so the
 * SQL semantics under test (advisory locks, ON CONFLICT, FOR UPDATE,
 * transactions, rollback) are the genuine ones. All data is synthetic inside
 * the throwaway in-memory database; nothing touches a deployment or real
 * user rows.
 *
 * R1 classification must not depend on the agent runtime or the course being
 * alive; R2 the classify command must be atomic across authority + mistake
 * rows + course metadata; R3 the classification authority must defeat stale
 * capture payloads; R4 tri-state patch semantics (omit = keep, null = clear,
 * code = set).
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { Queryable } from '@openmaic/storage/document/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  applyStageClassification,
  captureMistakes,
  ensureMistakeBookSchema,
  listMistakes,
  type ClassificationPatch,
  type MistakeCaptureContext,
  type MistakeCaptureItem,
} from '@/lib/persistence/mistake-book';

/** The node-postgres pool surface, backed by the single-connection PGlite. */
class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
    const result = await this.db.query<TRow>(text, params);
    return { rows: (result.rows ?? []) as TRow[] };
  }

  async connect() {
    return {
      query: async <TRow extends Record<string, unknown>>(text: string, params?: unknown[]) => {
        const result = await this.db.query<TRow>(text, params);
        return { rows: (result.rows ?? []) as TRow[] };
      },
      release: () => {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const OWNER_A = 'owner-alpha';
const OWNER_B = 'owner-beta';

const CONTEXT = (stageId: string, sceneId = 'sc1'): MistakeCaptureContext => ({
  stageId,
  stageName: '合成课堂',
  sceneId,
  sceneTitle: '课后练习',
  sceneOrder: 9,
});

const ITEM = (questionId: string): MistakeCaptureItem => ({
  questionId,
  questionType: 'single',
  question: `1+1=? (${questionId})`,
  correctAnswer: ['B'],
  userAnswer: 'A',
});

describe('mistake book classification store (real SQL, PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  const queryable = (): Queryable => ({
    query: (text, params) => pool.query(text as never, params) as never,
  });

  beforeAll(async () => {
    db = new PGlite();
    pool = new PGlitePool(db);
    // The schema set the provider ensures at bootstrap; the document store's
    // putStage path (asset-reference sync) needs the asset tables too.
    await ensureDocumentSchema(queryable());
    await ensureStageMetaSchema(queryable());
    await ensureAssetSchema(queryable());
    await ensureMistakeBookSchema(queryable());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE mistake_record, mistake_classification, document_stages, document_scenes, document_outlines, stage_meta CASCADE' as never,
    );
  });

  function ownerStore(ownerId: string) {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  }

  /** Seed a live server-side course for an owner; returns its stage object. */
  async function seedCourse(ownerId: string, stageId: string, name: string) {
    const now = Date.now();
    await ownerStore(ownerId).saveDocument({
      stage: { id: stageId, name, createdAt: now, updatedAt: now },
      scenes: [],
    } as never);
  }

  async function stageData(stageId: string): Promise<Record<string, unknown> | null> {
    const result = await pool.query<{ data: Record<string, unknown> } & Record<string, unknown>>(
      'SELECT data FROM document_stages WHERE id = $1',
      [stageId],
    );
    return result.rows[0]?.data ?? null;
  }

  async function authorityRow(
    ownerId: string,
    stageId: string,
  ): Promise<{ subject: string | null; grade_semester: string | null; source: string } | null> {
    const result = await pool.query<
      { subject: string | null; grade_semester: string | null; source: string } & Record<
        string,
        unknown
      >
    >(
      'SELECT subject, grade_semester, source FROM mistake_classification WHERE owner_id = $1 AND stage_id = $2',
      [ownerId, stageId],
    );
    return result.rows[0] ?? null;
  }

  const rowsOf = async (ownerId: string, stageId: string) =>
    (await listMistakes(queryable(), ownerId, { stageId, filter: 'all' })).map((record) => ({
      questionId: record.questionId,
      subject: record.subject,
      gradeSemester: record.gradeSemester,
    }));

  // ── R1: no agent-runtime dependency, course may be deleted or never existed ──

  it('R1: classifies mistakes when the course never existed server-side (browser-local classic course)', async () => {
    await captureMistakes(pool, OWNER_A, CONTEXT('s1'), [ITEM('q1'), ITEM('q2')]);

    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's1' },
      {
        subject: 'math',
        gradeSemester: 'grade-1-up',
      },
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.courseUpdated).toBe(false);
    expect(outcome.mistakeRows).toBe(2);
    expect(await rowsOf(OWNER_A, 's1')).toEqual([
      { questionId: 'q1', subject: 'math', gradeSemester: 'grade-1-up' },
      { questionId: 'q2', subject: 'math', gradeSemester: 'grade-1-up' },
    ]);
    expect(await authorityRow(OWNER_A, 's1')).toMatchObject({
      subject: 'math',
      grade_semester: 'grade-1-up',
      source: 'manual',
    });
  });

  it('R1: classifies retained mistakes after the course was deleted (tombstoned)', async () => {
    await seedCourse(OWNER_A, 's2', '被删的课');
    await captureMistakes(pool, OWNER_A, CONTEXT('s2'), [ITEM('q1')]);
    await ownerStore(OWNER_A).deleteDocument('s2');

    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's2' },
      {
        subject: 'chinese',
      },
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.courseUpdated).toBe(false); // tombstoned: no course write
    expect((await rowsOf(OWNER_A, 's2'))[0]!.subject).toBe('chinese');
  });

  it('R1: updates the live owner course metadata in the same command; never a foreign owner course', async () => {
    await seedCourse(OWNER_A, 's3', 'A 的课');
    await seedCourse(OWNER_B, 's3b', 'B 的课');
    await captureMistakes(pool, OWNER_A, CONTEXT('s3'), [ITEM('q1')]);
    await captureMistakes(pool, OWNER_B, CONTEXT('s3b'), [ITEM('q1')]);

    const mine = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's3' },
      {
        subject: 'math',
        gradeSemester: 'grade-2-up',
      },
    );
    expect(mine.courseUpdated).toBe(true);
    expect((await stageData('s3'))!.subject).toBe('math');
    expect((await stageData('s3'))!.gradeSemester).toBe('grade-2-up');

    // Same stageId owned by B: A has neither mistakes nor authority there → no match.
    const foreignStageId = 's3b';
    const foreign = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: foreignStageId },
      {
        subject: 'math',
      },
    );
    expect(foreign.matched).toBe(false);
    // B's course metadata untouched by A's attempt.
    expect((await stageData('s3b'))!.subject).toBeUndefined();
  });

  it('R1: a foreign-owned stage id with A-owned mistakes updates only the mistakes, not the course', async () => {
    await seedCourse(OWNER_B, 's4', 'B 的课');
    // A somehow captured mistakes under the same stage id (e.g. a shared
    // classroom played back in A's browser).
    await captureMistakes(pool, OWNER_A, CONTEXT('s4'), [ITEM('q1')]);

    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's4' },
      {
        subject: 'english',
      },
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.courseUpdated).toBe(false);
    expect((await rowsOf(OWNER_A, 's4'))[0]!.subject).toBe('english');
    expect((await stageData('s4'))!.subject).toBeUndefined(); // B's course untouched
  });

  it('R1: an unknown stage with nothing of the owner answers no-match', async () => {
    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 'ghost' },
      {
        subject: 'math',
      },
    );
    expect(outcome.matched).toBe(false);
    expect(await authorityRow(OWNER_A, 'ghost')).toBeNull(); // nothing dangling written
  });

  // ── R2: atomicity under injected mid-transaction failures ──

  it('R2: failure before the authority write rolls back everything', async () => {
    await seedCourse(OWNER_A, 's5', '课');
    await captureMistakes(pool, OWNER_A, CONTEXT('s5'), [ITEM('q1')]);

    await expect(
      applyStageClassification(
        pool,
        { ownerId: OWNER_A, stageId: 's5' },
        { subject: 'math' },
        {
          beforeAuthorityWrite: () => {
            throw new Error('boom-authority');
          },
        },
      ),
    ).rejects.toThrow('boom-authority');

    expect(await authorityRow(OWNER_A, 's5')).toBeNull();
    expect((await rowsOf(OWNER_A, 's5'))[0]!.subject).toBeNull();
    expect((await stageData('s5'))!.subject).toBeUndefined();
  });

  it('R2: failure before the mistake-row update rolls back the authority write too', async () => {
    await seedCourse(OWNER_A, 's6', '课');
    await captureMistakes(pool, OWNER_A, CONTEXT('s6'), [ITEM('q1')]);

    await expect(
      applyStageClassification(
        pool,
        { ownerId: OWNER_A, stageId: 's6' },
        { subject: 'math' },
        {
          beforeMistakeUpdate: () => {
            throw new Error('boom-rows');
          },
        },
      ),
    ).rejects.toThrow('boom-rows');

    expect(await authorityRow(OWNER_A, 's6')).toBeNull();
    expect((await rowsOf(OWNER_A, 's6'))[0]!.subject).toBeNull();
    expect((await stageData('s6'))!.subject).toBeUndefined();
  });

  it('R2: failure before the course update rolls back authority and rows', async () => {
    await seedCourse(OWNER_A, 's7', '课');
    await captureMistakes(pool, OWNER_A, CONTEXT('s7'), [ITEM('q1')]);

    await expect(
      applyStageClassification(
        pool,
        { ownerId: OWNER_A, stageId: 's7' },
        { subject: 'math' },
        {
          beforeCourseUpdate: () => {
            throw new Error('boom-course');
          },
        },
      ),
    ).rejects.toThrow('boom-course');

    expect(await authorityRow(OWNER_A, 's7')).toBeNull();
    expect((await rowsOf(OWNER_A, 's7'))[0]!.subject).toBeNull();
    expect((await stageData('s7'))!.subject).toBeUndefined();
  });

  it('R2: success path leaves authority, rows, and course consistent', async () => {
    await seedCourse(OWNER_A, 's8', '课');
    await captureMistakes(pool, OWNER_A, CONTEXT('s8'), [ITEM('q1'), ITEM('q2')]);

    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's8' },
      {
        subject: 'math',
        gradeSemester: 'grade-1-up',
      },
    );

    expect(outcome).toMatchObject({ matched: true, mistakeRows: 2, courseUpdated: true });
    expect(await authorityRow(OWNER_A, 's8')).toMatchObject({ subject: 'math' });
    expect((await rowsOf(OWNER_A, 's8')).every((row) => row.subject === 'math')).toBe(true);
    expect((await stageData('s8'))!.subject).toBe('math');
  });

  it('R2: after a fault, retrying the same command completes', async () => {
    await seedCourse(OWNER_A, 's5r', '课');
    await captureMistakes(pool, OWNER_A, CONTEXT('s5r'), [ITEM('q1')]);

    await expect(
      applyStageClassification(
        pool,
        { ownerId: OWNER_A, stageId: 's5r' },
        { subject: 'math', gradeSemester: 'grade-1-up' },
        {
          beforeCommit: () => {
            throw new Error('boom-commit');
          },
        },
      ),
    ).rejects.toThrow('boom-commit');

    // The connection is released and clean after the rollback: the same
    // command, retried without the fault, goes through end to end.
    const retried = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's5r' },
      {
        subject: 'math',
        gradeSemester: 'grade-1-up',
      },
    );
    expect(retried).toMatchObject({ matched: true, mistakeRows: 1, courseUpdated: true });
    expect((await rowsOf(OWNER_A, 's5r'))[0]).toMatchObject({
      subject: 'math',
      gradeSemester: 'grade-1-up',
    });
    expect((await stageData('s5r'))!).toMatchObject({ subject: 'math' });
  });

  // ── R3: the authority defeats stale capture payloads ──

  it('R3: after a manual classification, stale and new captures follow the authority', async () => {
    await captureMistakes(pool, OWNER_A, CONTEXT('s9', 'sc1'), [ITEM('q1'), ITEM('q2')]);
    await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's9' },
      {
        subject: 'english',
        gradeSemester: 'grade-2-up',
      },
    );

    // An old retry payload still claiming math/grade-1-up...
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('s9', 'sc1'), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q1')],
    );
    // ...and a brand-new question captured with the stale values too.
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('s9', 'sc2'), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q3')],
    );

    const rows = await rowsOf(OWNER_A, 's9');
    expect(rows).toHaveLength(3);
    expect(
      rows.every((row) => row.subject === 'english' && row.gradeSemester === 'grade-2-up'),
    ).toBe(true);
    expect(await authorityRow(OWNER_A, 's9')).toMatchObject({
      subject: 'english',
      source: 'manual',
    });
  });

  it('R3: an explicit clear cannot be resurrected by an old payload', async () => {
    await captureMistakes(pool, OWNER_A, CONTEXT('s10'), [{ ...ITEM('q1') }]);
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('s10'), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q2')],
    );
    // Inferred authority now math/grade-1-up; clear it explicitly.
    await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's10' },
      {
        subject: null,
        gradeSemester: null,
      },
    );

    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('s10'), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q3')],
    );

    const rows = await rowsOf(OWNER_A, 's10');
    expect(rows.every((row) => row.subject === null && row.gradeSemester === null)).toBe(true);
    // The cleared authority row persists — a manual decision, not absence.
    expect(await authorityRow(OWNER_A, 's10')).toMatchObject({
      subject: null,
      grade_semester: null,
      source: 'manual',
    });
  });

  it('R3: two owners with the same stageId never share classification state', async () => {
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('s11'), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q1')],
    );
    await captureMistakes(
      pool,
      OWNER_B,
      { ...CONTEXT('s11'), subject: 'chinese', gradeSemester: 'grade-2-up' },
      [ITEM('q1')],
    );

    expect((await rowsOf(OWNER_A, 's11'))[0]).toMatchObject({ subject: 'math' });
    expect((await rowsOf(OWNER_B, 's11'))[0]).toMatchObject({ subject: 'chinese' });
  });

  it('R3: the first classified capture initializes the inferred authority; a later conflicting capture follows it', async () => {
    // Legacy-style rows: authority table absent-era data with a value.
    await captureMistakes(pool, OWNER_A, CONTEXT('s12'), [ITEM('q1')]);

    // First classified capture initializes the authority deterministically.
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('s12'), subject: 'math', gradeSemester: 'grade-3-up' },
      [ITEM('q2')],
    );
    expect(await authorityRow(OWNER_A, 's12')).toMatchObject({
      subject: 'math',
      grade_semester: 'grade-3-up',
      source: 'inferred',
    });

    // A capture that arrives later with different values must follow it.
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('s12'), subject: 'english', gradeSemester: 'grade-1-up' },
      [ITEM('q3')],
    );
    const rows = await rowsOf(OWNER_A, 's12');
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.subject === 'math' && row.gradeSemester === 'grade-3-up')).toBe(
      true,
    );
  });

  it('R3: legacy upgrade — the authority table is recreated and existing records survive', async () => {
    await captureMistakes(pool, OWNER_A, CONTEXT('s13'), [ITEM('q1'), ITEM('q2')]);
    // Simulate a pre-authority database: drop the table, then re-ensure.
    await pool.query('DROP TABLE mistake_classification' as never);
    await ensureMistakeBookSchema(queryable());

    expect(await rowsOf(OWNER_A, 's13')).toHaveLength(2); // records preserved
    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 's13' },
      {
        subject: 'math',
      },
    );
    expect(outcome.matched).toBe(true);
    expect((await rowsOf(OWNER_A, 's13')).every((row) => row.subject === 'math')).toBe(true);
  });

  // ── R4: tri-state patch semantics ──

  async function classifyR4(stageId: string, patch: ClassificationPatch) {
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT(stageId), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q1')],
    );
    return applyStageClassification(pool, { ownerId: OWNER_A, stageId }, patch);
  }

  it('R4: setting only the subject keeps the grade; setting only the grade keeps the subject', async () => {
    await classifyR4('t1', { subject: 'english' });
    expect((await rowsOf(OWNER_A, 't1'))[0]).toMatchObject({
      subject: 'english',
      gradeSemester: 'grade-1-up',
    });

    await applyStageClassification(pool, { ownerId: OWNER_A, stageId: 't2' }, {}).catch(() => {});
    await classifyR4('t2', { gradeSemester: 'grade-5-down' });
    expect((await rowsOf(OWNER_A, 't2'))[0]).toMatchObject({
      subject: 'math',
      gradeSemester: 'grade-5-down',
    });
  });

  it('R4: a single null clears only its field; double null clears both but keeps the authority row', async () => {
    await classifyR4('t3', { subject: null });
    expect((await rowsOf(OWNER_A, 't3'))[0]).toMatchObject({
      subject: null,
      gradeSemester: 'grade-1-up',
    });

    await classifyR4('t4', { subject: null, gradeSemester: null });
    expect((await rowsOf(OWNER_A, 't4'))[0]).toMatchObject({
      subject: null,
      gradeSemester: null,
    });
    expect(await authorityRow(OWNER_A, 't4')).toMatchObject({ source: 'manual' });
  });

  it('R4: clearing on the live course removes the stage keys; a later set restores them', async () => {
    await seedCourse(OWNER_A, 't5', '课');
    await captureMistakes(pool, OWNER_A, CONTEXT('t5'), [ITEM('q1')]);
    // Write BOTH fields onto the course first, so "keep" has something to keep.
    await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 't5' },
      {
        subject: 'math',
        gradeSemester: 'grade-1-up',
      },
    );
    expect((await stageData('t5'))!).toMatchObject({
      subject: 'math',
      gradeSemester: 'grade-1-up',
    });

    // Clear only the subject: the course keeps gradeSemester.
    await applyStageClassification(pool, { ownerId: OWNER_A, stageId: 't5' }, { subject: null });
    const cleared = (await stageData('t5'))!;
    expect(cleared).not.toHaveProperty('subject');
    expect(cleared).toHaveProperty('gradeSemester', 'grade-1-up');

    await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 't5' },
      { subject: 'science' },
    );
    expect((await stageData('t5'))!).toMatchObject({
      subject: 'science',
      gradeSemester: 'grade-1-up',
    });
  });
  // ── Codex review round 1: legacy-upgrade and live-course gaps ──

  /** Legacy database simulation: rows carry classification, authority absent. */
  async function seedLegacyRows(stageId: string, subject: string, grade: string) {
    await captureMistakes(pool, OWNER_A, { ...CONTEXT(stageId), subject, gradeSemester: grade }, [
      ITEM('q1'),
      ITEM('q2'),
    ]);
    await pool.query('DELETE FROM mistake_classification' as never);
  }

  it('legacy upgrade: first single-field manual patch keeps the omitted field from existing rows', async () => {
    await seedLegacyRows('g1', 'math', 'grade-1-up');

    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 'g1' },
      {
        subject: 'english',
      },
    );

    expect(outcome.matched).toBe(true);
    expect(
      (await rowsOf(OWNER_A, 'g1')).every(
        (row) => row.subject === 'english' && row.gradeSemester === 'grade-1-up',
      ),
    ).toBe(true);
    expect(await authorityRow(OWNER_A, 'g1')).toMatchObject({
      subject: 'english',
      grade_semester: 'grade-1-up',
      source: 'manual',
    });
  });

  it('legacy upgrade: a stale capture cannot discard the existing classification', async () => {
    await seedLegacyRows('g2', 'english', 'grade-2-up');

    // Old retry payload claiming math/grade-1-up, carrying a NEW question.
    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('g2', 'sc9'), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q3')],
    );

    const rows = await rowsOf(OWNER_A, 'g2');
    expect(rows).toHaveLength(3); // all questions kept
    expect(
      rows.every((row) => row.subject === 'english' && row.gradeSemester === 'grade-2-up'),
    ).toBe(true);
    expect(await authorityRow(OWNER_A, 'g2')).toMatchObject({
      subject: 'english',
      grade_semester: 'grade-2-up',
      source: 'inferred',
    });
  });

  it('legacy conflict: disagreeing rows resolve conservatively to unclassified, all questions kept, resolution recorded', async () => {
    // Two rows that disagree (simulate a pre-upgrade split) with no authority.
    await seedLegacyRows('g3', 'math', 'grade-1-up');
    await pool.query(
      "UPDATE mistake_record SET subject = 'english' WHERE stage_id = 'g3' AND question_id = 'q2'" as never,
    );

    await captureMistakes(
      pool,
      OWNER_A,
      { ...CONTEXT('g3', 'sc9'), subject: 'math', gradeSemester: 'grade-1-up' },
      [ITEM('q3')],
    );

    const rows = await rowsOf(OWNER_A, 'g3');
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.subject === null && row.gradeSemester === 'grade-1-up')).toBe(
      true,
    );
    // The conservative resolution is RECORDED as the authority, so it cannot flap.
    expect(await authorityRow(OWNER_A, 'g3')).toMatchObject({
      subject: null,
      grade_semester: 'grade-1-up',
    });
  });

  it('live course-only: omitted field follows the course, authority matches, updatedAt and revision advance', async () => {
    await seedCourse(OWNER_A, 'g4', '只有课程的课');
    // Give the course its own classification (as outline generation would).
    const store = ownerStore(OWNER_A);
    const doc = await store.loadDocument('g4');
    await store.putStage('g4', {
      ...doc!.stage,
      subject: 'math',
      gradeSemester: 'grade-1-up',
    } as never);
    const before = await pool.query<
      { updated_at: number | string; data: Record<string, unknown> } & Record<string, unknown>
    >('SELECT updated_at, data FROM document_stages WHERE id = $1', ['g4']);
    const revBefore = await revisionOf('g4');

    const outcome = await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 'g4' },
      {
        subject: 'english',
      },
    );

    expect(outcome).toMatchObject({ matched: true, courseUpdated: true, mistakeRows: 0 });
    // Authority's omitted field agrees with the course.
    expect(await authorityRow(OWNER_A, 'g4')).toMatchObject({
      subject: 'english',
      grade_semester: 'grade-1-up',
    });
    const after = await pool.query<
      { updated_at: number | string; data: Record<string, unknown> } & Record<string, unknown>
    >('SELECT updated_at, data FROM document_stages WHERE id = $1', ['g4']);
    // The course carries the FINAL effective classification, not a half patch.
    expect(after.rows[0]!.data).toMatchObject({ subject: 'english', gradeSemester: 'grade-1-up' });
    // Server modification time advanced past the seeded 1000-era value...
    expect(Number(after.rows[0]!.updated_at)).toBeGreaterThan(Number(before.rows[0]!.updated_at));
    // ...and the DB-layer revision signal moved with the write.
    expect((await revisionOf('g4'))!).toBeGreaterThan(revBefore!);
  });

  it('with an existing authority, the course is written the final effective classification', async () => {
    await seedCourse(OWNER_A, 'g5', '课');
    const store = ownerStore(OWNER_A);
    const doc = await store.loadDocument('g5');
    await store.putStage('g5', { ...doc!.stage, subject: 'math' } as never);
    await captureMistakes(pool, OWNER_A, CONTEXT('g5'), [ITEM('q1')]);
    // Manual authority says english — the course still says math.
    await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 'g5' },
      { subject: 'english' },
    );
    // A later classify touching ONLY the grade must not leave math behind.
    await applyStageClassification(
      pool,
      { ownerId: OWNER_A, stageId: 'g5' },
      { gradeSemester: 'grade-2-up' },
    );

    const data = (await stageData('g5'))!;
    expect(data).toMatchObject({ subject: 'english', gradeSemester: 'grade-2-up' });
    expect(await authorityRow(OWNER_A, 'g5')).toMatchObject({
      subject: 'english',
      grade_semester: 'grade-2-up',
    });
  });

  async function revisionOf(stageId: string): Promise<number | null> {
    const result = await pool.query<{ rev: number | string } & Record<string, unknown>>(
      'SELECT rev FROM document_stage_revision WHERE stage_id = $1',
      [stageId],
    );
    return result.rows[0] ? Number(result.rows[0].rev) : null;
  }
});
