import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { QuizQuestion } from '../../lib/types/stage';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * Batch-B DOM acceptance (Codex review, last paragraph): real pages, real
 * clicks, synthetic data only. Two specs:
 *
 *  A. Classroom grading recovery (#3/#6): an AI-unavailable short answer
 *     grades to an honest "ungraded" banner with a Retry-grading affordance;
 *     retrying reuses the confirmed choice verdict and the SAME attempt, and
 *     a genuine re-answer after review adopts a NEW durable attempt identity
 *     — with two distinct mistake-capture events.
 *  B. Mistake book (#4/#7): wrong retry double-click sends ONE capture;
 *     500→200 retry keeps the stable event id and commits; POST-200/GET-500
 *     (capture ok, refresh fails) shows no fake failure; mastery-save
 *     failure never reads as persisted success; the filter pills switch.
 */
async function seedQuiz(page: Page, stageId: string, questions: QuizQuestion[]) {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    // Pin the intended UI language through the PRODUCT'S OWN override path:
    // I18nProvider reads localStorage 'locale' first at hydration (detection
    // logic untouched — zh-CN remains the default without this seed).
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ id, qs }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('maic-documents', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('stages', { keyPath: 'id' });
          const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
          scenes.createIndex('by-stage', 'stageId');
          db.createObjectStore('outlines', { keyPath: 'stageId' });
        };
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
          const now = Date.now();
          tx.objectStore('stages').put({
            id,
            name: 'Batch B quiz deck',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
            dslVersion: '0.1.0',
          });
          tx.objectStore('scenes').put({
            id: 'scene-quiz',
            stageId: id,
            type: 'quiz',
            title: 'Checkpoint',
            order: 0,
            content: { type: 'quiz', questions: qs },
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('outlines').put({
            stageId: id,
            outline: { outlines: [], createdAt: now, updatedAt: now },
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    },
    { id: stageId, qs: questions },
  );
}

const QUESTIONS: QuizQuestion[] = [
  {
    id: 'q-choice',
    type: 'single',
    question: 'Capital of France?',
    options: [
      { label: 'Paris', value: 'A' },
      { label: 'Lyon', value: 'B' },
    ],
    answer: ['A'],
    points: 1,
  },
  {
    id: 'q-short',
    type: 'short_answer',
    question: 'Say hello',
    commentPrompt: 'A greeting.',
    hasAnswer: false,
    points: 1,
  },
];

/** Quiz-attempt sessions in the runtime IndexedDB (id → status/kind). */
function quizSessions(page: Page) {
  return page.evaluate(() => {
    return new Promise<Array<{ id: string; status: string; kind: string }>>((resolve, reject) => {
      const request = indexedDB.open('maic-runtime');
      request.onsuccess = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = db.transaction(['sessions'], 'readonly');
        const req = tx.objectStore('sessions').getAll();
        req.onsuccess = () => {
          db.close();
          resolve(
            (req.result as Array<Record<string, unknown>>)
              .filter((row) => row.kind === 'quizAttempt')
              .map((row) => ({
                id: String(row.id),
                status: String(row.status),
                kind: String(row.kind),
              })),
          );
        };
        req.onerror = () => reject(req.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

test.describe('Batch B — classroom grading recovery and retry identity', () => {
  test('ungraded → retry grading reuses verdicts and the SAME attempt; a real re-answer is a NEW attempt', async ({
    page,
  }) => {
    const STAGE = 'e2e-batchb-classroom';
    await seedQuiz(page, STAGE, QUESTIONS);

    // AI grading unavailable first (502), healthy afterwards.
    let aiAvailable = false;
    await page.route('**/api/quiz-grade', (route) => {
      if (aiAvailable) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ score: 0, comment: 'Not a greeting.' }),
        });
      }
      return route.fulfill({ status: 502, body: 'Grading unavailable; retry' });
    });
    // Capture sink: record every wrong-answer event payload. Echoes the
    // server's owner header — the capture client only POSTs after a live
    // identity confirmation, and the confirmation reads this echo. The glob
    // must cover query-string URLs (`**/api/mistakes**`): the identity probe
    // GETs /api/mistakes?count=… and an unmatched probe hits the real
    // (unconfigured) server and 503s the whole capture into silence.
    const captures: Array<Record<string, unknown>> = [];
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'POST') {
        captures.push(route.request().postDataJSON() as Record<string, unknown>);
      }
      return route.fulfill({
        status: 200,
        headers: { 'x-owner-id': 'owner-a' },
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { captured: 1 } }),
      });
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE);
    await classroom.waitForLoaded();

    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // Wrong choice answer + a short answer the AI cannot grade yet.
    await page.getByRole('button', { name: /Lyon/ }).click();
    await page.getByPlaceholder('Type your answer here...').fill('bonjour');
    await page.getByRole('button', { name: 'Submit Answers' }).click();

    // Honest partial verdict: one confirmed wrong, one ungraded, retryable.
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/1\s*correct/)).toHaveCount(0);
    // The confirmed choice verdict is already shown — ungraded cannot paint it.
    await expect(page.getByText('1 incorrect')).toBeVisible();
    // ONLY the confirmed-wrong choice was captured; the unresolved AI verdict
    // must not be a mistake yet. (The capture flush is async after grading —
    // poll for the durable event, then assert exactly one.)
    await expect.poll(async () => captures.length, { timeout: 15_000 }).toBe(1);
    expect((captures[0]!.items as Array<Record<string, unknown>>)[0]!.questionId).toBe('q-choice');

    // Retry grading with the AI healthy: the SHORT answer alone is re-graded,
    // the choice verdict and attempt identity are untouched.
    aiAvailable = true;
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect(page.getByText('1 ungraded')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(/2\s*incorrect/)).toBeVisible();
    // Recovery grades ONLY the short answer; it is now confirmed wrong
    // (score 0 < 80%) → captured. The already-confirmed choice verdict was
    // NOT re-captured.
    await expect.poll(async () => captures.length, { timeout: 15_000 }).toBe(2);
    expect((captures[1]!.items as Array<Record<string, unknown>>)[0]!.questionId).toBe('q-short');

    let sessions = await quizSessions(page);
    expect(sessions).toHaveLength(1);
    const firstAttempt = sessions[0]!.id;

    // A REAL re-answer: review → Retry → the fresh attempt opens on its
    // cover → start it again and answer differently (still wrong).
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /Lyon/ }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: /Lyon/ }).click();
    await page.getByPlaceholder('Type your answer here...').fill('salut');
    aiAvailable = true;
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 2')).toBeVisible({ timeout: 15_000 });

    // The durable retry child is a NEW attempt identity, and the second real
    // wrong answer produced a SECOND capture event.
    await expect.poll(async () => (await quizSessions(page)).length, { timeout: 15_000 }).toBe(2);
    sessions = await quizSessions(page);
    const retryChild = sessions.find((session) => session.id !== firstAttempt);
    expect(retryChild!.id).toMatch(/:retry:\d+$/);
    await expect
      .poll(
        async () =>
          retryChild && (await quizSessions(page)).find((x) => x.id === retryChild.id)!.status,
        { timeout: 15_000 },
      )
      .toBe('completed');
    // Both events carry the same question but belong to different attempts.
    expect(captures[0]!.stageId).toBe(STAGE);
  });
});

test.describe('Batch B — mistake book retry flows', () => {
  const RECORD = (overrides: Record<string, unknown> = {}) => ({
    stageId: 's-mb',
    stageName: 'Batch B mistakes',
    sceneId: 'sc-mb',
    sceneTitle: 'Checkpoint',
    sceneOrder: 1,
    subject: 'math',
    gradeSemester: 'grade-1-up',
    questionId: 'q1',
    questionType: 'single',
    question: 'Capital of France?',
    options: [
      { label: 'Paris', value: 'A' },
      { label: 'Lyon', value: 'B' },
    ],
    correctAnswer: ['A'],
    analysis: 'Paris.',
    lastUserAnswer: ['B'],
    wrongCount: 1,
    firstWrongAt: '2026-10-02T00:00:00.000Z',
    lastWrongAt: '2026-10-02T00:00:00.000Z',
    masteredAt: null,
    ...overrides,
  });

  const masteredRecord = () =>
    RECORD({
      questionId: 'q2',
      question: 'Say hello',
      questionType: 'short_answer',
      options: undefined,
      correctAnswer: undefined,
      masteredAt: '2026-10-02T01:00:00.000Z',
    });

  interface MbRecord extends Record<string, unknown> {
    questionId: string;
    wrongCount: number;
    lastUserAnswer: string[];
    masteredAt: string | null;
  }

  /**
   * Stateful /api/mistakes mock: a server-side record store with REAL
   * mutations — capture increments wrongCount and replaces lastUserAnswer
   * with the shipped answer; mastery PATCH toggles masteredAt — and the GET
   * is filter-aware. captureStatuses scripts capture failures per call.
   */
  async function mockMistakesStateful(
    page: Page,
    seed: Array<Record<string, unknown>>,
    options: {
      captureStatuses?: number[];
      masterStatuses?: number[];
      /** GET statuses in call order; default 200s. Used for the refresh-failure test. */
      getStatuses?: number[];
    } = {},
  ) {
    await page.exposeFunction('__mbState', () => ({}) as never).catch(() => {});
    const records: MbRecord[] = seed.map((row) => ({ ...(row as MbRecord) }));
    let captureIndex = 0;
    let masterIndex = 0;
    let getIndex = 0;
    await page.route('**/api/mistakes**', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        // The identity probe (?count=) is its own endpoint on the real
        // server and must not consume the scripted LIST statuses.
        if (new URL(route.request().url()).searchParams.get('count') !== null) {
          const count = records.filter((row) => row.masteredAt == null).length;
          return route.fulfill({
            status: 200,
            headers: { 'x-owner-id': 'owner-a' },
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { count } }),
          });
        }
        const status =
          options.getStatuses?.[Math.min(getIndex, (options.getStatuses?.length ?? 1) - 1)] ?? 200;
        getIndex += 1;
        if (status !== 200)
          return route.fulfill({ status, body: 'boom', headers: { 'x-owner-id': 'owner-a' } });
        const filter = new URL(route.request().url()).searchParams.get('filter') ?? 'all';
        const mistakes = records.filter((row) => {
          const mastered = row.masteredAt != null;
          return (
            filter === 'all' ||
            (filter === 'mastered' && mastered) ||
            (filter === 'unmastered' && !mastered)
          );
        });
        return route.fulfill({
          status: 200,
          headers: { 'x-owner-id': 'owner-a' },
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { mistakes } }),
        });
      }
      if (method === 'POST') {
        const status =
          options.captureStatuses?.[
            Math.min(captureIndex, (options.captureStatuses?.length ?? 1) - 1)
          ] ?? 200;
        captureIndex += 1;
        if (status === 200) {
          const body = route.request().postDataJSON() as {
            items: Array<{ questionId: string; userAnswer: string[] }>;
          };
          for (const item of body.items) {
            const row = records.find((candidate) => candidate.questionId === item.questionId);
            if (row) {
              row.wrongCount += 1;
              row.lastUserAnswer = item.userAnswer;
              row.masteredAt = null;
            }
          }
        }
        return route.fulfill({
          status,
          headers: { 'x-owner-id': 'owner-a' },
          contentType: 'application/json',
          body: status === 200 ? '{"success":true,"data":{"captured":1}}' : 'boom',
        });
      }
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if (body.classifyStage === true) {
          return route.fulfill({
            status: 200,
            headers: { 'x-owner-id': 'owner-a' },
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { classified: 1, courseUpdated: false } }),
          });
        }
        const status =
          options.masterStatuses?.[
            Math.min(masterIndex, (options.masterStatuses?.length ?? 1) - 1)
          ] ?? 200;
        masterIndex += 1;
        if (status === 200) {
          const row = records.find((candidate) => candidate.questionId === body.questionId);
          if (row) row.masteredAt = body.mastered ? new Date().toISOString() : null;
        }
        return route.fulfill({
          status,
          headers: { 'x-owner-id': 'owner-a' },
          contentType: 'application/json',
          body: status === 200 ? '{"success":true,"data":{"updated":true}}' : 'boom',
        });
      }
      return route.fulfill({
        status: 200,
        headers: { 'x-owner-id': 'owner-a' },
        body: '{"success":true}',
      });
    });
    return {
      posts: (() => {
        const log: Array<Record<string, unknown>> = [];
        page.on('request', (request) => {
          if (request.url().includes('/api/mistakes') && request.method() === 'POST') {
            log.push(request.postDataJSON() as Record<string, unknown>);
          }
        });
        return log;
      })(),
    };
  }

  test.beforeEach(async ({ page }) => {
    // Default EXTERNAL-AI fallback, installed BEFORE any goto/hydration: the
    // quiz-grade route is the server-side AI boundary — without this, a page
    // that auto-starts grading during hydration reaches the REAL provider
    // (C2's raw 345 caught exactly that). Per-test routes registered later
    // take precedence and still drive their specific verdicts; this default
    // only guarantees no external AI call ever leaves the browser unmocked.
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'AI_GRADE_UNAVAILABLE' }),
      });
    });

    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      // Pin the intended UI language through the PRODUCT'S OWN override path:
      // I18nProvider reads localStorage 'locale' first at hydration (detection
      // logic untouched — zh-CN remains the default without this seed).
      localStorage.setItem('locale', 'en-US');
    }, SETTINGS_STORAGE);
  });

  /**
   * Pick a retry option robustly: under dev-server load the card can re-render
   * right after mount and swallow one click. Click, then confirm the Submit
   * button actually enabled; retry the click a couple of times otherwise.
   */
  async function pickOption(page: Page, name: RegExp) {
    const option = page.getByRole('button', { name });
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    await expect(option).toBeVisible({ timeout: 15_000 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await option.click().catch(() => {});
      try {
        await expect(submit).toBeEnabled({ timeout: 2_000 });
        return;
      } catch {
        /* the click was swallowed by a re-render — pick again */
      }
    }
    await expect(submit).toBeEnabled();
  }

  test('double-click sends ONE capture; 500→200 retry keeps the stable event id and commits', async ({
    page,
  }) => {
    const { posts } = await mockMistakesStateful(page, [RECORD()], {
      captureStatuses: [500, 200],
    });

    await page.goto('/mistake-book');
    await expect(page.getByText('Capital of France?').first()).toBeVisible({ timeout: 15_000 });

    // Pick the wrong option and double-click submit (two rapid clicks).
    await pickOption(page, /Lyon/);
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    await expect(submit).toBeEnabled();
    await submit.dblclick();

    // First upload failed honestly; the retry affordance appears.
    await expect(page.getByText('Not saved to the mistake book')).toBeVisible({ timeout: 10_000 });
    // Only ONE capture went out despite the double-click.
    expect(posts).toHaveLength(1);
    expect((posts[0]!.items as Array<Record<string, unknown>>)[0]!.userAnswer).toEqual(['B']);

    // Retry upload succeeds with the SAME event id and identical frozen payload.
    await page.getByRole('button', { name: 'Retry upload' }).click();
    // The click clears the notice immediately (pending ≠ failed) — wait for
    // the actual commit: the retransmitted POST landing.
    await expect.poll(async () => posts.length, { timeout: 20_000 }).toBe(2);
    await expect(page.getByText('Not saved to the mistake book')).toHaveCount(0, {
      timeout: 10_000,
    });
    expect(posts[0]!.eventId).toBeTruthy();
    expect(posts[1]!.eventId).toBe(posts[0]!.eventId);
    expect(posts[1]!.items).toEqual(posts[0]!.items); // whole payload frozen, not just the answer
  });

  test('POST 200 with a failing refresh (GET 500) shows no fake failure', async ({ page }) => {
    // Capture succeeds; the refresh AFTER it fails once. The committed upload
    // must not fabricate a failure state. The refresh failure is gated on the
    // COMMITTED POST (not a GET index — the identity probe's count GETs must
    // stay healthy or the upload could never confirm and commit).
    const { posts } = await mockMistakesStateful(page, [RECORD()]);
    let refreshBroken = false;
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'GET' && refreshBroken && posts.length >= 1) {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fallback();
    });

    await page.goto('/mistake-book');
    await expect(page.getByText('Capital of France?').first()).toBeVisible({ timeout: 15_000 });
    refreshBroken = true; // any re-read AFTER the committed POST fails
    await pickOption(page, /Lyon/);
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();

    // The upload COMMITTED (exactly one POST). The failed refresh must not
    // fabricate a failure: no "Not saved" hint, and the card settles back to
    // a usable idle state (Submit re-rendered, retryable). Persisting the
    // verdict across the refresh plus an explicit "saved but refresh failed"
    // notice is R11 scope — B proves no fake failure and no lost upload.
    await expect.poll(async () => posts.length, { timeout: 20_000 }).toBe(1);
    await expect(page.getByText('Not saved to the mistake book')).toHaveCount(0);
    // The card settles in a usable answered state: "Try again" resets it to
    // the idle picker with its Submit affordance (retryable, not stuck).
    const tryAgain = page.getByRole('button', { name: 'Try again' });
    await expect(tryAgain).toBeVisible({ timeout: 15_000 });
    await tryAgain.click();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('mastery-save failure never reads as persisted success', async ({ page }) => {
    await mockMistakesStateful(page, [RECORD()], { masterStatuses: [500] });

    await page.goto('/mistake-book');
    await expect(page.getByText('Capital of France?').first()).toBeVisible({ timeout: 10_000 });

    // Correct retry → mastery save fails → the card must NOT flip to mastered.
    await pickOption(page, /Paris/);
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText('Correct — marked as mastered')).toHaveCount(0, { timeout: 5_000 });
    // The card's footer toggle still offers "Mark mastered" — the failed save
    // did not flip it to "Back to unmastered" (which would fake persistence).
    await expect(page.getByRole('button', { name: 'Mark mastered' })).toBeVisible();
  });

  test('filter pills drive a stateful list through real mutations', async ({ page }) => {
    await mockMistakesStateful(page, [RECORD(), masteredRecord()]);

    await page.goto('/mistake-book');
    await expect(page.getByText('Capital of France?').first()).toBeVisible({ timeout: 10_000 });

    // Default (unmastered) hides the mastered record's question.
    const masteredQuestion = page.getByText('Say hello');
    await expect(masteredQuestion).toHaveCount(0);

    await page.getByRole('button', { name: 'Mastered', exact: true }).click();
    await expect(masteredQuestion).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Capital of France?')).toHaveCount(0);

    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText('Capital of France?').first()).toBeVisible();
    await expect(masteredQuestion).toBeVisible();

    // REAL state change: master the unmastered card through the UI (footer
    // toggle), then the unmastered filter no longer lists it — the mock's
    // masteredAt actually moved, and the refetch reflects it.
    await page.getByRole('button', { name: 'Unmastered', exact: true }).click();
    await expect(page.getByText('Capital of France?').first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Mark mastered' }).click();
    await expect(page.getByText('Capital of France?')).toHaveCount(0, { timeout: 10_000 });
    // …and it now appears under Mastered.
    await page.getByRole('button', { name: 'Mastered', exact: true }).click();
    await expect(page.getByText('Capital of France?').first()).toBeVisible({ timeout: 10_000 });
  });
});
