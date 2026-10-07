import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import { loadQuizAttemptState, type QuizAttemptRuntimeDeps } from '@/lib/quiz/runtime';

function makeHarness(): {
  store: RuntimeStore;
  deps: QuizAttemptRuntimeDeps;
  factory: IDBFactory;
  dbName: string;
} {
  const factory = new IDBFactory();
  const dbName = `quiz-cas-race-${Math.random()}`;
  const store = new BrowserRuntimeStore({ indexedDB: factory, dbName });
  let tick = 0;
  return {
    store,
    factory,
    dbName,
    deps: {
      store,
      learnerKey: 'learner-1',
      now: () => new Date(Date.UTC(2026, 6, 14, 12, 0, tick++)).toISOString(),
      mintRecordId: () => `record-${tick}`,
    },
  };
}

function wrapStore(store: RuntimeStore, overrides: Partial<RuntimeStore>): RuntimeStore {
  return new Proxy(store, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof RuntimeStore];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** True when this process has REAL Web Locks (the locked-environment run). */
const hasRealWebLocks =
  typeof navigator !== 'undefined' && !!(navigator as { locks?: unknown }).locks;

/**
 * The REAL committed session row, read through a raw store transaction —
 * observing durable commits, not method invocations.
 */
async function committedRootRow(
  factory: IDBFactory,
  dbName: string,
  rootId: string,
): Promise<Record<string, unknown>> {
  // An INDEPENDENT connection: never touch (or close) the store's cached one.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(dbName);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly');
      const get = tx.objectStore('sessions').get(rootId);
      get.onsuccess = () => resolve((get.result ?? {}) as Record<string, unknown>);
      get.onerror = () => reject(get.error);
    });
  } finally {
    db.close();
  }
}

/** Seed the legacy completed-but-undecided repair candidate. */
async function seedLegacyRoot(store: RuntimeStore): Promise<string> {
  const rootId = 'attempt-cas-race';
  await store.createSession({
    id: rootId,
    kind: 'quizAttempt',
    stageId: 'stage-1',
    learnerKey: 'learner-1',
    status: 'active',
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-14T12:00:00.000Z',
  });
  await store.appendRecord(
    {
      id: 'legacy-review',
      sessionId: rootId,
      sceneId: 'scene-quiz',
      createdAt: '2026-07-14T12:00:01.000Z',
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results: [
          { questionId: 'q1', correct: null, status: 'ungraded', earned: 0 },
          { questionId: 'q2', correct: true, status: 'correct', earned: 1 },
        ],
      },
    },
    { sessionTransition: { status: 'completed', updatedAt: '2026-07-14T12:00:02.000Z' } },
  );
  return rootId;
}

/** Advance the real lineage with a raw durable child (non-cooperating tab). */
async function advanceLineageWithChild(store: RuntimeStore, rootId: string): Promise<string> {
  const childId = `${rootId}:retry:1`;
  await store.createSession({
    id: childId,
    kind: 'quizAttempt',
    stageId: 'stage-1',
    learnerKey: 'learner-1',
    status: 'active',
    createdAt: '2026-07-14T12:05:00.000Z',
    updatedAt: '2026-07-14T12:05:00.000Z',
  });
  await store.appendRecord({
    id: 'child-draft',
    sessionId: childId,
    sceneId: 'scene-quiz',
    createdAt: '2026-07-14T12:05:01.000Z',
    payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'B' } },
  });
  return childId;
}

/**
 * P4 final-review barrier: the repair's activation write is HELD before it
 * starts, the lineage really advances (raw committed child), and the
 * released write must NEVER COMMIT an obsolete activation — asserted against
 * the REAL committed row (deep equality with the pre-race snapshot), never
 * merely against eventual compensation.
 */
async function runAtomicLineageBarrier(
  store: RuntimeStore,
  deps: QuizAttemptRuntimeDeps,
  factory: IDBFactory,
  dbName: string,
) {
  const input = { stageId: 'stage-1', sceneId: 'scene-quiz' };
  const rootId = await seedLegacyRoot(store);
  const rootBefore = await committedRootRow(factory, dbName, rootId);
  expect(rootBefore.status).toBe('completed');

  // Hold the FIRST setSessionStatusIfLatest (the repair's activation write)
  // BEFORE it starts; the atomic lineage check lives inside its transaction.
  let writeArrived!: () => void;
  const writeArrivedPromise = new Promise<void>((resolve) => {
    writeArrived = resolve;
  });
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let holdOnce = true;
  const pausedStore = wrapStore(store, {
    setSessionStatusIfLatest: async (
      ...args: Parameters<NonNullable<RuntimeStore['setSessionStatusIfLatest']>>
    ) => {
      if (holdOnce) {
        holdOnce = false;
        writeArrived();
        await writeGate; // the status write has NOT started
      }
      return store.setSessionStatusIfLatest!(...args);
    },
  });
  const loader = loadQuizAttemptState(input, { ...deps, store: pausedStore });
  await writeArrivedPromise; // repair is parked BEFORE its activation write

  // The lineage REALLY advances while the write is held.
  const childId = await advanceLineageWithChild(store, rootId);

  releaseWrite();
  const loaded = await loader;

  // Canonical reread returns the actual newer state/identity — the child.
  expect(loaded.attemptId).toBe(childId);
  expect(loaded.state?.sessionId).toBe(childId);
  // ZERO obsolete activations: the old root's committed row is byte-for-byte
  // its pre-race snapshot (status AND updatedAt AND every other field) —
  // the activation never committed, nothing compensated afterwards.
  const rootAfter = await committedRootRow(factory, dbName, rootId);
  expect(rootAfter).toEqual(rootBefore);
  // The newer child is intact.
  expect((await store.getSession(childId))?.status).toBe('active');
}

describe('P4 final review: atomic legacy lineage guard', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: IDBKeyRange,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no-Web-Locks environment EXECUTED: held activation never commits after the lineage advanced', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    expect(
      typeof navigator !== 'undefined' && !(navigator as { locks?: unknown }).locks,
      'receipt: this run executes the no-Web-Locks path',
    ).toBe(true);
    const { store, deps, factory, dbName } = makeHarness();
    await runAtomicLineageBarrier(store, deps, factory, dbName);
  });

  it('real-Web-Locks environment EXECUTED (raw non-cooperating writer): held activation never commits', async () => {
    // Receipt: this boundary FAILS loudly when the environment cannot
    // provide real Web Locks — a silent conditional return would fake it.
    expect(hasRealWebLocks, 'this environment must provide real Web Locks').toBe(true);
    const { store, deps, factory, dbName } = makeHarness();
    await runAtomicLineageBarrier(store, deps, factory, dbName);
  });

  it('POSITIVE control: a newer OTHER-SCENE quiz session never blocks this scene repair', async () => {
    const { store, deps } = makeHarness();
    const input = { stageId: 'stage-1', sceneId: 'scene-quiz' };
    const rootId = await seedLegacyRoot(store);
    // A genuinely newer quizAttempt of the SAME partition, anchored to a
    // DIFFERENT scene (its records never touch scene-quiz).
    await store.createSession({
      id: 'other-scene-quiz',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T13:00:00.000Z',
      updatedAt: '2026-07-14T13:00:00.000Z',
    });
    await store.appendRecord({
      id: 'other-scene-record',
      sessionId: 'other-scene-quiz',
      sceneId: 'scene-OTHER',
      createdAt: '2026-07-14T13:00:01.000Z',
      payload: { payloadVersion: 1, phase: 'draft', answers: { q9: 'Z' } },
    });
    const loaded = await loadQuizAttemptState(input, deps);
    // The repair is NOT blocked by the other-scene quiz: this scene's root
    // legitimately reactivates and remains the canonical attempt.
    expect(loaded.attemptId).toBe(rootId);
    expect(loaded.state?.status).toBe('active');
    expect(loaded.state?.phase).toBe('reviewed');
    expect((await store.getSession(rootId))?.status).toBe('active');
  });

  it('POSITIVE control: a newer EMPTY same-kind session never blocks the repair', async () => {
    const { store, deps } = makeHarness();
    const input = { stageId: 'stage-1', sceneId: 'scene-quiz' };
    const rootId = await seedLegacyRoot(store);
    await store.createSession({
      id: 'empty-newer-session',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T14:00:00.000Z',
      updatedAt: '2026-07-14T14:00:00.000Z',
    }); // no records at all — the canonical reader would never adopt it
    const loaded = await loadQuizAttemptState(input, deps);
    expect(loaded.attemptId).toBe(rootId);
    expect(loaded.state?.status).toBe('active');
    expect((await store.getSession(rootId))?.status).toBe('active');
  });

  it('ANCHORED vs GENERIC guard forms: a record-less newer sibling blocks only the generic form', async () => {
    const { store } = makeHarness();
    const rootId = await seedLegacyRoot(store);
    await store.createSession({
      id: 'any-newer-session',
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T15:00:00.000Z',
      updatedAt: '2026-07-14T15:00:00.000Z',
    });
    // ANCHORED guard: the newer sibling carries no record for the anchored
    // scene, so the guarded write for THAT scene legitimately commits.
    const wroteAnchored = await store.setSessionStatusIfLatest!(
      rootId,
      'active',
      '2026-07-14T15:30:00.000Z',
      { relevantSceneId: 'scene-OTHER' },
    );
    expect(wroteAnchored).toBe(true);
    // Back to completed for the generic probe below.
    await store.setSessionStatus(rootId, 'completed', '2026-07-14T15:30:30.000Z');
    // GENERIC conservative form (no anchor): the same newer sibling refuses.
    const wroteGeneric = await store.setSessionStatusIfLatest!(
      rootId,
      'active',
      '2026-07-14T15:31:00.000Z',
    );
    expect(wroteGeneric).toBe(false);
    expect((await store.getSession(rootId))?.status).toBe('completed');
  });

  it('genuine tail advancement still CAS-conflicts: a stale expectedLastSeq write aborts mid-transaction', async () => {
    const { store, factory, dbName } = makeHarness();
    const rootId = await seedLegacyRoot(store);
    // The uncontended guard activates (no sibling) — genuine repair.
    const wrote = await store.setSessionStatusIfLatest!(
      rootId,
      'active',
      '2026-07-14T12:10:00.000Z',
      { expectedLastSeq: 0 },
    );
    expect(wrote).toBe(true);
    // A real writer advances the root tail while it is active.
    await store.appendRecord({
      id: 'later-fact',
      sessionId: rootId,
      sceneId: 'scene-quiz',
      createdAt: '2026-07-14T12:11:00.000Z',
      payload: { payloadVersion: 1, phase: 'draft', answers: { q3: 'C' } },
    });
    // The STALE tail precondition aborts the whole write (nothing commits).
    const rootBefore = await committedRootRow(factory, dbName, rootId);
    await expect(
      store.setSessionStatusIfLatest!(rootId, 'completed', '2026-07-14T12:12:00.000Z', {
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow('@openmaic/storage');
    expect(await committedRootRow(factory, dbName, rootId)).toEqual(rootBefore);
  });

  it('uncontended legitimate repair: the only root reactivates and the canonical state is its review', async () => {
    const { store, deps } = makeHarness();
    const input = { stageId: 'stage-1', sceneId: 'scene-quiz' };
    const rootId = await seedLegacyRoot(store);
    const loaded = await loadQuizAttemptState(input, deps);
    expect(loaded.attemptId).toBe(rootId);
    expect(loaded.state?.phase).toBe('reviewed');
    expect(loaded.state?.status).toBe('active'); // genuinely reactivated
    expect((await store.getSession(rootId))?.status).toBe('active');
  });

  it('READER-EQUIVALENCE control: a newer sibling whose LATEST scene tail is malformed never blocks the repair (the reader skips it)', async () => {
    const { store, deps } = makeHarness();
    const input = { stageId: 'stage-1', sceneId: 'scene-quiz' };
    const rootId = await seedLegacyRoot(store);
    const siblingId = 'malformed-tail-newer';
    await store.createSession({
      id: siblingId,
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T16:00:00.000Z',
      updatedAt: '2026-07-14T16:00:00.000Z',
    });
    // seq 0: a valid scene-quiz draft the reader WOULD adopt…
    await store.appendRecord({
      id: 'sibling-draft-valid',
      sessionId: siblingId,
      sceneId: 'scene-quiz',
      createdAt: '2026-07-14T16:00:01.000Z',
      payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'B' } },
    });
    // …then seq 1: a malformed scene tail (no payloadVersion — it passes the
    // store's skeleton write gate but fails the canonical reader's payload
    // check, so the reader SKIPS the whole sibling).
    await store.appendRecord({
      id: 'sibling-tail-malformed',
      sessionId: siblingId,
      sceneId: 'scene-quiz',
      createdAt: '2026-07-14T16:00:02.000Z',
      payload: { phase: 'draft', answers: { q1: 'B' } },
    });

    const loaded = await loadQuizAttemptState(input, deps);
    // The malformed tail does not block: this scene's root legitimately
    // reactivates and REMAINS the canonical attempt.
    expect(loaded.attemptId).toBe(rootId);
    expect(loaded.state?.sessionId).toBe(rootId);
    expect(loaded.state?.status).toBe('active');
    expect((await store.getSession(rootId))?.status).toBe('active');
  });

  it('READER-EQUIVALENCE control: a newer sibling whose envelope listSessions omits never blocks the repair', async () => {
    const { store, deps, factory, dbName } = makeHarness();
    const input = { stageId: 'stage-1', sceneId: 'scene-quiz' };
    const rootId = await seedLegacyRoot(store);
    const siblingId = 'corrupt-envelope-newer';
    await store.createSession({
      id: siblingId,
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T17:00:00.000Z',
      updatedAt: '2026-07-14T17:00:00.000Z',
    });
    await store.appendRecord({
      id: 'corrupt-sibling-record',
      sessionId: siblingId,
      sceneId: 'scene-quiz',
      createdAt: '2026-07-14T17:00:01.000Z',
      payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'C' } },
    });
    // Corrupt the sibling's envelope in place (strip its version stamp): the
    // canonical reader's listSessions OMITS the session entirely.
    await new Promise<void>((resolve, reject) => {
      const open = factory.open(dbName);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('sessions', 'readwrite');
        const get = tx.objectStore('sessions').get(siblingId);
        get.onsuccess = () => {
          const row = get.result as Record<string, unknown>;
          delete row.runtimeDslVersion;
          tx.objectStore('sessions').put(row);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });

    const loaded = await loadQuizAttemptState(input, deps);
    expect(loaded.attemptId).toBe(rootId);
    expect(loaded.state?.sessionId).toBe(rootId);
    expect(loaded.state?.status).toBe('active');
  });

  it('READER-EQUIVALENCE control: an adoptable newer sibling with a CORRUPT capturePlan keeps the reader LOUD (never silently repaired)', async () => {
    const { store, deps } = makeHarness();
    const input = { stageId: 'stage-1', sceneId: 'scene-quiz' };
    await seedLegacyRoot(store);
    const siblingId = 'corrupt-plan-newer';
    await store.createSession({
      id: siblingId,
      kind: 'quizAttempt',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-07-14T18:00:00.000Z',
      updatedAt: '2026-07-14T18:00:00.000Z',
    });
    await store.appendRecord({
      id: 'corrupt-plan-record',
      sessionId: siblingId,
      sceneId: 'scene-quiz',
      createdAt: '2026-07-14T18:00:01.000Z',
      payload: {
        payloadVersion: 1,
        phase: 'draft',
        answers: { q1: 'D' },
        // PRESENT but structurally wrong: a loud error, never silently legacy.
        capturePlan: { planVersion: 2 },
      },
    });

    await expect(loadQuizAttemptState(input, deps)).rejects.toThrow(/capturePlan/);
    // The old root was NEVER touched by the failed load.
    expect((await store.getSession('attempt-cas-race'))?.status).toBe('completed');
  });
});
