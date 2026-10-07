/**
 * P3 §4 focused tests: the durable legacy historical-exemption baseline —
 * questions already decided wrong in a real no-plan (legacy) review never
 * re-enter a modern plan's items, and that fact survives modern reloads and
 * successive regrades. The exemption baseline is computed ONLY from
 * pre-existing decided-wrong results of a plan-less attempt
 * (legacyExemptQuestionIds), frozen into the plan header
 * (legacyExemptQuestions), fully validated by the runtime reader, preserved
 * by shadow/canonical replay, and rebuilt fresh for a genuinely NEW attempt.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import {
  legacyExemptQuestionIds,
  loadQuizAttemptState,
  recordQuizAttempt,
  type QuizCapturePlan,
} from '@/lib/quiz/runtime';
import type { QuestionResult } from '@/lib/quiz/grading';
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
    originEpisodeId: 'a-p3',
    attemptId: 'a-p3',
    sceneId: 'sc',
    learnerKey: 'learner-1',
    items: [],
    ...overrides,
  };
}

const wrong = (questionId: string): QuestionResult => ({
  questionId,
  correct: false,
  status: 'incorrect',
  earned: 0,
});
const ungraded = (questionId: string): QuestionResult => ({
  questionId,
  correct: null,
  status: 'ungraded',
  earned: 0,
});
const right = (questionId: string): QuestionResult => ({
  questionId,
  correct: true,
  status: 'correct',
  earned: 1,
});

describe('P3 §4: legacyExemptQuestionIds (the upgrade baseline decision)', () => {
  it('a plan-less attempt exempts exactly its PRE-EXISTING decided-wrong questions', () => {
    expect(
      legacyExemptQuestionIds(null, [wrong('q1'), ungraded('q2'), right('q3'), wrong('q4')]),
    ).toEqual(['q1', 'q4']);
    expect(legacyExemptQuestionIds(undefined, [])).toEqual([]);
  });

  it('an existing plan carries its OWN frozen baseline forward immutably', () => {
    const prev = plan({ legacyExemptQuestions: ['q1'] });
    // New wrongs in LATER grades never extend or shrink the frozen baseline:
    expect(legacyExemptQuestionIds(prev, [wrong('q1'), wrong('q2'), wrong('q3')])).toEqual(['q1']);
    expect(legacyExemptQuestionIds(plan({}), [wrong('q9')])).toEqual([]);
  });
});

describe('P3 §4: legacyExemptQuestions in the runtime contract', () => {
  let store: BrowserRuntimeStore;
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    store = createRuntimeStoreForTests();
  });

  it('a modern plan freezing the exemption round-trips and its items EXCLUDE the historical wrong', async () => {
    const d = deps(store);
    // The historical legacy review (NO plan): q1 wrong, q2 ungraded.
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-p3',
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [wrong('q1'), ungraded('q2')],
      },
      d,
    );
    const legacy = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(legacy.state?.capturePlan).toBeUndefined(); // genuinely legacy
    // The upgrade (regrade decides q2 wrong): the NEW plan freezes the
    // baseline and carries ONLY the newly-decided q2 item.
    const upgraded = plan({
      legacyExemptQuestions: legacyExemptQuestionIds(null, [wrong('q1'), ungraded('q2')]),
      items: [
        {
          questionId: 'q2',
          eventId: questionEventId('a-p3', 'q2'),
          payload: {
            stageId: 's',
            stageName: 'n',
            sceneId: 'sc',
            eventId: questionEventId('a-p3', 'q2'),
            items: [
              {
                questionId: 'q2',
                eventId: questionEventId('a-p3', 'q2'),
                questionType: 'single',
                question: 'q?',
                userAnswer: 'B',
              },
            ],
          } as never,
          recordToken: 'tok-q2',
        },
      ],
    });
    expect(upgraded.legacyExemptQuestions).toEqual(['q1']);
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-p3',
        phase: 'reviewed',
        answers: { q1: 'B', q2: 'C' },
        results: [wrong('q1'), wrong('q2')],
        capturePlan: upgraded,
      },
      d,
    );
    // Reload: the exemption AND the q2-only items survive (q1 NEVER
    // re-enters — its historical zero-re-capture fact is durable):
    const reloaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(reloaded.state?.capturePlan?.legacyExemptQuestions).toEqual(['q1']);
    expect(reloaded.state?.capturePlan?.items.map((item) => item.questionId)).toEqual(['q2']);
  });

  it('SUCCESSIVE regrades keep historical questions exempt (three questions, one by one)', async () => {
    const d = deps(store);
    // Historical legacy review: q1 wrong; q2/q3 ungraded.
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-p3',
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [wrong('q1'), ungraded('q2'), ungraded('q3')],
      },
      d,
    );
    const buildItem = (questionId: string) => ({
      questionId,
      eventId: questionEventId('a-p3', questionId),
      payload: {
        stageId: 's',
        stageName: 'n',
        sceneId: 'sc',
        eventId: questionEventId('a-p3', questionId),
        items: [
          {
            questionId,
            eventId: questionEventId('a-p3', questionId),
            questionType: 'single',
            question: 'q?',
            userAnswer: 'B',
          },
        ],
      } as never,
      recordToken: `tok-${questionId}`,
    });
    // Each pass merges ONLY the newly-decided wrong; the frozen baseline
    // (and thus zero new items for q1) persists across all three passes.
    const pass1 = plan({ legacyExemptQuestions: ['q1'], items: [buildItem('q2')] });
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-p3',
        phase: 'reviewed',
        answers: {},
        results: [wrong('q1'), wrong('q2'), ungraded('q3')],
        capturePlan: pass1,
      },
      d,
    );
    const after1 = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(after1.state?.capturePlan?.items.map((i) => i.questionId)).toEqual(['q2']);
    // Pass 2: q3 newly wrong — the merged plan keeps the baseline and adds
    // only q3 (the merge rule: existing q1/q2 items and the frozen
    // exemption carry; q1 stays out).
    const merged2 = plan({
      legacyExemptQuestions: after1.state!.capturePlan!.legacyExemptQuestions,
      items: [...after1.state!.capturePlan!.items, buildItem('q3')],
    });
    await recordQuizAttempt(
      {
        stageId: 's',
        sceneId: 'sc',
        attemptId: 'a-p3',
        phase: 'reviewed',
        answers: {},
        results: [wrong('q1'), wrong('q2'), wrong('q3')],
        capturePlan: merged2,
      },
      d,
    );
    const after2 = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(after2.state?.capturePlan?.legacyExemptQuestions).toEqual(['q1']);
    expect(after2.state?.capturePlan?.items.map((i) => i.questionId)).toEqual(['q2', 'q3']);
    // q1 was never minted an item or token in ANY pass — the historical
    // exemption is durable through modern reload and further regrading.
    expect(after2.state?.capturePlan?.items.some((i) => i.questionId === 'q1')).toBe(false);
  });

  it('shadow completion replay preserves the exemption field (no field loss)', async () => {
    const d = deps(store);
    const p = plan({
      attemptId: 'a-shadow-p3',
      originEpisodeId: 'a-shadow-p3',
      legacyExemptQuestions: ['q1'],
    });
    await recordQuizAttempt(
      { stageId: 's', sceneId: 'sc', attemptId: 'a-shadow-p3', phase: 'draft', answers: {} },
      d,
    );
    await store.appendRecord({
      id: 'shadow-reviewed-p3',
      sessionId: 'a-shadow-p3',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_100).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { q1: 'B' },
        results: [wrong('q1')],
        capturePlan: p,
      },
    });
    const loaded = await loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d);
    expect(loaded.state?.status).toBe('completed'); // replay completed in place
    expect(loaded.state?.capturePlan).toEqual(p); // field-forwarded bit-identically
  });

  it('a corrupt exemption baseline is a LOUD error — never silently dropped or applied', async () => {
    const d = deps(store);
    await recordQuizAttempt(
      { stageId: 's', sceneId: 'sc', attemptId: 'a-bad-p3', phase: 'draft', answers: {} },
      d,
    );
    await store.appendRecord({
      id: 'bad-reviewed-p3',
      sessionId: 'a-bad-p3',
      sceneId: 'sc',
      createdAt: new Date(1_700_000_000_200).toISOString(),
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: {},
        results: [],
        capturePlan: plan({
          attemptId: 'a-bad-p3',
          originEpisodeId: 'a-bad-p3',
          legacyExemptQuestions: ['q1', 'q1'],
        }),
      },
    });
    await expect(loadQuizAttemptState({ stageId: 's', sceneId: 'sc' }, d)).rejects.toThrow(
      /legacyExemptQuestions malformed/,
    );
  });

  it('a genuinely NEW attempt builds a fresh header — no baseline carryover', async () => {
    // A real re-answer mints a new attempt id; its first plan has no items
    // and no stale exemption (only THIS attempt's own history can freeze
    // one — computed from ITS prior results, which start empty).
    expect(legacyExemptQuestionIds(null, [])).toEqual([]);
    const fresh = plan({ attemptId: 'a-new', originEpisodeId: 'a-new' });
    expect(fresh.legacyExemptQuestions).toBeUndefined();
  });
});
