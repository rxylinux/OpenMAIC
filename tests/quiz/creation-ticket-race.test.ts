import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import {
  loadQuizAttemptState,
  recordQuizAttempt,
  type QuizAttemptRuntimeDeps,
} from '@/lib/quiz/runtime';
import { persistQuizRetry, redeemCreationTicket } from '@/lib/quiz/view-state';
import type { QuestionResult } from '@/lib/quiz/grading';

const results: QuestionResult[] = [
  { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
];

function makeHarness(): { store: RuntimeStore; deps: QuizAttemptRuntimeDeps } {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `quiz-ticket-${Math.random()}`,
  });
  let tick = 0;
  return {
    store,
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

/**
 * The reader/hydration path holds the root attempt lock when Web Locks
 * exist; pausing it would deadlock the other actor's real writes on the
 * same lineage. The no-Web-Locks environment is the honest one for this
 * race (mirrors tests/quiz/runtime.test.ts).
 */
function withoutWebLocks() {
  vi.stubGlobal('navigator', { locks: undefined });
}

describe('live retry-creation receipt vs canonical hydration (r4 closing group 2)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', {
      configurable: true,
      value: IDBKeyRange,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("THIS operation creates X and holds its LIVE receipt; a paused canonical reader returns another actor's Y — redemption refuses Y", async () => {
    withoutWebLocks();
    const { store, deps } = makeHarness();
    const stageId = 'stage-1';
    const sceneId = 'scene-quiz';
    const rootAttempt = 'attempt-ticket-race';

    // The lineage starts from a completed parent (the only state a retry
    // transition can legally follow).
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: rootAttempt,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps,
    );

    // THIS operation's REAL retry write: persistQuizRetry drives the actual
    // recordQuizAttempt on the real store and mints the typed receipt for
    // the child it creates (X).
    const childX = `${rootAttempt}:retry:1`;
    const receipt = await persistQuizRetry(
      { stageId, sceneId, attemptId: rootAttempt },
      {
        recordPhase: (input) =>
          recordQuizAttempt(input, {
            ...deps,
            // The writer runs on the RAW store: this write must complete
            // before the reader below is even started.
            store,
          }),
      },
    );
    expect(receipt).toEqual({
      kind: 'retry-child-created',
      childAttemptId: childX,
      parentAttemptId: rootAttempt,
      stageId,
      sceneId,
    });
    // The receipt is ALIVE (hydration has not consumed it yet).

    // Pause the canonical reader BEFORE it queries the latest sessions: its
    // FIRST listSessions never reaches the store until released.
    let releaseReader!: () => void;
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    let listSessionsCalls = 0;
    const pausedStore = wrapStore(store, {
      listSessions: async (...args: Parameters<RuntimeStore['listSessions']>) => {
        listSessionsCalls += 1;
        if (listSessionsCalls === 1) await readerGate;
        return store.listSessions(...args);
      },
    });
    const reader = loadQuizAttemptState({ stageId, sceneId }, { ...deps, store: pausedStore });
    await vi.waitFor(() => expect(listSessionsCalls).toBe(1)); // paused pre-query

    // ANOTHER ACTOR uses the real writer: it completes X and creates its
    // own newer child Y — the canonical latest advances past X while this
    // view's receipt for X is still live.
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: childX,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps,
    );
    await recordQuizAttempt(
      { stageId, sceneId, attemptId: childX, phase: 'draft', answers: {}, startNewAttempt: true },
      deps,
    );
    const childY = `${rootAttempt}:retry:2`;
    expect((await store.listSessions(stageId, 'learner-1')).map((s) => s.id)).toEqual([
      rootAttempt,
      childX,
      childY,
    ]);

    // Release the reader: the ACTUAL canonical read now returns Y (with
    // stored state) while X's receipt is still alive.
    releaseReader();
    const loaded = await reader;
    expect(loaded.attemptId).toBe(childY); // canonical truly advanced to Y
    expect(loaded.state?.sessionId).toBe(childY);

    // The PRODUCTION redemption rule (the same helper QuizView hydrates
    // through) refuses Y: another actor's child never gains this episode's
    // original-operation capability from X's receipt.
    expect(
      redeemCreationTicket(receipt, {
        attemptId: loaded.attemptId,
        fromEmpty: loaded.state === undefined,
        stageId,
        sceneId,
      }),
    ).toBeNull();
    // The receipt itself still names X — refusing Y did not mint anything.
    expect(receipt?.childAttemptId).toBe(childX);
  });

  it('uncontended: the same production redemption accepts ONLY the exact created child X', async () => {
    withoutWebLocks();
    const { deps } = makeHarness();
    const stageId = 'stage-1';
    const sceneId = 'scene-quiz';
    const rootAttempt = 'attempt-ticket-clean';
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: rootAttempt,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps,
    );
    const childX = `${rootAttempt}:retry:1`;
    const receipt = await persistQuizRetry(
      { stageId, sceneId, attemptId: rootAttempt },
      { recordPhase: (input) => recordQuizAttempt(input, deps) },
    );
    expect(receipt?.childAttemptId).toBe(childX);

    // No other actor: canonical hydration returns exactly X, and the
    // production redemption accepts exactly X.
    const loaded = await loadQuizAttemptState({ stageId, sceneId }, deps);
    expect(loaded.attemptId).toBe(childX);
    expect(
      redeemCreationTicket(receipt, {
        attemptId: loaded.attemptId,
        fromEmpty: loaded.state === undefined,
        stageId,
        sceneId,
      }),
    ).toBe(childX);
    // Any OTHER hydrated attempt — the completed root, a hypothetical newer
    // child, a different stage/scene context — is refused, and an empty
    // canonical read with a live ticket is a contradiction (never a grant).
    expect(
      redeemCreationTicket(receipt, { attemptId: rootAttempt, fromEmpty: false, stageId, sceneId }),
    ).toBeNull();
    expect(
      redeemCreationTicket(receipt, {
        attemptId: `${rootAttempt}:retry:9`,
        fromEmpty: false,
        stageId,
        sceneId,
      }),
    ).toBeNull();
    expect(
      redeemCreationTicket(receipt, {
        attemptId: childX,
        fromEmpty: false,
        stageId: 'stage-OTHER',
        sceneId,
      }),
    ).toBeNull();
    expect(
      redeemCreationTicket(receipt, { attemptId: childX, fromEmpty: true, stageId, sceneId }),
    ).toBeNull();
    expect(
      redeemCreationTicket(null, { attemptId: 'fresh-root', fromEmpty: true, stageId, sceneId }),
    ).toBe('fresh-root'); // the first-ever grant survives (no live ticket)
  });

  it('a retry landing on an EXISTING child mints no receipt (real writer, real store)', async () => {
    withoutWebLocks();
    const { deps } = makeHarness();
    const stageId = 'stage-1';
    const sceneId = 'scene-quiz';
    const rootAttempt = 'attempt-ticket-existing';
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: rootAttempt,
        phase: 'reviewed',
        answers: { q1: 'A' },
        results,
      },
      deps,
    );
    // Another actor already minted the active child with an empty draft.
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: rootAttempt,
        phase: 'draft',
        answers: {},
        startNewAttempt: true,
      },
      deps,
    );
    // THIS episode's retry lands on that existing child — nothing was
    // created here, so no capability may be minted.
    const receipt = await persistQuizRetry(
      { stageId, sceneId, attemptId: rootAttempt },
      { recordPhase: (input) => recordQuizAttempt(input, deps) },
    );
    expect(receipt).toBeNull();
    expect(
      redeemCreationTicket(receipt, {
        attemptId: `${rootAttempt}:retry:1`,
        fromEmpty: false,
        stageId,
        sceneId,
      }),
    ).toBeNull();
  });
});
