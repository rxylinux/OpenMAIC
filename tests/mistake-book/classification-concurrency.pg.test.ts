/**
 * Real-PostgreSQL concurrency tests for the classification store (R3 of the
 * remediation contract): a classify command and a capture running on GENUINE
 * separate connections at the same time must never split one stage's mistakes
 * into two classification groups. The advisory lock shared by both paths is
 * what serializes them; the assertion is the observable outcome — after the
 * dust settles every row and the authority agree on one classification.
 *
 * Gated on PG_CONTRACT_URL like the other `.pg.test.ts` suites; provisions
 * its own schema and drops it again, so it never touches real data.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureDocumentSchema, type Queryable } from '@openmaic/storage/document/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  applyStageClassification,
  captureMistakes,
  ensureMistakeBookSchema,
  listMistakes,
} from '@/lib/persistence/mistake-book';

const contractUrl = process.env.PG_CONTRACT_URL;
if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    'mistake classification concurrency: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL suite',
  );
}

const OWNER = 'anon:33333333-3333-4333-8333-333333333333';
const TEST_SCHEMA = 'openmaic_mistake_classification_test';

describe.skipIf(!contractUrl)('mistake classification concurrency (real PostgreSQL)', () => {
  let admin: Pool;
  let pool: Pool;
  const queryable = (): Queryable => pool as unknown as Queryable;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${TEST_SCHEMA}`,
      max: 4,
    });
    await ensureDocumentSchema(queryable());
    await ensureStageMetaSchema(queryable());
    await ensureAssetSchema(queryable());
    await ensureMistakeBookSchema(queryable());
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  async function rowsOf(stageId: string) {
    const records = await listMistakes(queryable(), OWNER, { stageId, filter: 'all' });
    return records.map((record) => ({
      questionId: record.questionId,
      subject: record.subject,
      gradeSemester: record.gradeSemester,
    }));
  }

  it('concurrent classify + capture converge on one classification with no split', async () => {
    const stageId = 'conc-1';
    // Pre-existing rows under a stale classification payload.
    await captureMistakes(
      pool,
      OWNER,
      {
        stageId,
        stageName: '并发课',
        sceneId: 'sc0',
        subject: 'english',
        gradeSemester: 'grade-2-up',
      },
      [
        {
          questionId: 'q1',
          questionType: 'single',
          question: '1',
          correctAnswer: ['A'],
          userAnswer: 'B',
        },
      ],
    );

    // Fire a manual classify and a stale-valued capture at the same instant,
    // on different pool connections. Whichever wins the advisory lock, the
    // manual decision must come out on top and every row must follow it.
    await Promise.all([
      applyStageClassification(
        pool,
        { ownerId: OWNER, stageId },
        { subject: 'math', gradeSemester: 'grade-1-up' },
      ),
      captureMistakes(
        pool,
        OWNER,
        {
          stageId,
          stageName: '并发课',
          sceneId: 'sc1',
          subject: 'english',
          gradeSemester: 'grade-2-up',
        },
        [
          {
            questionId: 'q2',
            questionType: 'single',
            question: '2',
            correctAnswer: ['A'],
            userAnswer: 'B',
          },
        ],
      ),
    ]);

    const rows = await rowsOf(stageId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.subject === 'math' && row.gradeSemester === 'grade-1-up')).toBe(
      true,
    );
  });

  it('concurrent opposing classify commands leave every row on ONE of them', async () => {
    const stageId = 'conc-2';
    await captureMistakes(pool, OWNER, { stageId, stageName: '并发课2', sceneId: 'sc0' }, [
      {
        questionId: 'q1',
        questionType: 'single',
        question: '1',
        correctAnswer: ['A'],
        userAnswer: 'B',
      },
    ]);

    await Promise.all([
      applyStageClassification(pool, { ownerId: OWNER, stageId }, { subject: 'math' }),
      applyStageClassification(pool, { ownerId: OWNER, stageId }, { subject: 'chinese' }),
    ]);

    const subjects = new Set((await rowsOf(stageId)).map((row) => row.subject));
    // Exactly one winner — a split would produce {'math','chinese'}.
    expect(subjects.size).toBe(1);
    expect(['math', 'chinese']).toContain([...subjects][0]);
  });

  it('concurrent captures of new questions both land and both follow the authority', async () => {
    const stageId = 'conc-3';
    await captureMistakes(
      pool,
      OWNER,
      {
        stageId,
        stageName: '并发课3',
        sceneId: 'sc0',
        subject: 'math',
        gradeSemester: 'grade-1-up',
      },
      [
        {
          questionId: 'seed',
          questionType: 'single',
          question: '0',
          correctAnswer: ['A'],
          userAnswer: 'B',
        },
      ],
    );

    await Promise.all([
      captureMistakes(
        pool,
        OWNER,
        {
          stageId,
          stageName: '并发课3',
          sceneId: 'sc1',
          subject: 'math',
          gradeSemester: 'grade-1-up',
        },
        [
          {
            questionId: 'qA',
            questionType: 'single',
            question: 'A',
            correctAnswer: ['A'],
            userAnswer: 'B',
          },
        ],
      ),
      captureMistakes(
        pool,
        OWNER,
        {
          stageId,
          stageName: '并发课3',
          sceneId: 'sc2',
          subject: 'english',
          gradeSemester: 'grade-2-up',
        },
        [
          {
            questionId: 'qB',
            questionType: 'single',
            question: 'B',
            correctAnswer: ['A'],
            userAnswer: 'B',
          },
        ],
      ),
    ]);

    const rows = await rowsOf(stageId);
    expect(rows).toHaveLength(3);
    // The inferred authority (math/grade-1-up, from the seed capture) rules;
    // the stale-valued second capture cannot split the group.
    expect(rows.every((row) => row.subject === 'math' && row.gradeSemester === 'grade-1-up')).toBe(
      true,
    );
  });
});
