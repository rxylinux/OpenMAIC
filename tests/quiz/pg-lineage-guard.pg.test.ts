import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * REAL PostgreSQL serialization proof for the atomic lineage guard (final
 * review + supplement round 2).
 *
 * The harness honors the PRODUCTION `withTransaction` contract: every store
 * transaction is a GENUINE pinned BEGIN/COMMIT/ROLLBACK unit on its own
 * connection (`(body) => body(client)` autocommit harnesses are forbidden —
 * their FOR UPDATE rows and xact advisory locks expire at each statement, so
 * they prove nothing about multi-statement atomicity). Lock waits are proven
 * with real `lock_timeout` contention through real store operations, and the
 * guarded operation itself is HELD at a query barrier placed AFTER its
 * relevance read — never via a separately issued manual lock alone.
 */
const contractUrl = process.env.PG_CONTRACT_URL;

describe.runIf(contractUrl)('PgRuntimeStore atomic lineage guard serialization', () => {
  type QueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> = {
    rows: TRow[];
  };
  type Queryable = {
    query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<QueryResult<TRow>>;
  };
  type WithTransaction = <T>(body: (queryable: Queryable) => Promise<T>) => Promise<T>;
  type PgPoolClient = Queryable & {
    query(text: string, values?: unknown[]): Promise<unknown>;
    release(): void;
  };
  type PgPool = Queryable & {
    connect(): Promise<PgPoolClient>;
    query(text: string, values?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
  type PgRuntimeStoreCtor = new (
    queryable: Queryable,
    options: { withTransaction: WithTransaction },
  ) => import('@openmaic/storage').RuntimeStore;
  let Pool: new (config: { connectionString: string; max: number }) => PgPool;
  let PgRuntimeStore: PgRuntimeStoreCtor;
  let asStorageLockUnavailable: (
    error: unknown,
  ) => { reason: 'lock-timeout' | 'deadlock' } | undefined;
  let pool: PgPool;
  /** The app's CANONICAL quiz reader — the equivalence target of the guard. */
  let loadQuizAttemptState: typeof import('@/lib/quiz/runtime').loadQuizAttemptState;

  beforeAll(async () => {
    const pg = await import('pg');
    Pool = pg.Pool as never;
    const pgModule = (await import('@openmaic/storage/runtime/pg')) as {
      PgRuntimeStore: PgRuntimeStoreCtor;
      ensureSchema: (queryable: Queryable) => Promise<void>;
      asStorageLockUnavailable: typeof asStorageLockUnavailable;
    };
    PgRuntimeStore = pgModule.PgRuntimeStore;
    asStorageLockUnavailable = pgModule.asStorageLockUnavailable;
    pool = new Pool({ connectionString: contractUrl!, max: 8 });
    await pgModule.ensureSchema(pool);
    ({ loadQuizAttemptState } = await import('@/lib/quiz/runtime'));
  });

  afterAll(async () => {
    await pool.end();
  });

  const partitionKey = (stageId: string, learnerKey: string, kind: string) =>
    `${stageId}\u001f${learnerKey}\u001f${kind}`;

  /**
   * A GENUINE pinned transaction — BEGIN, every body statement pinned to one
   * fresh connection, COMMIT on success, ROLLBACK and re-throw on failure,
   * release in finally. This is the production hook contract; a
   * `(body) => body(sharedClient)` shortcut is deliberately not used anywhere
   * in this harness.
   */
  const runPinned = async <T>(
    afterBegin: (client: PgPoolClient) => Promise<void>,
    body: (queryable: Queryable) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await afterBegin(client);
        const result = await body(client as unknown as Queryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the body's original error.
        }
        throw error;
      }
    } finally {
      client.release();
    }
  };

  /** A store whose every transaction is a real pinned BEGIN/COMMIT unit.
   * Reads (listSessions/listRecords) run on the pool as ordinary autocommit
   * statements — only WRITES demand a pinned transaction. */
  const storeOn = (
    afterBegin: (client: PgPoolClient) => Promise<void> = async () => {},
  ): import('@openmaic/storage').RuntimeStore =>
    new PgRuntimeStore(pool, {
      withTransaction: (body) => runPinned(afterBegin, body),
    });

  /** `SET LOCAL lock_timeout` inside the pinned transaction (a real bounded wait). */
  const lockTimeoutAfterBegin = (ms: string) => async (client: PgPoolClient) => {
    await client.query(`SET LOCAL lock_timeout = '${ms}'`);
  };

  /**
   * Run `body` inside one REAL open holder transaction (BEGIN → partition
   * advisory lock → body → COMMIT). The transaction is ALWAYS closed (COMMIT
   * on success, ROLLBACK on any throw — including assertion failures inside
   * negative controls) and the client ALWAYS released, so a failing control
   * can never leak the held partition lock or hang `pool.end()`.
   */
  const withHolder = async (key: string, body: () => Promise<void>): Promise<void> => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [key]);
      await body();
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
  };

  it('a creation in the partition BLOCKS while the guard holds the advisory lock, then proceeds', async () => {
    const stageId = `guard-race-${Date.now()}`;
    const learnerKey = 'learner-guard';
    const key = partitionKey(stageId, learnerKey, 'quizAttempt');
    const sessionInit = (id: string, createdAt: string) => ({
      id,
      kind: 'quizAttempt' as const,
      stageId,
      learnerKey,
      status: 'active' as const,
      createdAt,
      updatedAt: createdAt,
    });

    try {
      // The holder is a REAL open transaction holding the xact-scoped partition
      // lock — the exact critical section the guard's check+write occupies.
      await withHolder(key, async () => {
        // A REAL createSession through the production hook, bounded by a real
        // lock_timeout, MUST block on the partition lock and give up as
        // classified contention.
        const boundedCreate = storeOn(lockTimeoutAfterBegin('400ms'));
        const createError = await boundedCreate
          .createSession(sessionInit(`${stageId}-root`, '2026-10-03T00:00:00.000Z'))
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(asStorageLockUnavailable(createError)?.reason).toBe('lock-timeout');
      });

      // The holder committed; the creation now proceeds for real.
      const plain = storeOn();
      await expect(
        plain.createSession(sessionInit(`${stageId}-root`, '2026-10-03T00:00:00.000Z')),
      ).resolves.toBeTruthy();

      // Guard-direction exclusion: B's guarded status write blocks while the
      // same partition lock is held, then proceeds.
      await withHolder(key, async () => {
        const boundedGuard = storeOn(lockTimeoutAfterBegin('400ms'));
        const guardError = await boundedGuard.setSessionStatusIfLatest!(
          `${stageId}-root`,
          'active',
          '2026-10-03T01:00:00.000Z',
          {
            relevantSceneId: 'scene-quiz',
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(asStorageLockUnavailable(guardError)?.reason).toBe('lock-timeout');
      });
    } finally {
      await pool
        .query('DELETE FROM runtime_sessions WHERE stage_id = $1', [stageId])
        .catch(() => undefined);
    }
  });

  it('post-relevance-read BARRIER: the first relevant append to an existing newer EMPTY session serializes against the held guard', async () => {
    const stageId = `guard-barrier-${Date.now()}`;
    const learnerKey = 'learner-barrier';
    const sceneId = 'scene-quiz';
    const rootId = `${stageId}-root`;
    const newerEmptyId = `${stageId}-newer-empty`;
    const stamp = '2026-10-03T06:00:00.000Z';
    const seed = storeOn();

    // Hold the REAL guarded operation at a query barrier placed AFTER its
    // relevance read: its open pinned transaction already holds the root row
    // lock AND the partition advisory lock and has already read the sibling
    // set (the newer session is EMPTY — not relevant); the persist UPDATE is
    // parked at the gate. The `finally` below ALWAYS opens the gate, drains
    // every parked/blocked operation, closes + releases the guard's client,
    // and deletes this case's fixtures — an intentional negative control or
    // an assertion failure can never hang pool.end() or leak a held lock.
    let releaseBarrier: (() => void) | undefined;
    const barrierGate = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let barrierArrived!: () => void;
    const barrierArrivedPromise = new Promise<void>((resolve) => {
      barrierArrived = resolve;
    });
    /** Every operation that may be parked on the gate or the partition lock. */
    const held: Array<Promise<unknown>> = [];
    let guardClient: PgPoolClient | undefined;
    /**
     * Race the barrier's ARRIVAL against premature settlement and a bounded
     * diagnostic deadline: if a guard regression returned false (or threw)
     * before the UPDATE, the arrival promise would never resolve — awaiting
     * it directly would hang until the suite timeout with the transaction
     * still open. The race turns that into a prompt, explained failure; the
     * finally below still releases, drains, and rolls back either way.
     */
    const raceArrival = async (
      arrival: Promise<void>,
      operation: Promise<unknown>,
      deadlineMs: number,
    ): Promise<
      'arrived' | 'settled-before-barrier' | 'rejected-before-barrier' | 'arrival-deadline'
    > =>
      Promise.race([
        arrival.then(() => 'arrived' as const),
        operation.then(
          () => 'settled-before-barrier' as const,
          () => 'rejected-before-barrier' as const,
        ),
        new Promise<'arrival-deadline'>((resolve) => {
          setTimeout(() => resolve('arrival-deadline'), deadlineMs);
        }),
      ]);
    try {
      // Production-path seed: a completed root with an UNDECIDED review tail
      // (the repair target), plus an ALREADY-CREATED newer empty session.
      await seed.createSession({
        id: rootId,
        kind: 'quizAttempt',
        stageId,
        learnerKey,
        status: 'active',
        createdAt: '2026-10-03T00:00:00.000Z',
        updatedAt: '2026-10-03T00:00:00.000Z',
      });
      await seed.appendRecord(
        {
          id: `${rootId}-review`,
          sessionId: rootId,
          sceneId,
          createdAt: '2026-10-03T00:00:01.000Z',
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: { q1: 'A' },
            results: [{ questionId: 'q1', correct: null, status: 'ungraded', earned: 0 }],
          },
        },
        { sessionTransition: { status: 'completed', updatedAt: '2026-10-03T00:00:02.000Z' } },
      );
      await seed.createSession({
        id: newerEmptyId,
        kind: 'quizAttempt',
        stageId,
        learnerKey,
        status: 'active',
        createdAt: '2026-10-03T05:00:00.000Z',
        updatedAt: '2026-10-03T05:00:00.000Z',
      });

      const client = await pool.connect();
      guardClient = client;
      const gatedQueryable: Queryable = {
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          params?: unknown[],
        ): Promise<QueryResult<TRow>> {
          if (text.startsWith('UPDATE runtime_sessions')) {
            barrierArrived(); // relevance read + tail CAS are DONE; write parked
            await barrierGate;
          }
          return (await client.query(text, params)) as QueryResult<TRow>;
        },
      };
      // The guard's own operations are fully transactional; a stray autocommit
      // statement on its behalf must fail loud (the barrier keeps the pinned
      // transaction open, so nothing may bypass it).
      const guardStore = new PgRuntimeStore(
        {
          query: async () => {
            throw new Error('the held guard must not issue autocommit statements');
          },
        },
        {
          withTransaction: (body) =>
            (async <T>(work: (queryable: Queryable) => Promise<T>): Promise<T> => {
              await client.query('BEGIN');
              try {
                const result = await work(gatedQueryable);
                await client.query('COMMIT');
                return result;
              } catch (error) {
                try {
                  await client.query('ROLLBACK');
                } catch {
                  // Preserve the body's original error.
                }
                throw error;
              }
            })(body),
        },
      );

      const guardPromise = guardStore.setSessionStatusIfLatest!(rootId, 'active', stamp, {
        relevantSceneId: sceneId,
        expectedLastSeq: 0,
      });
      held.push(guardPromise);
      const barrierOutcome = await raceArrival(barrierArrivedPromise, guardPromise, 2_000);
      expect(
        barrierOutcome,
        'the guarded operation must reach its post-relevance-read UPDATE barrier',
      ).toBe('arrived');

      // While the guard is held INSIDE its transaction: another REAL store
      // appends the FIRST valid record to the newer empty session. It must
      // block on the same partition advisory lock — proven first by a bounded
      // lock_timeout probe (a REAL lock wait), then by the live append still
      // being pending.
      const bounded = storeOn(lockTimeoutAfterBegin('300ms'));
      const appendProbeError = await bounded
        .appendRecord({
          id: `${newerEmptyId}-probe`,
          sessionId: newerEmptyId,
          sceneId,
          createdAt: '2026-10-03T06:00:01.000Z',
          payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'B' } },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(asStorageLockUnavailable(appendProbeError)?.reason).toBe('lock-timeout');

      const senderStore = storeOn();
      const appendPromise = senderStore.appendRecord({
        id: `${newerEmptyId}-draft`,
        sessionId: newerEmptyId,
        sceneId,
        createdAt: '2026-10-03T06:00:02.000Z',
        payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'B' } },
      });
      held.push(appendPromise);
      const pendingProbe = await Promise.race([
        appendPromise.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 200);
        }),
      ]);
      expect(pendingProbe).toBe('pending'); // genuinely blocked on the lock

      // Release the barrier: the guard COMMITS first (its decision was made on
      // a stable snapshot — the sibling was EMPTY), then the append commits.
      releaseBarrier!();
      releaseBarrier = undefined;
      await expect(guardPromise).resolves.toBe(true);
      await expect(appendPromise).resolves.toMatchObject({ seq: 0 });

      // No obsolete activation and correct canonical state: the activation
      // committed exactly once with its own stamp, and the CANONICAL READER
      // adopts the newer session's record — the serialized activation did not
      // shadow the advanced lineage.
      const rootRow = await pool.query('SELECT data FROM runtime_sessions WHERE id = $1', [rootId]);
      const rawRoot = (rootRow as unknown as { rows: Array<{ data: unknown }> }).rows[0]!.data;
      const root = (typeof rawRoot === 'string' ? JSON.parse(rawRoot) : rawRoot) as {
        status: string;
        updatedAt: string;
      };
      expect(root.status).toBe('active');
      expect(root.updatedAt).toBe(stamp);
      const loaded = await loadQuizAttemptState(
        { stageId, sceneId },
        { store: senderStore, learnerKey },
      );
      expect(loaded.state?.sessionId).toBe(newerEmptyId);
      expect(loaded.state?.phase).toBe('draft');

      // A SECOND guard call now sees the relevant record: the root can never be
      // reactivated again (and the refusal writes nothing).
      const rootRowBefore = await pool.query('SELECT data FROM runtime_sessions WHERE id = $1', [
        rootId,
      ]);
      await expect(
        senderStore.setSessionStatusIfLatest!(rootId, 'active', '2026-10-03T07:00:00.000Z', {
          relevantSceneId: sceneId,
        }),
      ).resolves.toBe(false);
      const rootRowAfter = await pool.query('SELECT data FROM runtime_sessions WHERE id = $1', [
        rootId,
      ]);
      expect(rootRowAfter).toEqual(rootRowBefore);
    } finally {
      // Deterministic teardown in the SAME order for success and failure:
      // open the gate if a control failed before releasing it, let every
      // parked/blocked operation settle, close + release the guard's client,
      // and remove this case's isolated fixtures.
      releaseBarrier?.();
      await Promise.allSettled(held);
      if (guardClient !== undefined) {
        await guardClient.query('ROLLBACK').catch(() => undefined); // no-op post-commit
        guardClient.release();
      }
      await pool
        .query('DELETE FROM runtime_sessions WHERE stage_id = $1', [stageId])
        .catch(() => undefined);
    }
  });

  it('reader-equivalent relevance controls on the real server (positive AND negative)', async () => {
    const stageId = `guard-sem-${Date.now()}`;
    const learnerKey = 'learner-sem';
    const sceneId = 'scene-quiz';
    const rootId = `${stageId}-root`;
    const store = storeOn();
    const guard = store.setSessionStatusIfLatest!;
    const mkSession = (id: string, createdAt: string, status: 'active' | 'completed') =>
      store.createSession({
        id,
        kind: 'quizAttempt',
        stageId,
        learnerKey,
        status,
        createdAt,
        updatedAt: createdAt,
      });
    const append = (
      sessionId: string,
      id: string,
      createdAt: string,
      payload: Record<string, unknown>,
    ) =>
      store.appendRecord({
        id,
        sessionId,
        sceneId,
        createdAt,
        payload: payload as never,
      });

    try {
      await mkSession(rootId, '2026-10-03T00:00:00.000Z', 'active');
      await append(rootId, `${rootId}-review`, '2026-10-03T00:00:01.000Z', {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [{ questionId: 'q1', correct: null, status: 'ungraded', earned: 0 }],
      });
      await store.setSessionStatus(rootId, 'completed', '2026-10-03T00:00:02.000Z');

      // CONTROL A — other-scene quiz + newer EMPTY session: neither blocks.
      await mkSession(`${stageId}-other`, '2026-10-03T02:00:00.000Z', 'active');
      await store.appendRecord({
        id: `${stageId}-other-rec`,
        sessionId: `${stageId}-other`,
        sceneId: 'scene-OTHER',
        createdAt: '2026-10-03T02:00:01.000Z',
        payload: { payloadVersion: 1, phase: 'draft', answers: {} },
      });
      await mkSession(`${stageId}-empty`, '2026-10-03T03:00:00.000Z', 'active');
      await expect(
        guard.call(store, rootId, 'active', '2026-10-03T04:00:00.000Z', {
          relevantSceneId: sceneId,
        }),
      ).resolves.toBe(true);
      await store.setSessionStatus(rootId, 'completed', '2026-10-03T04:00:01.000Z');

      // CONTROL B — MALFORMED LATEST TAIL: a valid draft (seq 0) followed by a
      // scene tail the reader's payload check rejects (no payloadVersion —
      // stored by the skeleton gate, never adopted). The guard must NOT block,
      // and the canonical reader must still adopt the ROOT.
      await mkSession(`${stageId}-tail`, '2026-10-03T04:30:00.000Z', 'active');
      await append(`${stageId}-tail`, `${stageId}-tail-0`, '2026-10-03T04:30:01.000Z', {
        payloadVersion: 1,
        phase: 'draft',
        answers: { q1: 'A' },
      });
      await append(`${stageId}-tail`, `${stageId}-tail-1`, '2026-10-03T04:30:02.000Z', {
        phase: 'draft',
        answers: { q1: 'A' },
      });
      await expect(
        guard.call(store, rootId, 'active', '2026-10-03T04:31:00.000Z', {
          relevantSceneId: sceneId,
        }),
      ).resolves.toBe(true);
      let loaded = await loadQuizAttemptState({ stageId, sceneId }, { store, learnerKey });
      expect(loaded.state?.sessionId).toBe(rootId); // reader skips the sibling
      await store.setSessionStatus(rootId, 'completed', '2026-10-03T04:31:01.000Z');

      // CONTROL C — CORRUPT ENVELOPE sibling: an anchored record exists, but
      // the session envelope fails the same migrate+validate gate listSessions
      // applies, so the reader OMITS the session entirely and the guard must
      // not let it block.
      await mkSession(`${stageId}-corrupt`, '2026-10-03T04:40:00.000Z', 'active');
      await append(`${stageId}-corrupt`, `${stageId}-corrupt-0`, '2026-10-03T04:40:01.000Z', {
        payloadVersion: 1,
        phase: 'draft',
        answers: { q1: 'A' },
      });
      await pool.query(
        `UPDATE runtime_sessions
          SET data = data - 'runtimeDslVersion' || '{"status": 42}'::jsonb
        WHERE id = $1`,
        [`${stageId}-corrupt`],
      );
      await expect(
        guard.call(store, rootId, 'active', '2026-10-03T04:41:00.000Z', {
          relevantSceneId: sceneId,
        }),
      ).resolves.toBe(true);
      loaded = await loadQuizAttemptState({ stageId, sceneId }, { store, learnerKey });
      expect(loaded.state?.sessionId).toBe(rootId); // reader omits the corrupt row
      await store.setSessionStatus(rootId, 'completed', '2026-10-03T04:41:01.000Z');

      // CONTROL D — VALID LATEST relevant record blocks, and the refusal
      // leaves the root's committed metadata byte-for-byte untouched.
      await mkSession(`${stageId}-retry`, '2026-10-03T05:00:00.000Z', 'active');
      await append(`${stageId}-retry`, `${stageId}-retry-0`, '2026-10-03T05:00:01.000Z', {
        payloadVersion: 1,
        phase: 'draft',
        answers: { q1: 'B' },
      });
      const before = await pool.query('SELECT data FROM runtime_sessions WHERE id = $1', [rootId]);
      await expect(
        guard.call(store, rootId, 'active', '2026-10-03T06:00:00.000Z', {
          relevantSceneId: sceneId,
        }),
      ).resolves.toBe(false);
      const after = await pool.query('SELECT data FROM runtime_sessions WHERE id = $1', [rootId]);
      expect(after).toEqual(before); // zero metadata change

      // CONTROL E — corrupt capturePlan on an otherwise-adoptable newer
      // sibling: the guard still counts it RELEVANT (the payload is adoptable;
      // plan validation belongs to the reader), and the READER keeps its LOUD
      // error behavior.
      await mkSession(`${stageId}-plan`, '2026-10-03T07:00:00.000Z', 'active');
      await append(`${stageId}-plan`, `${stageId}-plan-0`, '2026-10-03T07:00:01.000Z', {
        payloadVersion: 1,
        phase: 'draft',
        answers: { q1: 'C' },
        capturePlan: { planVersion: 2 },
      });
      await expect(
        guard.call(store, rootId, 'active', '2026-10-03T07:30:00.000Z', {
          relevantSceneId: sceneId,
        }),
      ).resolves.toBe(false);
      await expect(
        loadQuizAttemptState({ stageId, sceneId }, { store, learnerKey }),
      ).rejects.toThrow(/capturePlan/);

      // GENERIC conservative form: a strictly newer sibling with no relevant
      // record still refuses the unanchored guarded write.
      await expect(guard.call(store, rootId, 'active', '2026-10-03T08:00:00.000Z')).resolves.toBe(
        false,
      );
    } finally {
      await pool
        .query('DELETE FROM runtime_sessions WHERE stage_id = $1', [stageId])
        .catch(() => undefined);
    }
  });

  it('READER-ORDER equivalence: zoned offsets, equal-instant serializations, and id tie-break decide in JS instant order — never SQL TEXT order', async () => {
    // The runtime validator ACCEPTS numeric-offset and fractional-second ISO
    // timestamps and arbitrary ids, while the canonical reader (and
    // listSessions) orders by Date.parse INSTANT with an id.localeCompare
    // tie-break. These controls pin the exact counterexamples where SQL TEXT
    // comparison of created_at/id disagrees with that order.
    const store = storeOn();
    const guard = store.setSessionStatusIfLatest!;
    const mkRoot = (args: {
      stageId: string;
      rootId: string;
      createdAt: string;
      recordId: string;
    }) =>
      store
        .createSession({
          id: args.rootId,
          kind: 'quizAttempt',
          stageId: args.stageId,
          learnerKey: 'learner-order',
          status: 'active',
          createdAt: args.createdAt,
          updatedAt: args.createdAt,
        })
        .then(() =>
          store.appendRecord({
            id: args.recordId,
            sessionId: args.rootId,
            sceneId: 'scene-quiz',
            createdAt: args.createdAt,
            payload: {
              payloadVersion: 1,
              phase: 'reviewed',
              answers: { q1: 'A' },
              results: [{ questionId: 'q1', correct: null, status: 'ungraded', earned: 0 }],
            },
          }),
        )
        .then(() => store.setSessionStatus(args.rootId, 'completed', '2026-10-03T12:00:00.000Z'));
    const mkSibling = (args: {
      stageId: string;
      siblingId: string;
      createdAt: string;
      answers?: Record<string, string>;
    }) =>
      store
        .createSession({
          id: args.siblingId,
          kind: 'quizAttempt',
          stageId: args.stageId,
          learnerKey: 'learner-order',
          status: 'active',
          createdAt: args.createdAt,
          updatedAt: args.createdAt,
        })
        .then(() =>
          store.appendRecord({
            id: `${args.siblingId}-rec`,
            sessionId: args.siblingId,
            sceneId: 'scene-quiz',
            createdAt: args.createdAt,
            payload: {
              payloadVersion: 1,
              phase: 'draft',
              answers: args.answers ?? { q1: 'B' },
            },
          }),
        );
    const rootRow = (rootId: string) =>
      pool.query('SELECT data FROM runtime_sessions WHERE id = $1', [rootId]);
    const stages: string[] = [];
    try {
      // CASE 1 — zoned-offset order: root `01:00:00+02:00` (Oct 2 23:00Z) is
      // OLDER by instant than child `00:00:00Z` (Oct 3 00:00Z), but TEXT
      // order says the opposite. The reader adopts the child; the guard must
      // REFUSE with byte-identical root metadata.
      const stage1 = `order-offset-${Date.now()}`;
      stages.push(stage1);
      await mkRoot({
        stageId: stage1,
        rootId: `${stage1}-root`,
        createdAt: '2026-10-03T01:00:00+02:00',
        recordId: `${stage1}-root-rec`,
      });
      await mkSibling({
        stageId: stage1,
        siblingId: `${stage1}-child`,
        createdAt: '2026-10-03T00:00:00Z',
      });
      const root1Before = await rootRow(`${stage1}-root`);
      await expect(
        guard.call(store, `${stage1}-root`, 'active', '2026-10-03T13:00:00.000Z', {
          relevantSceneId: 'scene-quiz',
        }),
      ).resolves.toBe(false);
      expect(await rootRow(`${stage1}-root`)).toEqual(root1Before); // zero writes
      const read1 = await loadQuizAttemptState(
        { stageId: stage1, sceneId: 'scene-quiz' },
        { store, learnerKey: 'learner-order' },
      );
      expect(read1.state?.sessionId).toBe(`${stage1}-child`); // reader adopts child

      // CASE 2 — genuinely OLDER by instant yet NEWER as TEXT: root
      // `2026-10-03T00:00:00Z` (00:00Z) vs sibling
      // `2026-10-03T01:00:00+02:00` (Oct 2 23:00Z). The reader keeps the
      // ROOT and the repair is legitimate; the OLD SQL TEXT predicate
      // ('01:00…' > '00:00…') would have blocked it.
      const stage2 = `order-older-${Date.now()}`;
      stages.push(stage2);
      await mkRoot({
        stageId: stage2,
        rootId: `${stage2}-root`,
        createdAt: '2026-10-03T00:00:00Z',
        recordId: `${stage2}-root-rec`,
      });
      await mkSibling({
        stageId: stage2,
        siblingId: `${stage2}-old-sibling`,
        createdAt: '2026-10-03T01:00:00+02:00',
      });
      await expect(
        guard.call(store, `${stage2}-root`, 'active', '2026-10-03T13:00:00.000Z', {
          relevantSceneId: 'scene-quiz',
        }),
      ).resolves.toBe(true);
      const read2 = await loadQuizAttemptState(
        { stageId: stage2, sceneId: 'scene-quiz' },
        { store, learnerKey: 'learner-order' },
      );
      expect(read2.state?.sessionId).toBe(`${stage2}-root`); // root stays canonical

      // CASE 2b — NEGATIVE offset: root `2026-10-03T00:00:00Z` (00:00Z) vs
      // relevant child `2026-10-02T20:00:00-05:00` (Oct 3 01:00Z). The child
      // is instant-NEWER but TEXT-older ('2026-10-02…' < '2026-10-03…'): the
      // reader adopts it and the guard must REFUSE with byte-identical root.
      const stage2b = `order-negative-${Date.now()}`;
      stages.push(stage2b);
      await mkRoot({
        stageId: stage2b,
        rootId: `${stage2b}-root`,
        createdAt: '2026-10-03T00:00:00Z',
        recordId: `${stage2b}-root-rec`,
      });
      await mkSibling({
        stageId: stage2b,
        siblingId: `${stage2b}-child`,
        createdAt: '2026-10-02T20:00:00-05:00',
      });
      const root2bBefore = await rootRow(`${stage2b}-root`);
      await expect(
        guard.call(store, `${stage2b}-root`, 'active', '2026-10-03T13:00:00.000Z', {
          relevantSceneId: 'scene-quiz',
        }),
      ).resolves.toBe(false);
      expect(await rootRow(`${stage2b}-root`)).toEqual(root2bBefore); // zero writes
      const read2b = await loadQuizAttemptState(
        { stageId: stage2b, sceneId: 'scene-quiz' },
        { store, learnerKey: 'learner-order' },
      );
      expect(read2b.state?.sessionId).toBe(`${stage2b}-child`); // reader adopts child

      // CASE 3 — EQUAL instant, different serialization (…Z vs ….000Z): TEXT
      // comparison never ties them, so the id tie-break was bypassed. The
      // reader ties by instant and breaks by localeCompare: a localeCompare-
      // GREATER sibling id is NEWER (refuse, byte-identical root), a SMALLER
      // one is older (legitimate repair).
      const stage3 = `order-equal-${Date.now()}`;
      stages.push(stage3);
      await mkRoot({
        stageId: stage3,
        rootId: `${stage3}-root-m`,
        createdAt: '2026-10-03T00:00:00Z',
        recordId: `${stage3}-root-rec`,
      });
      await mkSibling({
        stageId: stage3,
        siblingId: `${stage3}-sib-z`,
        createdAt: '2026-10-03T00:00:00.000Z',
      });
      const root3Before = await rootRow(`${stage3}-root-m`);
      await expect(
        guard.call(store, `${stage3}-root-m`, 'active', '2026-10-03T13:00:00.000Z', {
          relevantSceneId: 'scene-quiz',
        }),
      ).resolves.toBe(false); // id '…-sib-z' > '…-root-m' at the same instant
      expect(await rootRow(`${stage3}-root-m`)).toEqual(root3Before); // zero writes
      const read3 = await loadQuizAttemptState(
        { stageId: stage3, sceneId: 'scene-quiz' },
        { store, learnerKey: 'learner-order' },
      );
      expect(read3.state?.sessionId).toBe(`${stage3}-sib-z`); // reader adopts it

      // The opposite tie-break: a localeCompare-SMALLER sibling id at the
      // same instant is NOT newer — the repair legitimately proceeds.
      const stage4 = `order-equal-older-${Date.now()}`;
      stages.push(stage4);
      await mkRoot({
        stageId: stage4,
        rootId: `${stage4}-root-z`,
        createdAt: '2026-10-03T00:00:00Z',
        recordId: `${stage4}-root-rec`,
      });
      await mkSibling({
        stageId: stage4,
        siblingId: `${stage4}-aaa-sib`, // localeCompare-SMALLER than '…-root-z'
        createdAt: '2026-10-03T00:00:00.000Z',
      });
      await expect(
        guard.call(store, `${stage4}-root-z`, 'active', '2026-10-03T13:00:00.000Z', {
          relevantSceneId: 'scene-quiz',
        }),
      ).resolves.toBe(true);
      const read4 = await loadQuizAttemptState(
        { stageId: stage4, sceneId: 'scene-quiz' },
        { store, learnerKey: 'learner-order' },
      );
      expect(read4.state?.sessionId).toBe(`${stage4}-root-z`); // root stays canonical

      // CASE 5/6 — SAME serialization, ids where THIS database's SQL
      // collation and the reader's localeCompare DISAGREE. The
      // counterexample suffix pair is SELECTED LIVE from a bounded candidate
      // list, each candidate verified against the real server on the actual
      // full common-prefix ids, so the premise is proven on ANY collation
      // rather than assumed: glibc en_US ignores '-' at primary weight
      // (`…-quizax` < `…-quiz-x` per SQL, > per localeCompare) while
      // musl/C byte collation sorts non-ASCII after all ASCII (`…-qrz` <
      // `…-qäz` per SQL, > per localeCompare). One disagreement class must
      // exist on the connected server.
      const collationPremise = async (a: string, b: string): Promise<boolean> => {
        const sqlOrder = await pool.query(
          'SELECT id FROM (VALUES ($1::text), ($2::text)) AS v(id) ORDER BY id',
          [a, b],
        );
        const sqlFirst = (sqlOrder as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
        const localeFirst = a.localeCompare(b) < 0 ? a : b;
        return sqlFirst !== localeFirst;
      };
      const CANDIDATE_SUFFIX_PAIRS: ReadonlyArray<readonly [string, string]> = [
        ['quizax', 'quiz-x'], // glibc en_US: '-' ignored at primary weight
        ['qrz', 'qäz'], // musl/C byte order: U+00E4 sorts after all ASCII
      ];
      const stage5 = `order-collation-${Date.now()}`;
      const stage6 = `order-collation-older-${Date.now()}`;
      let sqlFirstSuffix = '';
      let localeFirstSuffix = '';
      for (const [suffixA, suffixB] of CANDIDATE_SUFFIX_PAIRS) {
        const a = `${stage5}-${suffixA}`;
        const b = `${stage5}-${suffixB}`;
        if (!(await collationPremise(a, b))) continue;
        const sqlOrder = await pool.query(
          'SELECT id FROM (VALUES ($1::text), ($2::text)) AS v(id) ORDER BY id',
          [a, b],
        );
        const sqlFirst = (sqlOrder as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
        sqlFirstSuffix = sqlFirst.slice(stage5.length + 1);
        localeFirstSuffix = (a.localeCompare(b) < 0 ? a : b).slice(stage5.length + 1);
        break;
      }
      // A real SQL-vs-JS disagreement exists on THIS server (the bounded
      // search found one) — the whole counterexample depends on it.
      expect(sqlFirstSuffix).not.toBe('');
      expect(localeFirstSuffix).not.toBe('');
      expect(sqlFirstSuffix).not.toBe(localeFirstSuffix);

      // CASE 5 — the UNSAFE direction: root is the pair's localeCompare-FIRST
      // id, sibling the SQL-first id, both at the same instant.
      // localeCompare: sibling NEWER (reader adopts it, guard refuses
      // byte-identically); SQL: sibling OLDER (the old TEXT predicate would
      // have allowed the obsolete activation).
      stages.push(stage5);
      await mkRoot({
        stageId: stage5,
        rootId: `${stage5}-${localeFirstSuffix}`,
        createdAt: '2026-10-03T00:00:00Z',
        recordId: `${stage5}-root-rec`,
      });
      await mkSibling({
        stageId: stage5,
        siblingId: `${stage5}-${sqlFirstSuffix}`,
        createdAt: '2026-10-03T00:00:00Z',
      });
      // The tie premise itself, live: both rows share ONE serialization.
      const tieRows = await pool.query(
        'SELECT created_at FROM runtime_sessions WHERE stage_id = $1',
        [stage5],
      );
      expect(
        new Set(
          (tieRows as unknown as { rows: Array<{ created_at: string }> }).rows.map(
            (row) => row.created_at,
          ),
        ).size,
      ).toBe(1);
      const root5Before = await rootRow(`${stage5}-${localeFirstSuffix}`);
      await expect(
        guard.call(store, `${stage5}-${localeFirstSuffix}`, 'active', '2026-10-03T13:00:00.000Z', {
          relevantSceneId: 'scene-quiz',
        }),
      ).resolves.toBe(false); // localeCompare tie-break: sibling is newer
      expect(await rootRow(`${stage5}-${localeFirstSuffix}`)).toEqual(root5Before); // zero writes
      const read5 = await loadQuizAttemptState(
        { stageId: stage5, sceneId: 'scene-quiz' },
        { store, learnerKey: 'learner-order' },
      );
      expect(read5.state?.sessionId).toBe(`${stage5}-${sqlFirstSuffix}`); // reader adopts sibling

      // CASE 6 — the mirrored FALSE-BLOCK direction: root is the SQL-first
      // id, sibling the localeCompare-first id, same instant. localeCompare:
      // sibling OLDER → legitimate repair (reader keeps the root); SQL:
      // sibling NEWER (the old TEXT predicate would have refused the repair).
      stages.push(stage6);
      await mkRoot({
        stageId: stage6,
        rootId: `${stage6}-${sqlFirstSuffix}`,
        createdAt: '2026-10-03T00:00:00Z',
        recordId: `${stage6}-root-rec`,
      });
      await mkSibling({
        stageId: stage6,
        siblingId: `${stage6}-${localeFirstSuffix}`,
        createdAt: '2026-10-03T00:00:00Z',
      });
      expect(
        await collationPremise(`${stage6}-${sqlFirstSuffix}`, `${stage6}-${localeFirstSuffix}`),
      ).toBe(true);
      await expect(
        guard.call(store, `${stage6}-${sqlFirstSuffix}`, 'active', '2026-10-03T13:00:00.000Z', {
          relevantSceneId: 'scene-quiz',
        }),
      ).resolves.toBe(true); // localeCompare tie-break: sibling is older
      const read6 = await loadQuizAttemptState(
        { stageId: stage6, sceneId: 'scene-quiz' },
        { store, learnerKey: 'learner-order' },
      );
      expect(read6.state?.sessionId).toBe(`${stage6}-${sqlFirstSuffix}`); // root stays canonical
    } finally {
      for (const stageId of stages) {
        await pool
          .query('DELETE FROM runtime_sessions WHERE stage_id = $1', [stageId])
          .catch(() => undefined);
      }
    }
  });

  it('MISSING-BOUNDARY control: a guard that settles BEFORE the barrier is detected PROMPTLY, without hanging teardown', async () => {
    const stageId = `guard-missing-boundary-${Date.now()}`;
    const learnerKey = 'learner-missing';
    const sceneId = 'scene-quiz';
    const rootId = `${stageId}-root`;
    const seed = storeOn();
    try {
      await seed.createSession({
        id: rootId,
        kind: 'quizAttempt',
        stageId,
        learnerKey,
        status: 'active',
        createdAt: '2026-10-03T00:00:00.000Z',
        updatedAt: '2026-10-03T00:00:00.000Z',
      });
      await seed.appendRecord({
        id: `${rootId}-review`,
        sessionId: rootId,
        sceneId,
        createdAt: '2026-10-03T00:00:01.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: { q1: 'A' },
          results: [{ questionId: 'q1', correct: null, status: 'ungraded', earned: 0 }],
        },
      });
      await seed.setSessionStatus(rootId, 'completed', '2026-10-03T00:00:02.000Z');
      // A RELEVANT newer sibling already exists: a correct guard returns FALSE
      // (no write, no UPDATE) — exactly the "regression shape" that must never
      // leave a harness parked on an arrival promise.
      await seed.createSession({
        id: `${stageId}-relevant`,
        kind: 'quizAttempt',
        stageId,
        learnerKey,
        status: 'active',
        createdAt: '2026-10-03T01:00:00.000Z',
        updatedAt: '2026-10-03T01:00:00.000Z',
      });
      await seed.appendRecord({
        id: `${stageId}-relevant-0`,
        sessionId: `${stageId}-relevant`,
        sceneId,
        createdAt: '2026-10-03T01:00:01.000Z',
        payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'B' } },
      });

      // A never-resolving arrival promise: the raced operation MUST win it.
      const barrierArrivedPromise = new Promise<void>(() => {});
      const startedAt = Date.now();
      const refused = seed.setSessionStatusIfLatest!(rootId, 'active', '2026-10-03T02:00:00.000Z', {
        relevantSceneId: sceneId,
      });
      const outcome = await Promise.race([
        barrierArrivedPromise.then(() => 'arrived' as const),
        refused.then(
          (wrote) => (wrote ? ('wrote' as const) : ('settled-before-barrier' as const)),
          () => 'rejected-before-barrier' as const,
        ),
        new Promise<'arrival-deadline'>((resolve) => {
          setTimeout(() => resolve('arrival-deadline'), 2_000);
        }),
      ]);
      // The control proves the DISCIPLINE (not the guard): an operation that
      // settles without reaching the barrier is detected in milliseconds —
      // far under the diagnostic deadline — so a parked arrival await can
      // never hang the suite's pool.end teardown.
      expect(outcome).toBe('settled-before-barrier');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await expect(refused).resolves.toBe(false); // the guard itself is correct
    } finally {
      await pool
        .query('DELETE FROM runtime_sessions WHERE stage_id = $1', [stageId])
        .catch(() => undefined);
    }
  });
});
