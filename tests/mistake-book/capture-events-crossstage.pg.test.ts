/**
 * C early-review formal tests (R9): the event receipt's lock domain and
 * conflict fingerprint, proven on REAL PostgreSQL where two connections can
 * truly race — plus the real route→store event-contract pass-through.
 *
 * Isolation: dedicated schema on the synthetic review instance
 * (postgresql://postgres:…@127.0.0.1:57536/codex_review), created and dropped
 * by this suite; synthetic data only.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureDocumentSchema, type Queryable } from '@openmaic/storage/document/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  captureMistakes,
  ensureMistakeBookSchema,
  listMistakes,
  type MistakeCaptureContext,
  type MistakeCaptureItem,
} from '@/lib/persistence/mistake-book';

const url = process.env.PG_CONTRACT_URL;
if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !url) {
  throw new Error(
    'capture events (real PG): STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL',
  );
}

const TEST_SCHEMA = 'openmaic_capture_events_test';

const OWNER = 'owner-ce';
const item = (questionId: string, answer = 'A'): MistakeCaptureItem => ({
  questionId,
  eventId: `evt-${questionId}-a1`,
  questionType: 'single',
  question: `${questionId}?`,
  correctAnswer: ['B'],
  userAnswer: answer,
});
const context = (stageId: string, stageName: string): MistakeCaptureContext => ({
  stageId,
  stageName,
  sceneId: 'sc-1',
});

describe.skipIf(!url)('R9 event domain on real PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  const q = (): Queryable => pool as unknown as Queryable;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${TEST_SCHEMA}`, max: 5 });
    await ensureDocumentSchema(q());
    await ensureStageMetaSchema(q());
    await ensureAssetSchema(q());
    await ensureMistakeBookSchema(q());
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('same eventId, two stages: concurrent captures → EXACTLY 1 success + 1 conflict', async () => {
    const shared: MistakeCaptureItem = { ...item('q-x'), eventId: 'evt-cross-stage' };
    // External lock holder pins the event domain; BOTH captures start and
    // block on the advisory lock (proven via a bounded, connection-scoped
    // poll of pg_stat_activity); releasing them together creates a REAL
    // race for the receipt — the lock+winner-check must serialize them into
    // exactly one success and one conflict.
    const adminClient = await admin.connect();
    const pgAppNames: string[] = [];
    let pendingA: Promise<unknown> | null = null;
    let pendingB: Promise<unknown> | null = null;
    try {
      await adminClient.query("SET application_name = 'ce_lock_holder'");
      await adminClient.query('BEGIN');
      await adminClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `mistake-capture-event:${OWNER}:evt-cross-stage`,
      ]);

      const aName = `ce_capA_${Date.now()}`;
      const bName = `ce_capB_${Date.now()}`;
      pgAppNames.push(aName, bName);
      const poolA = new Pool({
        connectionString: url,
        options: `-c search_path=${TEST_SCHEMA} -c application_name=${aName}`,
        max: 1,
      });
      const poolB = new Pool({
        connectionString: url,
        options: `-c search_path=${TEST_SCHEMA} -c application_name=${bName}`,
        max: 1,
      });
      pendingA = captureMistakes(poolA, OWNER, context('stage-A', 'A课'), [shared], {
        eventIds: ['evt-cross-stage'],
      }).finally(() => poolA.end());
      pendingB = captureMistakes(poolB, OWNER, context('stage-B', 'B课'), [shared], {
        eventIds: ['evt-cross-stage'],
      }).finally(() => poolB.end());

      // Bounded conditional poll: BOTH capture connections must be waiting on
      // an advisory lock (scoped to this test's application names).
      const deadline = Date.now() + 10_000;
      let bothWaiting = false;
      while (Date.now() < deadline) {
        const waits = await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ANY($1) AND wait_event = 'advisory'",
          [[aName, bName]],
        );
        if (waits.rows[0]!.n >= 2) {
          bothWaiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(bothWaiting).toBe(true);

      await adminClient.query('COMMIT'); // release: the race is on
      const results = await Promise.allSettled([pendingA, pendingB]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) => r.status === 'rejected',
      ) as Array<PromiseRejectedResult>;
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as Error).message).toBe('EVENT_PAYLOAD_CONFLICT');
    } finally {
      // Release the held lock on ANY path (a failed expectation above must
      // not leave the captures blocked), then SETTLE both already-started
      // captures — the loser's rejection may never dangle unhandled
      // (implementation review).
      await adminClient.query('ROLLBACK').catch(() => {});
      adminClient.release();
      await Promise.allSettled([pendingA, pendingB].filter(Boolean));
    }

    // Exactly ONE mistake row exists.
    const all = await listMistakes(q(), OWNER, { filter: 'all' });
    const rows = all.filter((record) => record.questionId === 'q-x');
    expect(rows).toHaveLength(1);
  });

  it('legitimate same-stage concurrency: both distinct events land, each once', async () => {
    const [a, b] = await Promise.all([
      captureMistakes(pool, OWNER, context('stage-C', 'C课'), [item('q-c1')]),
      captureMistakes(pool, OWNER, context('stage-C', 'C课'), [item('q-c2')]),
    ]);
    expect(a.created).toEqual(['q-c1']);
    expect(b.created).toEqual(['q-c2']);
    const rows = (await listMistakes(q(), OWNER, { stageId: 'stage-C' })).map(
      (record) => record.questionId,
    );
    expect(rows.sort()).toEqual(['q-c1', 'q-c2']);
  });

  it('a renamed stage under the same eventId is a CONFLICT, not an exact replay', async () => {
    await captureMistakes(pool, OWNER, context('stage-D', '原名'), [item('q-d1')]);
    await expect(
      captureMistakes(pool, OWNER, context('stage-D', '改后标题'), [item('q-d1')]),
    ).rejects.toThrow('EVENT_PAYLOAD_CONFLICT');
    // …and an identical replay stays a no-op.
    const replay = await captureMistakes(pool, OWNER, context('stage-D', '原名'), [item('q-d1')]);
    expect(replay.duplicates).toEqual(['q-d1']);
  });

  it('a duplicate question id in one batch rolls the whole batch back', async () => {
    await expect(
      captureMistakes(pool, OWNER, context('stage-E', 'E课'), [item('q-e1'), item('q-e1', 'C')], {
        eventIds: ['evt-e1-a', 'evt-e1-b'],
      }),
    ).rejects.toThrow('DUPLICATE_QUESTION_IN_BATCH');
    const rows = await listMistakes(q(), OWNER, { stageId: 'stage-E' });
    expect(rows).toEqual([]);
  });
});
