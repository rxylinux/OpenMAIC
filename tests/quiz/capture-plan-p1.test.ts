/**
 * P1 focused regression (sequential-repair): the REAL RuntimeStore record
 * for a new review carries the complete capturePlan (header + items, and the
 * EMPTY-items header too); the active-reviewed completion replay forwards
 * the plan without minting a child; legacy no-plan records keep their
 * semantics; a genuinely corrupt plan surfaces a loud error.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import { loadQuizAttemptState, recordQuizAttempt, type QuizCapturePlan } from '@/lib/quiz/runtime';
import { questionEventId } from '@/lib/mistake-book/client';

function createRuntimeStoreForTests(): BrowserRuntimeStore {
  return new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
}
void (undefined as unknown as RuntimeStore);

const deps = (store: RuntimeStore) => ({
  store,
  learnerKey: 'learner-1',
  now: () => new Date(1_700_000_000_000).toISOString(),
});

function plan(overrides: Partial<QuizCapturePlan> = {}): QuizCapturePlan {
  return {
    planVersion: 1,
    originOwner: 'owner-a',
    originEpisodeId: 'a-p1',
    attemptId: 'a-p1',
    sceneId: 'sc',
    learnerKey: 'learner-1',
    items: [],
    ...overrides,
  };
}

describe('P1: real RuntimeStore capturePlan', () => {
  let store: BrowserRuntimeStore;
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    store = createRuntimeStoreForTests();
  });

  it("a new review's LAST record contains the complete plan (header + items)", async () => {
    const d = deps(store);
    const p = plan({
      items: [
        {
          questionId: 'q1',
          eventId: questionEventId('a-p1', 'q1'),
          payload: {
            stageId: 's',
            stageName: 'n',
            sceneId: 'sc',
            eventId: questionEventId('a-p1', 'q1'),
            items: [
              {
                questionId: 'q1',
                eventId: questionEventId('a-p1', 'q1'),
                questionType: 'single',
                question: 'q?',
                userAnswer: 'B',
              },
            ],
          } as never,
          recordToken: 'tok-1',
        },
      ],
    });
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-p1',
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        capturePlan: p,
      },
      d,
    );
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(loaded.state?.capturePlan).toEqual(p); // persisted AND surfaced
    const session = await store.getSession('a-p1');
    expect(session?.status).toBe('completed'); // plan-carrying review completes
  });

  it('an EMPTY-items plan still persists its header (owner/episode survive zero wrongs)', async () => {
    const d = deps(store);
    const empty = plan({
      originOwner: '',
      attemptId: 'a-empty',
      originEpisodeId: 'a-empty',
    }); // unknown origin, zero items
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-empty',
        phase: 'reviewed',
        answers: {},
        results: [],
        capturePlan: empty,
      },
      d,
    );
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(loaded.state?.capturePlan?.planVersion).toBe(1);
    expect(loaded.state?.capturePlan?.originOwner).toBe('');
    expect(loaded.state?.capturePlan?.items).toEqual([]);
  });

  it('active-reviewed completion replay forwards the plan and mints NO child', async () => {
    const d = deps(store);
    const p = plan({ attemptId: 'a-shadow', originEpisodeId: 'a-shadow' });
    // Seed an ACTIVE session whose tail review carries the plan (the
    // shadow-write shape: appended reviewed, completion write still owed).
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-shadow',
        phase: 'draft',
        answers: {},
      },
      d,
    );
    await store.appendRecord({
      id: 'shadow-reviewed',
      sessionId: 'a-shadow',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_100).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        capturePlan: p,
      },
    });
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    // The replay completed the session IN PLACE with the plan preserved.
    expect(loaded.attemptId).toBe('a-shadow');
    expect(loaded.state?.status).toBe('completed');
    expect(loaded.state?.capturePlan).toEqual(p);
    const sessions = await store.listSessions('s', 'learner-1');
    expect(sessions).toHaveLength(1); // no child minted
  });

  it('legacy records WITHOUT a plan keep historical semantics (no field, no error)', async () => {
    const d = deps(store);
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-legacy',
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
      },
      d,
    );
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(loaded.state?.capturePlan).toBeUndefined(); // legacy, not fake-empty
  });

  it('a PRESENT-but-corrupt plan is a LOUD error — never silently legacy', async () => {
    const d = deps(store);
    await recordQuizAttempt(
      { stageId: 's', sceneId: 'sc', attemptId: 'a-bad', phase: 'draft', answers: {} },
      d,
    );
    await store.appendRecord({
      id: 'bad-reviewed',
      sessionId: 'a-bad',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_200).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: {},
        results: [],
        capturePlan: { planVersion: 2 }, // corrupt: wrong version, no header
      },
    });
    await expect(loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d)).rejects.toThrow(
      /capturePlan/,
    );
  });

  it('corruption counters: wrong stageId, inner wrong question/event, multi-items all REJECTED; the legal snapshot passes', async () => {
    const d = deps(store);
    const validEvent = questionEventId('a-c1', 'q1');
    const basePayload = (overrides: Record<string, unknown> = {}) => ({
      stageId: 's',
      stageName: 'n',
      sceneId: 'sc',
      eventId: validEvent,
      items: [
        {
          questionId: 'q1',
          eventId: validEvent,
          questionType: 'single',
          question: 'q?',
          userAnswer: 'B',
        },
      ],
      ...overrides,
    });
    const seed = async (payloadItems: unknown, planItems?: unknown) => {
      await recordQuizAttempt(
        { stageId: 's', sceneId: 'sc', attemptId: 'a-c1', phase: 'draft', answers: {} },
        d,
      );
      await store.appendRecord({
        id: 'c1-reviewed',
        sessionId: 'a-c1',
        sceneId: 'sc',
        createdAt: new Date(1_700_000_001_000).toISOString(),
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: { q1: 'B' },
          results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
          capturePlan: plan({
            attemptId: 'a-c1',
            originEpisodeId: 'a-c1',
            items:
              planItems === undefined
                ? [
                    {
                      questionId: 'q1',
                      eventId: validEvent,
                      payload: basePayload() as never,
                      recordToken: 'tok-c1',
                    },
                  ]
                : (planItems as never),
          }),
        },
      });
      void payloadItems;
    };
    // Legal snapshot loads cleanly.
    await seed(undefined);
    const ok = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(ok.state?.capturePlan?.items).toHaveLength(1);

    // WRONG payload.stageId → rejected.
    await expect(
      (async () => {
        const store2 = createRuntimeStoreForTests();
        vi.stubGlobal('indexedDB', new IDBFactory());
        const d2 = deps(store2);
        await recordQuizAttempt(
          { stageId: 's', sceneId: 'sc', attemptId: 'a-c1', phase: 'draft', answers: {} },
          d2,
        );
        await store2.appendRecord({
          id: 'wrong-stage',
          sessionId: 'a-c1',
          sceneId: 'sc',
          createdAt: new Date(1_700_000_001_100).toISOString(),
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [],
            capturePlan: plan({
              attemptId: 'a-c1',
              originEpisodeId: 'a-c1',
              items: [
                {
                  questionId: 'q1',
                  eventId: validEvent,
                  payload: basePayload({ stageId: 'OTHER' }) as never,
                  recordToken: 'tok-w1',
                },
              ],
            }),
          },
        });
        await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d2);
      })(),
    ).rejects.toThrow(/stageId does not match/);

    // INNER wrong question → rejected.
    await expect(
      (async () => {
        const store3 = createRuntimeStoreForTests();
        vi.stubGlobal('indexedDB', new IDBFactory());
        const d3 = deps(store3);
        await recordQuizAttempt(
          { stageId: 's', sceneId: 'sc', attemptId: 'a-c1', phase: 'draft', answers: {} },
          d3,
        );
        await store3.appendRecord({
          id: 'inner-q',
          sessionId: 'a-c1',
          sceneId: 'sc',
          createdAt: new Date(1_700_000_001_200).toISOString(),
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [],
            capturePlan: plan({
              attemptId: 'a-c1',
              originEpisodeId: 'a-c1',
              items: [
                {
                  questionId: 'q1',
                  eventId: validEvent,
                  payload: basePayload({
                    items: [
                      {
                        questionId: 'q2',
                        eventId: validEvent,
                        questionType: 'single',
                        question: 'q?',
                        userAnswer: 'B',
                      },
                    ],
                  }) as never,
                  recordToken: 'tok-w2',
                },
              ],
            }),
          },
        });
        await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d3);
      })(),
    ).rejects.toThrow(/exactly this question\/event/);

    // INNER wrong eventId → rejected.
    await expect(
      (async () => {
        const store4 = createRuntimeStoreForTests();
        vi.stubGlobal('indexedDB', new IDBFactory());
        const d4 = deps(store4);
        await recordQuizAttempt(
          { stageId: 's', sceneId: 'sc', attemptId: 'a-c1', phase: 'draft', answers: {} },
          d4,
        );
        await store4.appendRecord({
          id: 'inner-ev',
          sessionId: 'a-c1',
          sceneId: 'sc',
          createdAt: new Date(1_700_000_001_300).toISOString(),
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [],
            capturePlan: plan({
              attemptId: 'a-c1',
              originEpisodeId: 'a-c1',
              items: [
                {
                  questionId: 'q1',
                  eventId: validEvent,
                  payload: basePayload({
                    items: [
                      {
                        questionId: 'q1',
                        eventId: 'not-the-event',
                        questionType: 'single',
                        question: 'q?',
                        userAnswer: 'B',
                      },
                    ],
                  }) as never,
                  recordToken: 'tok-w3',
                },
              ],
            }),
          },
        });
        await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d4);
      })(),
    ).rejects.toThrow(/exactly this question\/event/);

    // MULTI inner items → rejected (per-question snapshot is never a batch).
    await expect(
      (async () => {
        const store5 = createRuntimeStoreForTests();
        vi.stubGlobal('indexedDB', new IDBFactory());
        const d5 = deps(store5);
        await recordQuizAttempt(
          { stageId: 's', sceneId: 'sc', attemptId: 'a-c1', phase: 'draft', answers: {} },
          d5,
        );
        await store5.appendRecord({
          id: 'multi',
          sessionId: 'a-c1',
          sceneId: 'sc',
          createdAt: new Date(1_700_000_001_400).toISOString(),
          payload: {
            payloadVersion: 1,
            phase: 'reviewed',
            answers: {},
            results: [],
            capturePlan: plan({
              attemptId: 'a-c1',
              originEpisodeId: 'a-c1',
              items: [
                {
                  questionId: 'q1',
                  eventId: validEvent,
                  payload: basePayload({
                    items: [
                      {
                        questionId: 'q1',
                        eventId: validEvent,
                        questionType: 'single',
                        question: 'q?',
                        userAnswer: 'B',
                      },
                      {
                        questionId: 'q1',
                        eventId: validEvent,
                        questionType: 'single',
                        question: 'q?',
                        userAnswer: 'B',
                      },
                    ],
                  }) as never,
                  recordToken: 'tok-w4',
                },
              ],
            }),
          },
        });
        await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d5);
      })(),
    ).rejects.toThrow(/exactly this question\/event/);
  });

  it('a frozen snapshot carrying the knowledgePoint field still loads (the validator stays tolerant of new fields)', async () => {
    // Plans frozen after the same-point-practice feature carry knowledgePoint
    // inside the per-question payload. The validator judges identity fields
    // only; a future tightening into a strict whitelist would reject these
    // as corrupt (a LOUD error that blocks answer-state recovery) — this
    // regression keeps tolerance the pinned behavior.
    const d = deps(store);
    const validEvent = questionEventId('a-kp', 'q1');
    await recordQuizAttempt(
      { stageId: 's', sceneId: 'sc', attemptId: 'a-kp', phase: 'draft', answers: {} },
      d,
    );
    await store.appendRecord({
      id: 'kp-reviewed',
      sessionId: 'a-kp',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_002_000).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
        capturePlan: plan({
          attemptId: 'a-kp',
          originEpisodeId: 'a-kp',
          items: [
            {
              questionId: 'q1',
              eventId: validEvent,
              payload: {
                stageId: 's',
                stageName: 'n',
                sceneId: 'sc',
                eventId: validEvent,
                items: [
                  {
                    questionId: 'q1',
                    eventId: validEvent,
                    questionType: 'single',
                    question: 'q?',
                    knowledgePoint: '一元二次方程判别式',
                    userAnswer: 'B',
                  },
                ],
              } as never,
              recordToken: 'tok-kp',
            },
          ],
        }),
      },
    });

    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(loaded.state?.capturePlan?.items).toHaveLength(1);
  });

  it('LONG canonical ids (>200-char tuple) round-trip through write→read with the REAL encoding', async () => {
    const d = deps(store);
    const longAttempt = 'att-' + 'x'.repeat(260); // tuple exceeds the budget
    const longId = questionEventId(longAttempt, 'q-long');
    expect(longId.startsWith('ev:')).toBe(true); // the REAL SHA lane, not a fake helper
    const p = plan({
      attemptId: longAttempt,
      originEpisodeId: longAttempt,
      items: [
        {
          questionId: 'q-long',
          eventId: longId,
          payload: {
            stageId: 's',
            stageName: 'n',
            sceneId: 'sc',
            eventId: longId,
            items: [
              {
                questionId: 'q-long',
                eventId: longId,
                questionType: 'single',
                question: 'long?',
                userAnswer: 'B',
              },
            ],
          } as never,
          recordToken: 'tok-long',
        },
      ],
    });
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: longAttempt,
        phase: 'reviewed',
        answers: { 'q-long': 'B' },
        results: [{ questionId: 'q-long', correct: false, status: 'incorrect', earned: 0 }],
        capturePlan: p,
      },
      d,
    );
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(loaded.attemptId).toBe(longAttempt);
    expect(loaded.state?.capturePlan?.items[0]?.eventId).toBe(longId); // bit-identical
  });

  it('a plan header for ANOTHER attempt/scene is rejected on load', async () => {
    const d = deps(store);
    await recordQuizAttempt(
      { stageId: 's', sceneId: 'sc', attemptId: 'a-foreign', phase: 'draft', answers: {} },
      d,
    );
    await store.appendRecord({
      id: 'foreign-reviewed',
      sessionId: 'a-foreign',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_300).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: {},
        results: [],
        capturePlan: plan({ attemptId: 'a-different' }), // identity mismatch
      },
    });
    await expect(loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d)).rejects.toThrow(
      /does not match this attempt/,
    );
  });
});
