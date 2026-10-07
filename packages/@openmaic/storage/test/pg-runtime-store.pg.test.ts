import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PgRuntimeStore,
  asStorageLockUnavailable,
  ensureSchema,
  type Queryable,
  type WithTransaction,
} from '../src/runtime/pg.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL contract suite',
  );
}

function transactionFor(pool: Pool, afterBegin?: () => Promise<void>): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await afterBegin?.();
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the transaction body's original error.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}

describe.skipIf(!contractUrl)('PgRuntimeStore with PostgreSQL 16', () => {
  let pool: Pool;
  let store: PgRuntimeStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    await ensureSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE runtime_records, runtime_sessions');
    store = new PgRuntimeStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await pool.end();
  });

  runRuntimeStoreContract('PostgreSQL 16 (node-postgres)', () => store);

  test('genuinely concurrent appends assign distinct gapless sequences', async () => {
    const concurrentTransactions = 8;
    await store.createSession(makeSession({ kind: 'playback' }));
    const allTransactionsStarted = makeBarrier(concurrentTransactions);
    const concurrentStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: transactionFor(pool, allTransactionsStarted),
    });

    const appended = await Promise.all(
      Array.from({ length: concurrentTransactions }, (_, index) =>
        concurrentStore.appendRecord(
          makeRecordInit('sess-1', {
            id: `pg-concurrent-${index}`,
            payload: { index },
          }),
        ),
      ),
    );

    const seqs = appended.map((record) => record.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: concurrentTransactions }, (_, index) => index));
    expect(new Set(seqs).size).toBe(concurrentTransactions);
  });

  test('retries after a real unique violation from an independent writer', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));
    const writer = await pool.connect();
    let attempts = 0;
    let collisionErrorCode: unknown;
    const collisionStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: async (body) => {
        attempts += 1;
        const client = await pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          if (attempts === 1) {
            // Establish the store transaction's snapshot before the external
            // row commits, so MAX(seq) still chooses the colliding value.
            await client.query('SELECT COUNT(*) FROM runtime_records');
            await writer.query(
              `INSERT INTO runtime_records
                 (id, session_id, seq, scene_id, created_at, data)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
              [
                'external-collision',
                'sess-1',
                0,
                null,
                '2026-01-01T00:01:00.000Z',
                JSON.stringify({
                  id: 'external-collision',
                  sessionId: 'sess-1',
                  seq: 0,
                  createdAt: '2026-01-01T00:01:00.000Z',
                  payload: { source: 'external' },
                }),
              ],
            );
          }
          const result = await body(client as Queryable);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          if (attempts === 1) collisionErrorCode = (error as { code?: unknown }).code;
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    });

    try {
      const appended = await collisionStore.appendRecord(
        makeRecordInit('sess-1', { id: 'store-after-collision', payload: { source: 'store' } }),
      );

      expect(attempts).toBe(2);
      expect(collisionErrorCode).toBe('23505');
      expect(appended.seq).toBe(1);
      expect((await store.listRecords('sess-1')).map((record) => record.seq)).toEqual([0, 1]);
    } finally {
      writer.release();
    }
  });

  test('appendRecord and mergeLearner join the partition advisory-lock boundary (real lock wait)', async () => {
    // Seed BOTH partitions before any lock is taken: the append source
    // partition and the merge destination partition.
    await store.createSession(makeSession({ kind: 'quizAttempt', id: 'append-boundary' }));
    await store.createSession(makeSession({ id: 'merge-boundary', kind: 'quizAttempt' }));

    // A REAL pinned holder transaction takes BOTH partition advisory locks
    // (the append's partition and the merge's DESTINATION partition) and
    // stays open — the same xact-scoped boundary createSession and the
    // lineage guard take.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    for (const partitionKey of [
      'stage-1\u001fanon:device-1\u001fquizAttempt',
      'stage-1\u001fuser:merge-target\u001fquizAttempt',
    ]) {
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [
        partitionKey,
      ]);
    }

    // A bounded-lock-timeout store through the PRODUCTION hook contract:
    // every statement of the body pins one fresh transaction.
    const boundedHook: WithTransaction = async (body) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '400ms'");
        const result = await body(client as Queryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the transaction body's original error.
        }
        throw error;
      } finally {
        client.release();
      }
    };
    const boundedStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: boundedHook,
    });

    try {
      // A scene-anchored append to the partition must WAIT for the holder's
      // advisory lock and give up as classified lock contention.
      const appendRejection = boundedStore.appendRecord(
        makeRecordInit('append-boundary', {
          sceneId: 'scene-1',
          payload: { payloadVersion: 1, phase: 'draft', answers: {} },
        }),
      );
      const appendError = await appendRejection.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(asStorageLockUnavailable(appendError)?.reason).toBe('lock-timeout');
      expect((appendError as { code?: unknown }).code).toBe('55P03');

      // mergeLearner moves rows INTO the destination partition: same wait.
      const mergeRejection = boundedStore.mergeLearner('anon:device-1', 'user:merge-target');
      const mergeError = await mergeRejection.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(asStorageLockUnavailable(mergeError)?.reason).toBe('lock-timeout');
    } finally {
      await holder.query('COMMIT').catch(() => undefined);
      holder.release();
    }

    // After the holder's transaction ends, both operations proceed for real.
    await expect(
      store.appendRecord(
        makeRecordInit('append-boundary', {
          sceneId: 'scene-1',
          payload: { payloadVersion: 1, phase: 'draft', answers: {} },
        }),
      ),
    ).resolves.toMatchObject({ seq: 0 });
    await expect(store.mergeLearner('anon:device-1', 'user:merge-target')).resolves.toBe(2);
  });

  test('mergeLearner takes EVERY distinct destination partition — open-kind tuple collision cannot under-lock the quiz partition (real wait)', async () => {
    // `kind` is an OPEN string, so these two source partitions are distinct
    // and valid: (stageId 'a', kind 'b\u001fquizAttempt') and
    // (stageId 'a\u001fb', kind 'quizAttempt'). Their US-joined identity
    // COLLIDES — the old separator dedupe dropped the second tuple and its
    // destination lock. Arrange the custom-kind row FIRST by id, hold the
    // TARGET quiz partition, and prove the merge now genuinely waits on it.
    const sourceLearner = 'anon:merge-collision-src';
    const targetLearner = 'user:merge-collision-target';
    await store.createSession(
      makeSession({
        id: 'collision-a',
        stageId: 'a',
        kind: 'b\u001fquizAttempt',
        learnerKey: sourceLearner,
      }),
    );
    await store.createSession(
      makeSession({
        id: 'collision-b',
        stageId: 'a\u001fb',
        kind: 'quizAttempt',
        learnerKey: sourceLearner,
      }),
    );
    await store.appendRecord(
      makeRecordInit('collision-b', {
        sceneId: 'scene-1',
        payload: { payloadVersion: 1, phase: 'draft', answers: {} },
      }),
    );

    const targetQuizKey = `a\u001fb\u001f${targetLearner}\u001fquizAttempt`;
    const holder = await pool.connect();
    let holderOpen = true;
    let mergeInFlight: Promise<number> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [
        targetQuizKey,
      ]);

      // A bounded merge through the PRODUCTION hook MUST block on the real
      // quiz destination partition (the under-locked one) and give up as
      // classified contention — with the old tuple dedupe it sailed through.
      const boundedHook: WithTransaction = async (body) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout = '400ms'");
          const result = await body(client as Queryable);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve the transaction body's original error.
          }
          throw error;
        } finally {
          client.release();
        }
      };
      const boundedStore = new PgRuntimeStore(pool as Queryable, {
        withTransaction: boundedHook,
      });
      const mergeError = await boundedStore.mergeLearner(sourceLearner, targetLearner).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(asStorageLockUnavailable(mergeError)?.reason).toBe('lock-timeout');
      expect((mergeError as { code?: unknown }).code).toBe('55P03');

      // The unbounded merge genuinely WAITS (rollback/after-release proof).
      mergeInFlight = store.mergeLearner(sourceLearner, targetLearner);
      const pendingProbe = await Promise.race([
        mergeInFlight.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 200);
        }),
      ]);
      expect(pendingProbe).toBe('pending');

      await holder.query('COMMIT');
      holderOpen = false; // only AFTER the commit succeeded
      // After the holder's transaction ends the merge completes: BOTH rows
      // moved to the target learner with their stage/kind identity intact.
      await expect(mergeInFlight).resolves.toBe(2);
      const moved = await store.listSessions('a', targetLearner);
      const movedQuiz = await store.listSessions('a\u001fb', targetLearner);
      expect(moved.map((session) => session.id)).toEqual(['collision-a']);
      expect(moved[0]!.kind).toBe('b\u001fquizAttempt');
      expect(movedQuiz.map((session) => session.id)).toEqual(['collision-b']);
      expect(movedQuiz[0]!.kind).toBe('quizAttempt');
      expect((await store.listSessions('a', sourceLearner)).length).toBe(0);
    } finally {
      // Strict ordering: ALL transaction cleanup happens BEFORE release and
      // the released client is NEVER queried again (a pooled release may hand
      // the connection to another waiter). `holderOpen` flips false only
      // after COMMIT succeeds, so any failure path — including a failed
      // pendingProbe assertion — rolls the holder back here, releasing the
      // advisory lock so the parked merge can settle in the drain below. The
      // ORIGINAL assertion error propagates; allSettled never masks it.
      if (holderOpen) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (mergeInFlight !== undefined) {
        await Promise.allSettled([mergeInFlight]);
      }
    }
  });

  test('a real aborted transaction does not poison the next store operation', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));
    const baseTransaction = transactionFor(pool);
    let injectFailure = true;
    let initialErrorCode: unknown;
    let abortedErrorCode: unknown;
    const recoveryStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: (body) =>
        baseTransaction((queryable) =>
          body({
            async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
              text: string,
              params?: unknown[],
            ) {
              if (injectFailure && text.includes('SELECT COALESCE(MAX(seq)')) {
                injectFailure = false;
                try {
                  await queryable.query('SELECT 1 / 0');
                } catch (error) {
                  initialErrorCode = (error as { code?: unknown }).code;
                  try {
                    await queryable.query('SELECT 1');
                  } catch (abortedError) {
                    abortedErrorCode = (abortedError as { code?: unknown }).code;
                  }
                  throw error;
                }
              }
              return queryable.query<TRow>(text, params);
            },
          }),
        ),
    });

    await expect(
      recoveryStore.appendRecord(
        makeRecordInit('sess-1', { id: 'aborted-attempt', payload: { attempt: 1 } }),
      ),
    ).rejects.toMatchObject({ code: '22012' });
    expect(initialErrorCode).toBe('22012');
    expect(abortedErrorCode).toBe('25P02');

    await expect(
      recoveryStore.appendRecord(
        makeRecordInit('sess-1', { id: 'after-abort', payload: { attempt: 2 } }),
      ),
    ).resolves.toMatchObject({ id: 'after-abort', seq: 0 });
  });
});
