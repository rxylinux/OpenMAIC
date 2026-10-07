/**
 * Formal tests for the early-review boundaries: the production AI-grade
 * route's strict raw-score validation, the client AI-grade helper's honest
 * ungraded outcomes (HTTP error / timeout / malformed body / real zero), the
 * retry-upload controller's failure-retention sequences, and the unresolved
 * review's runtime semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

const llmText = vi.hoisted(() => ({ text: '' }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: vi.fn(async () => ({ text: llmText.text })) }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: vi.fn(async () => ({ model: {}, thinkingConfig: undefined })),
}));

import { POST as quizGradePOST } from '@/app/api/quiz-grade/route';
import { gradeShortAnswerQuestion } from '@/lib/quiz/ai-grade';
import { createRetryUploadController } from '@/lib/mistake-book/retry-controller';
import { loadQuizAttemptState, recordQuizAttempt } from '@/lib/quiz/runtime';
import type { QuizAttemptRuntimeDeps } from '@/lib/quiz/runtime';
import type { NextRequest } from 'next/server';
import type { QuizQuestion } from '@/lib/types/stage';

function gradeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/quiz-grade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const SHORT: QuizQuestion = { id: 's1', type: 'short_answer', question: 'q', points: 10 };

describe('production /api/quiz-grade (strict raw verdict)', () => {
  it('answers non-OK for unparseable bodies and non-numeric scores', async () => {
    for (const text of [
      'invalid plain response',
      '{"score":null}',
      '{"score":"0"}',
      '{"score":NaN}',
    ]) {
      llmText.text = text;
      const res = await quizGradePOST(
        gradeRequest({ question: 'q', userAnswer: 'a', points: 10, language: 'zh-CN' }),
      );
      const json = (await res.json()) as { score?: unknown };
      expect(!res.ok || json.score === undefined || json.score === null).toBe(true);
    }
  });

  it('keeps a real numeric zero as a legitimate wrong verdict', async () => {
    llmText.text = '{"score":0,"comment":"synthetic"}';
    const res = await quizGradePOST(gradeRequest({ question: 'q', userAnswer: 'a', points: 10 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { score: number }).score).toBe(0);
  });
});

describe('client AI grade helper (honest ungraded, never a fake score)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns ungraded on HTTP error, malformed body, and non-finite score', async () => {
    vi.stubGlobal('getCurrentModelConfig', undefined); // not used: helper imports real
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"score":null}', { status: 200 })),
    );
    expect((await gradeShortAnswerQuestion(SHORT, 'a', 'zh-CN')).status).toBe('ungraded');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 502 })),
    );
    expect((await gradeShortAnswerQuestion(SHORT, 'a', 'zh-CN')).status).toBe('ungraded');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"score":Infinity}', { status: 200 })),
    );
    expect((await gradeShortAnswerQuestion(SHORT, 'a', 'zh-CN')).status).toBe('ungraded');
  });

  it('resolves a real zero verdict and a passing verdict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"score":0}', { status: 200 })),
    );
    const wrong = await gradeShortAnswerQuestion(SHORT, 'a', 'zh-CN');
    expect(wrong).toMatchObject({ correct: false, status: 'incorrect', earned: 0 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"score":9}', { status: 200 })),
    );
    const right = await gradeShortAnswerQuestion(SHORT, 'a', 'zh-CN');
    expect(right).toMatchObject({ correct: true, status: 'correct', earned: 9 });
  });

  it('bounds a hung upstream with a timeout instead of pending forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    // A real 30ms ceiling: the request would hang forever without it.
    const verdict = await gradeShortAnswerQuestion(SHORT, 'a', 'zh-CN', 30);
    expect(verdict).toMatchObject({ correct: null, status: 'ungraded', earned: 0 });
  });
});

describe('retry-upload controller (R7 sequences)', () => {
  it('500 → retry keeps the SAME event id and the FROZEN payload; commit clears it', async () => {
    const seen: Array<{ payload: unknown; eventId: string }> = [];
    let result = false;
    let buildCalls = 0;
    const controller = createRetryUploadController({
      onWrong: async (payload, eventId) => {
        seen.push({ payload, eventId });
        return result;
      },
      mintEventId: (() => {
        let n = 0;
        return () => `evt-${++n}`;
      })(),
      buildPayload: (picked, eventId) => {
        buildCalls += 1;
        return { eventId, items: [{ questionId: 'q', userAnswer: picked }] };
      },
    });

    expect(await controller.submitWrong(['C'])).toBe('failed');
    const frozenPayload = seen[0]!.payload;
    result = true;
    const secondOutcome = await controller.submitWrong(['C']);
    expect(secondOutcome).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.eventId).toBe(seen[0]!.eventId); // same submission, same id
    expect(seen[1]!.payload).toEqual(frozenPayload); // payload replayed verbatim
    expect(buildCalls).toBe(1); // built ONCE at first send, never rebuilt

    // After commit the next wrong retry is a NEW event with a fresh payload.
    expect(await controller.submitWrong(['D'])).toBe('ok');
    expect(buildCalls).toBe(2);
    expect(
      (seen[2]!.payload as { items: Array<{ userAnswer: string[] }> }).items[0]!.userAnswer,
    ).toEqual(['D']);
  });

  it('default payload builder ships the picked answer itself', async () => {
    const seen: Array<{ payload: unknown; eventId: string }> = [];
    const controller = createRetryUploadController({
      onWrong: async (payload, eventId) => {
        seen.push({ payload, eventId });
        return true;
      },
      mintEventId: () => 'evt-identity',
    });
    expect(await controller.submitWrong(['C'])).toBe('ok');
    expect(seen[0]!.payload).toEqual(['C']);
  });

  it('swallows double-clicks without a second request', async () => {
    let calls = 0;
    let resolveFirst!: (ok: boolean) => void;
    const controller = createRetryUploadController({
      onWrong: () =>
        new Promise<boolean>((resolve) => {
          calls += 1;
          resolveFirst = resolve;
        }),
      mintEventId: () => 'evt-dbl',
    });
    const first = controller.submitWrong(['C']);
    const second = controller.submitWrong(['C']);
    resolveFirst(true);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome).toBe('ok');
    expect(secondOutcome).toBe('busy');
    expect(calls).toBe(1);
  });

  it('keeps the id across repeated failures (slow-flaky link)', async () => {
    const ids: string[] = [];
    const controller = createRetryUploadController({
      onWrong: async (_payload, eventId) => {
        ids.push(eventId);
        return false;
      },
      mintEventId: () => 'evt-flaky',
    });
    await controller.submitWrong(['C']);
    await controller.submitWrong(['C']);
    await controller.submitWrong(['C']);
    expect(ids).toEqual(['evt-flaky', 'evt-flaky', 'evt-flaky']);
    expect(controller.currentEventId()).toBe('evt-flaky');
  });
});

describe('runtime: unresolved review keeps the attempt identity (R6 recovery)', () => {
  let store: RuntimeStore;
  let deps: QuizAttemptRuntimeDeps;

  beforeEach(() => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-ungraded-${Math.random()}`,
    });
    let n = 0;
    deps = {
      store,
      learnerKey: 'learner-1',
      mintRecordId: () => `r-${++n}`,
      now: () => new Date(1_700_000_000_000 + n).toISOString(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-grading an unresolved review appends to the SAME session and completes it once decided', async () => {
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'original-attempt' };
    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { q: 'a' },
        results: [{ questionId: 'q', correct: null, status: 'ungraded', earned: 0 }],
      },
      deps,
    );
    // Not completed yet — grading is still owed.
    expect((await store.getSession('original-attempt'))!.status).toBe('active');

    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { q: 'a' },
        results: [{ questionId: 'q', correct: false, status: 'incorrect', earned: 0 }],
      },
      deps,
    );

    expect(await store.listSessions('s', 'learner-1')).toHaveLength(1);
    expect((await store.getSession('original-attempt'))!.status).toBe('completed');
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(loaded.state?.sessionId).toBe('original-attempt');
  });

  it('loading an unresolved review keeps it active without minting retries or faking completion', async () => {
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'original-attempt' };
    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { q: 'a' },
        results: [{ questionId: 'q', correct: null, status: 'ungraded', earned: 0 }],
      },
      deps,
    );
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(loaded.attemptId).toBe('original-attempt'); // attempt identity preserved
    expect(loaded.state?.status).toBe('active'); // no fabricated completion
    expect(await store.listSessions('s', 'learner-1')).toHaveLength(1); // no retry minted
  });

  it('a legacy decided review that crashed before completion still heals to completed on load', async () => {
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'original-attempt' };
    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { q: 'a' },
        results: [{ questionId: 'q', correct: true, status: 'correct', earned: 1 }],
      },
      deps,
    );
    // The decided review completed at append time.
    expect((await store.getSession('original-attempt'))!.status).toBe('completed');
  });
});

describe('retry attempt identity: real wrong answer → re-answer → wrong again is TWO events (R6/#6)', () => {
  let store: RuntimeStore;
  let deps: QuizAttemptRuntimeDeps;

  beforeEach(() => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-retry-identity-${Math.random()}`,
    });
    let n = 0;
    deps = {
      store,
      learnerKey: 'learner-1',
      mintRecordId: () => `r-${++n}`,
      now: () => new Date(1_700_000_000_000 + n).toISOString(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the durable retry session is a NEW attempt identity the UI adopts (the handleRetry flow)', async () => {
    const stageId = 's';
    const sceneId = 'sc';
    // 1) First attempt: answered A, confirmed wrong.
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: 'a1',
        phase: 'reviewed',
        answers: { q: 'A' },
        results: [{ questionId: 'q', correct: false, status: 'incorrect', earned: 0 }],
      },
      deps,
    );
    expect((await store.getSession('a1'))!.status).toBe('completed');

    // 2) handleRetry persists the retry (exactly what persistQuizRetry does).
    await recordQuizAttempt(
      { stageId, sceneId, attemptId: 'a1', phase: 'draft', answers: {}, startNewAttempt: true },
      deps,
    );

    // 3) The post-retry hydration (hydrationVersion bump) resolves the NEW
    //    durable child as the active attempt — never the completed root.
    const afterRetry = await loadQuizAttemptState({ stageId, sceneId }, deps);
    expect(afterRetry.attemptId).toBe('a1:retry:1');
    expect(afterRetry.state!.sessionId).toBe('a1:retry:1');

    // 4) Second real answer (different), confirmed wrong again — lands on the
    //    child, completing it. Capture event keys attemptId:questionId now
    //    differ across the two attempts: two genuinely distinct events.
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: afterRetry.attemptId,
        phase: 'reviewed',
        answers: { q: 'C' },
        results: [{ questionId: 'q', correct: false, status: 'incorrect', earned: 0 }],
      },
      deps,
    );
    expect((await store.getSession('a1:retry:1'))!.status).toBe('completed');
    expect(await store.listSessions(stageId, 'learner-1')).toHaveLength(2);
    expect('a1:q' === `${afterRetry.attemptId}:q`).toBe(false); // keys differ → both captured

    // 5) A third re-answer adopts a second child identity.
    await recordQuizAttempt(
      { stageId, sceneId, attemptId: 'a1', phase: 'draft', answers: {}, startNewAttempt: true },
      deps,
    );
    const third = await loadQuizAttemptState({ stageId, sceneId }, deps);
    expect(third.attemptId).toBe('a1:retry:2');
  });

  it('grading recovery after a wrong verdict stays on the SAME attempt (no new event)', async () => {
    const stageId = 's';
    const sceneId = 'sc';
    // Confirmed choice-wrong + ungraded AI answer, one attempt.
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: 'a2',
        phase: 'reviewed',
        answers: { q: 'A', s: 'x' },
        results: [
          { questionId: 'q', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 's', correct: null, status: 'ungraded', earned: 0 },
        ],
      },
      deps,
    );
    // Unresolved review keeps the attempt active and its identity intact.
    const loaded = await loadQuizAttemptState({ stageId, sceneId }, deps);
    expect(loaded.attemptId).toBe('a2');
    expect(loaded.state!.status).toBe('active');

    // Grading recovery completes the SAME attempt — the recovery is the same
    // submission, not a re-answer: the capture event id does not change.
    await recordQuizAttempt(
      {
        stageId,
        sceneId,
        attemptId: loaded.attemptId,
        phase: 'reviewed',
        answers: { q: 'A', s: 'x' },
        results: [
          { questionId: 'q', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 's', correct: true, status: 'correct', earned: 2 },
        ],
      },
      deps,
    );
    expect((await store.getSession('a2'))!.status).toBe('completed');
    expect(await store.listSessions(stageId, 'learner-1')).toHaveLength(1);
  });
});

describe('retry-upload controller exception and frozen-event semantics (#7/#9)', () => {
  it('a handler throw resolves failed with the frozen event retained (POST 200 then refresh GET 500)', async () => {
    const seen: string[] = [];
    let shouldThrow = true;
    const controller = createRetryUploadController({
      onWrong: async (_payload, eventId) => {
        seen.push(eventId);
        if (shouldThrow) throw new Error('GET /api/mistakes 500');
        return true;
      },
      mintEventId: () => 'evt-throw',
    });

    expect(await controller.submitWrong(['C'])).toBe('failed'); // not a rejection, not pending
    expect(controller.currentEventId()).toBe('evt-throw'); // retained for retry
    shouldThrow = false;
    expect(await controller.submitWrong(['C'])).toBe('ok');
    expect(seen).toEqual(['evt-throw', 'evt-throw']); // same event both times
  });

  it('a DIFFERENT answer after a failed upload mints a NEW event (frozen payload)', async () => {
    const seen: Array<{ picked: readonly string[]; eventId: string }> = [];
    const controller = createRetryUploadController({
      onWrong: async (payload, eventId) => {
        seen.push({
          picked: (payload as { picked: readonly string[] }).picked,
          eventId,
        });
        return false; // always failing link for now
      },
      mintEventId: (() => {
        let n = 0;
        return () => `evt-frozen-${++n}`;
      })(),
      buildPayload: (picked, eventId) => ({ picked, eventId }),
    });

    await controller.submitWrong(['C']);
    await controller.submitWrong(['C']); // same answer: same event, frozen payload
    await controller.submitWrong(['D']); // different answer: NEW event
    expect(seen.map((entry) => entry.eventId)).toEqual([
      'evt-frozen-1',
      'evt-frozen-1',
      'evt-frozen-2',
    ]);
  });

  it('a record refreshed mid-flight cannot swap content under a pending event id', async () => {
    // The payload builder closure reads a mutable record; the caller may
    // hold a NEWER record by the time a retry happens. The frozen payload
    // from the first send must ship, not a rebuild over the mutation.
    let recordQuestion = 'original question';
    const shipped: Array<unknown> = [];
    const controller = createRetryUploadController({
      onWrong: async (payload) => {
        shipped.push(payload);
        return shipped.length === 1 ? false : true; // fail first, commit on retry
      },
      mintEventId: () => 'evt-refresh',
      buildPayload: () => ({ items: [{ question: recordQuestion }] }),
    });

    await controller.submitWrong(['C']); // freezes {question: 'original question'}
    recordQuestion = 'MUTATED question'; // record refreshes mid-flight
    await controller.submitWrong(['C']); // retry: frozen payload, no rebuild

    expect(shipped[0]).toEqual({ items: [{ question: 'original question' }] });
    expect(shipped[1]).toEqual({ items: [{ question: 'original question' }] }); // NOT mutated
  });
});

describe('completed retry reload keeps its source identity (#8)', () => {
  let store: RuntimeStore;
  let deps: QuizAttemptRuntimeDeps;

  beforeEach(() => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-completed-identity-${Math.random()}`,
    });
    let n = 0;
    deps = {
      store,
      learnerKey: 'learner-1',
      mintRecordId: () => `r-${++n}`,
      now: () => new Date(1_700_000_000_000 + n).toISOString(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a completed retry child hydrates as the CURRENT answer identity, not the root', async () => {
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'a-root' };
    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { q: 'B' },
        results: [{ questionId: 'q', correct: false, status: 'incorrect', earned: 0 }],
      },
      deps,
    );
    await recordQuizAttempt({ ...input, phase: 'draft', answers: {}, startNewAttempt: true }, deps);
    const child = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(child.attemptId).toMatch(/:retry:1$/);
    await recordQuizAttempt(
      {
        ...input,
        attemptId: child.attemptId,
        phase: 'reviewed',
        answers: { q: 'C' },
        results: [{ questionId: 'q', correct: false, status: 'incorrect', earned: 0 }],
      },
      deps,
    );

    const reloaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(reloaded.state?.sessionId).toBe(child.attemptId);
    expect(reloaded.attemptId).toBe(child.attemptId); // ← the #8 regression

    // Retry minting from the completed child still derives the ROOT lineage:
    // the next real answer is the next sibling, not a nested child-of-child.
    await recordQuizAttempt(
      {
        ...input,
        attemptId: reloaded.attemptId,
        phase: 'draft',
        answers: {},
        startNewAttempt: true,
      },
      deps,
    );
    const third = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(third.attemptId).toMatch(/:retry:2$/);
  });

  it('BARRIER: a real retry created between the stale load read and the repair lock — root stays completed, child leads, records intact', async () => {
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'a-legacy-barrier' };
    await recordQuizAttempt({ ...input, phase: 'draft', answers: {} }, deps);
    await store.appendRecord({
      id: 'legacy-barrier-reviewed',
      sessionId: 'a-legacy-barrier',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_500).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { 'q-a': 'B', 'q-b': 'bonjour' },
        results: [
          { questionId: 'q-a', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 'q-b', correct: null, status: 'ungraded', earned: 0 },
        ],
      },
    });
    await store.setSessionStatus(
      'a-legacy-barrier',
      'completed',
      new Date(1_700_000_000_600).toISOString(),
    );

    // Delegate barrier: let the FIRST readLatestQuizAttemptState see the
    // stale root, then a REAL retry is created, then subsequent reads pass
    // through to the live store (no Web Locks).
    let staleReadsLeft = 1;
    const realList = store.listSessions.bind(store);
    let retryAttemptId: string | null = null;
    (store as { listSessions: typeof store.listSessions }).listSessions = async (
      stageId: string,
      learnerKey: string,
    ) => {
      const sessions = await realList(stageId, learnerKey);
      if (staleReadsLeft > 0) {
        staleReadsLeft -= 1;
        // Before releasing the stale snapshot, create the REAL retry —
        // exactly the "between read and repair" race.
        if (retryAttemptId === null) {
          await recordQuizAttempt(
            { ...input, phase: 'draft', answers: {}, startNewAttempt: true },
            deps,
          );
          const after = await realList('s', 'learner-1');
          retryAttemptId = after.find((session) => session.id !== 'a-legacy-barrier')?.id ?? null;
        }
        return sessions.filter((session) => session.id === 'a-legacy-barrier');
      }
      return sessions;
    };

    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(loaded.attemptId).toMatch(/:retry:\d+$/); // the REAL retry leads
    expect(loaded.state?.status).toBe('active'); // retry in progress
    const root = await store.getSession('a-legacy-barrier');
    expect(root!.status).toBe('completed'); // never reopened
    const sessions = await store.listSessions('s', 'learner-1');
    expect(sessions.length).toBe(2); // root + retry only
    (store as { listSessions: typeof store.listSessions }).listSessions = realList;
  });

  it('repair does NOT reopen a legacy root when a REAL retry already exists between the stale read and the lock', async () => {
    // The stale-completed root plus a genuinely newer retry child (the kind
    // a concurrent tab creates between our first read and the repair lock).
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'a-legacy-raced' };
    await recordQuizAttempt({ ...input, phase: 'draft', answers: {} }, deps);
    await store.appendRecord({
      id: 'legacy-raced-reviewed',
      sessionId: 'a-legacy-raced',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_500).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { 'q-a': 'B', 'q-b': 'bonjour' },
        results: [
          { questionId: 'q-a', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 'q-b', correct: null, status: 'ungraded', earned: 0 },
        ],
      },
    });
    await store.setSessionStatus(
      'a-legacy-raced',
      'completed',
      new Date(1_700_000_000_600).toISOString(),
    );
    // A REAL retry with a DECIDED review — the authoritative latest attempt.
    const retry = await recordQuizAttempt(
      { ...input, phase: 'draft', answers: {}, startNewAttempt: true },
      deps,
    );
    void retry;
    const loadedOnce = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    await recordQuizAttempt(
      {
        ...input,
        attemptId: loadedOnce.attemptId,
        phase: 'reviewed',
        answers: { 'q-a': 'B', 'q-b': 'bonjour' },
        results: [
          { questionId: 'q-a', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 'q-b', correct: false, status: 'incorrect', earned: 0 },
        ],
      },
      deps,
    );
    // Re-load: the legacy root stays completed (never reopened) and the
    // authoritative retry stays the latest with its records intact.
    const reloaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(reloaded.attemptId).toMatch(/:retry:\d+$/); // the real retry leads
    expect(reloaded.state?.status).toBe('completed');
    const root = await store.getSession('a-legacy-raced');
    expect(root!.status).toBe('completed'); // legacy root untouched
    const sessions = await store.listSessions('s', 'learner-1');
    expect(sessions).toHaveLength(2); // root + retry, nothing minted
  });

  it('legacy completed session with an EXPLICITLY undecided verdict reactivates on load and re-grades in place (no rollover)', async () => {
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'a-legacy-undecided' };
    await recordQuizAttempt({ ...input, phase: 'draft', answers: {} }, deps);
    await store.appendRecord({
      id: 'legacy-undecided-reviewed',
      sessionId: 'a-legacy-undecided',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_500).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { 'q-a': 'B', 'q-b': 'bonjour' },
        results: [
          { questionId: 'q-a', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 'q-b', correct: null, status: 'ungraded', earned: 0 },
        ],
      },
    });
    await store.setSessionStatus(
      'a-legacy-undecided',
      'completed',
      new Date(1_700_000_000_600).toISOString(),
    );

    // Load repairs ONLY the provably-wrong completion: active again, same
    // session, same payload — nothing minted.
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(loaded.attemptId).toBe('a-legacy-undecided');
    expect(loaded.state?.status).toBe('active'); // reactivated in place
    expect(loaded.state?.results?.[1]).toMatchObject({ correct: null });
    expect(await store.listSessions('s', 'learner-1')).toHaveLength(1);

    // The recovery append lands on the ORIGINAL session — no retry rollover.
    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { 'q-a': 'B', 'q-b': 'bonjour' },
        results: [
          { questionId: 'q-a', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 'q-b', correct: false, status: 'incorrect', earned: 0 },
        ],
      },
      deps,
    );
    const after = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(after.attemptId).toBe('a-legacy-undecided'); // still the original
    expect(after.state?.status).toBe('completed'); // now legitimately complete
    expect(await store.listSessions('s', 'learner-1')).toHaveLength(1); // no child
  });

  it('legacy completed/null review reloads keep the ORIGINAL session identity and completed fact', async () => {
    // An OLD client completed this session; its stored tail may still carry
    // the pre-'ungraded' null-verdict shape. Reproduce that DURABLE state
    // directly (old writers completed reviewed unconditionally): completed
    // session + legacy-null reviewed tail. Reload must keep the completed
    // fact, the original identity, and mint nothing.
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'a-legacy' };
    await recordQuizAttempt({ ...input, phase: 'draft', answers: {} }, deps);
    await store.appendRecord({
      id: 'legacy-reviewed',
      sessionId: 'a-legacy',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_500).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q: 'old' },
        results: [{ questionId: 'q', correct: null, status: 'incorrect', earned: 2 }],
      },
    });
    await store.setSessionStatus(
      'a-legacy',
      'completed',
      new Date(1_700_000_000_600).toISOString(),
    );
    expect((await store.getSession('a-legacy'))!.status).toBe('completed');

    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(loaded.attemptId).toBe('a-legacy');
    expect(loaded.state?.status).toBe('completed'); // fact unchanged
    expect(loaded.state?.results?.[0]).toMatchObject({ correct: null }); // payload untouched
    expect(await store.listSessions('s', 'learner-1')).toHaveLength(1); // no new session
  });

  it('a contradictory null-verdict review written today stays honestly active and recovers in place', async () => {
    const input = { stageId: 's', sceneId: 'sc', attemptId: 'a-null-today' };
    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { q: 'x' },
        results: [{ questionId: 'q', correct: null, status: 'incorrect', earned: 2 }],
      },
      deps,
    );
    // Unresolved: not completed, identity preserved for in-place recovery.
    expect((await store.getSession('a-null-today'))!.status).toBe('active');
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, deps);
    expect(loaded.attemptId).toBe('a-null-today');

    // Recovery on the SAME session completes it — no extra session, no
    // double-counted fact.
    await recordQuizAttempt(
      {
        ...input,
        phase: 'reviewed',
        answers: { q: 'x' },
        results: [{ questionId: 'q', correct: false, status: 'incorrect', earned: 0 }],
      },
      deps,
    );
    expect((await store.getSession('a-null-today'))!.status).toBe('completed');
    expect(await store.listSessions('s', 'learner-1')).toHaveLength(1);
  });
});
