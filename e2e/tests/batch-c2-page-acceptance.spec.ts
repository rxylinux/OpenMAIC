import { test, expect, Page } from '@playwright/test';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * Batch-C2 page acceptance — the five C2 page-gate items plus the
 * implementation-review counters, over real pages with PRODUCTION-semantics
 * mocks:
 *   - the count probe is its own endpoint (never consumes list scripts);
 *   - POST enforces expectedOwnerId against the CURRENT echo owner and
 *     refuses with the production TOP-LEVEL errorCode shape;
 *   - event dedupe is per owner+event and DISTINGUISHES payloads (a real
 *     EVENT_PAYLOAD_CONFLICT, never a blanket replay no-op);
 *   - records are located by their natural (stage, scene, question) key.
 *
 * Formal counters included: phase-vs-unmount notice lifetime, same-event
 * local-failed recovery after a REAL outbox transaction abort (single and
 * partial), same-id cross-owner lifecycle, partial lifecycle upgrade,
 * old-attempt clearing, claim late-abort, and the stale-GET/PATCH
 * interleavings — all signal-gated, never timed guesses.
 */

const RECORD = (overrides: Record<string, unknown> = {}) => ({
  stageId: 's-c2',
  stageName: 'C2 mistakes',
  sceneId: 'sc-c2',
  sceneTitle: 'Checkpoint',
  sceneOrder: 1,
  subject: 'math',
  gradeSemester: 'grade-1-up',
  questionId: 'q1',
  questionType: 'single',
  question: 'What is $2+2$?',
  options: [
    { label: '3', value: 'A' },
    { label: '4', value: 'B' },
  ],
  correctAnswer: ['B'],
  analysis: 'Since $2+2=4$, the answer is B.',
  lastUserAnswer: ['A'],
  wrongCount: 1,
  firstWrongAt: '2026-10-03T00:00:00.000Z',
  lastWrongAt: '2026-10-03T00:00:00.000Z',
  masteredAt: null,
  ...overrides,
});

interface C2Mock {
  /** Records per owner (natural identity: stageId+sceneId+questionId rows). */
  recordsByOwner: Record<string, Array<Record<string, unknown>>>;
  posts: Array<Record<string, unknown>>;
  /** owner|eventId → frozen items JSON (production dedupe semantics). */
  seenEvents: Map<string, string>;
  /** Mutable echo owner — flipping it simulates a cookie/identity switch. */
  echoOwner: string;
  /** POST failure injection: '500' | 'abort' | null per request body. */
  failPost: null | ((body: Record<string, unknown>) => '500' | 'abort' | null);
  /** Mutation failure injection: mode applied to the given methods. */
  failMutation: { mode: '500' | 'abort' | null; methods: string[] };
  /** Every PATCH as received (diagnosis/verification aid). */
  patchLog?: Array<{ body: Record<string, unknown>; failMode: string | null }>;
  /** EVERY POST request as received, before any branch decides. */
  postRequests: Array<{ body: Record<string, unknown>; echo: string }>;
  /** POSTs the production identity guard refused (409 OWNER_MISMATCH). */
  ownerRefusals: Array<{ body: Record<string, unknown>; echo: string }>;
}

async function mockMistakes(page: Page, seed: Array<Record<string, unknown>> = [RECORD()]) {
  const state: C2Mock = {
    recordsByOwner: { 'owner-a': seed.map((row) => ({ ...row })) },
    posts: [],
    seenEvents: new Map<string, string>(),
    echoOwner: 'owner-a',
    failPost: null,
    failMutation: { mode: null, methods: [] },
    postRequests: [],
    ownerRefusals: [],
  };
  const findRow = (owner: string, body: Record<string, unknown>) => {
    const rows = state.recordsByOwner[owner] ?? [];
    const sceneId = (body.sceneId ?? 'sc-c2') as string;
    return rows.find(
      (row) =>
        row.stageId === body.stageId &&
        row.sceneId === sceneId &&
        row.questionId === body.questionId,
    );
  };
  await page.route('**/api/mistakes**', async (route) => {
    const method = route.request().method();
    const owner = state.echoOwner;
    const headers = { 'x-owner-id': owner };
    if (method === 'GET') {
      if (new URL(route.request().url()).searchParams.get('count') !== null) {
        const rows = state.recordsByOwner[owner] ?? [];
        const count = rows.filter((row) => row.masteredAt == null).length;
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { count } }),
        });
      }
      const filter = new URL(route.request().url()).searchParams.get('filter') ?? 'all';
      const rows = state.recordsByOwner[owner] ?? [];
      const mistakes = rows.filter((row) => {
        const mastered = row.masteredAt != null;
        return (
          filter === 'all' ||
          (filter === 'mastered' && mastered) ||
          (filter === 'unmastered' && !mastered)
        );
      });
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { mistakes } }),
      });
    }
    if (method === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      // OBSERVATION FIRST (closing gate #1): every POST is recorded before
      // any branch decides, so tests assert on real request/response pairs —
      // never on a count that a refusal branch skips.
      state.postRequests.push({ body, echo: owner });
      // Production guard + production error shape (TOP-LEVEL errorCode).
      if (typeof body.expectedOwnerId === 'string' && body.expectedOwnerId !== owner) {
        state.ownerRefusals.push({ body, echo: owner });
        return route.fulfill({
          status: 409,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({
            errorCode: 'OWNER_MISMATCH',
            message: 'Owner identity changed; event not attributed',
          }),
        });
      }
      state.posts.push(body);
      const fail = state.failPost?.(body) ?? null;
      if (fail === 'abort') return route.abort('connectionreset');
      if (fail === '500') {
        return route.fulfill({ status: 500, headers, body: 'offline' });
      }
      const items = body.items as Array<Record<string, unknown>>;
      const eventId = (body.eventId ?? items[0]?.eventId) as string | undefined;
      const dedupeKey = eventId !== undefined ? `${owner}|${eventId}` : undefined;
      const frozen = JSON.stringify(items);
      if (dedupeKey !== undefined && state.seenEvents.has(dedupeKey)) {
        if (state.seenEvents.get(dedupeKey) !== frozen) {
          // Same event id, DIFFERENT content: the real 409, top-level code.
          return route.fulfill({
            status: 409,
            headers,
            contentType: 'application/json',
            body: JSON.stringify({
              errorCode: 'EVENT_PAYLOAD_CONFLICT',
              message: 'Event id already recorded with different content',
            }),
          });
        }
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: '{"success":true,"data":{"captured":0,"duplicates":["replay"]}}',
        });
      }
      if (dedupeKey !== undefined) state.seenEvents.set(dedupeKey, frozen);
      let captured = 0;
      for (const item of items) {
        captured += 1;
        const row = findRow(owner, {
          stageId: body.stageId,
          sceneId: body.sceneId,
          questionId: item.questionId,
        });
        if (row) {
          row.wrongCount = (row.wrongCount as number) + 1;
          row.lastUserAnswer = item.userAnswer;
          row.masteredAt = null;
        } else {
          (state.recordsByOwner[owner] ??= []).push({
            ...RECORD(),
            stageId: body.stageId,
            stageName: body.stageName,
            sceneId: body.sceneId,
            questionId: item.questionId,
            question: item.question,
            lastUserAnswer: item.userAnswer,
            wrongCount: 1,
          });
        }
      }
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { captured } }),
      });
    }
    if (method === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      (state.patchLog ??= []).push({ body, failMode: state.failMutation.mode });
      const fail =
        state.failMutation.mode !== null && state.failMutation.methods.includes('PATCH')
          ? state.failMutation.mode
          : null;
      if (fail === 'abort') return route.abort('connectionreset');
      if (fail === '500') return route.fulfill({ status: 500, body: 'boom' });
      if (body.classifyStage === true) {
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { classified: 1, courseUpdated: false } }),
        });
      }
      const row = findRow(owner, { ...body, sceneId: body.sceneId ?? 'sc-c2' });
      if (row) row.masteredAt = body.mastered ? new Date().toISOString() : null;
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: '{"success":true,"data":{"updated":true}}',
      });
    }
    if (method === 'DELETE') {
      const fail =
        state.failMutation.mode !== null && state.failMutation.methods.includes('DELETE')
          ? state.failMutation.mode
          : null;
      if (fail === 'abort') return route.abort('connectionreset');
      if (fail === '500') return route.fulfill({ status: 500, body: 'boom' });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const rows = state.recordsByOwner[owner] ?? [];
      if (body.all === true) state.recordsByOwner[owner] = [];
      else if (typeof body.stageId === 'string' && !body.sceneId) {
        state.recordsByOwner[owner] = rows.filter((row) => row.stageId !== body.stageId);
      } else if (typeof body.questionId === 'string') {
        state.recordsByOwner[owner] = rows.filter(
          (row) =>
            !(
              row.stageId === body.stageId &&
              row.sceneId === body.sceneId &&
              row.questionId === body.questionId
            ),
        );
      }
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: '{"success":true,"data":{"deleted":1}}',
      });
    }
    return route.fulfill({ status: 200, headers, body: '{"success":true}' });
  });
  return state;
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
    // Armable IDB late-abort (C2 gate): aborts the (N+1)-th successful
    // readwrite put on the OUTBOX database ONLY — runtime/document stores are
    // untouched. window.__armIdbAbort(n) / window.__disarmIdbAbort().
    const abortState = { armed: false, after: 0, seen: 0 };
    (window as unknown as Record<string, unknown>).__armIdbAbort = (after: number) => {
      abortState.armed = true;
      abortState.after = after;
      abortState.seen = 0;
    };
    (window as unknown as Record<string, unknown>).__disarmIdbAbort = () => {
      abortState.armed = false;
    };
    const realIdb = window.indexedDB;
    const realOpen = realIdb.open.bind(realIdb);
    const wrappedOpen = (...args: unknown[]) => {
      // Per-open closure: ONLY this open's database is scoped for aborts.
      const openedName = String(args[0]);
      const request = realOpen(...(args as [string, number?]));
      request.addEventListener('success', () => {
        const db = request.result as IDBDatabase;
        const realTransaction = db.transaction.bind(db);
        (db as unknown as Record<string, unknown>)['transaction'] = (
          stores: string | string[],
          mode?: IDBTransactionMode,
        ) => {
          const tx = realTransaction(stores, mode);
          if (mode === 'readwrite' && openedName === 'MAIC-mistake-outbox') {
            const realObjectStore = tx.objectStore.bind(tx);
            (tx as unknown as Record<string, unknown>)['objectStore'] = (name: string) => {
              const store = realObjectStore(name);
              // Count EVENT-row puts only (same granularity as the p3/p4
              // suites' hooks): an upload's receipt+delete commit inside the
              // SAME armed window is not a capture-enqueue abort — letting it
              // abort here leaves an uploaded-but-uncommitted row that a
              // retry then legitimately re-POSTs, duplicating transport.
              if (name !== 'events') return store;
              const realPut = store.put.bind(store);
              (store as unknown as Record<string, unknown>)['put'] = (...putArgs: unknown[]) => {
                const putRequest = (realPut as (...a: unknown[]) => IDBRequest)(...putArgs);
                if (abortState.armed) {
                  abortState.seen += 1;
                  if (abortState.seen > abortState.after) {
                    putRequest.addEventListener('success', () => tx.abort(), { once: true });
                  }
                }
                return putRequest;
              };
              return store;
            };
          }
          return tx;
        };
      });
      return request;
    };
    // Proxy the REAL factory so every other member (deleteDatabase, cmp,
    // databases, …) keeps working for Dexie and the non-outbox stores.
    const proxiedFactory = new Proxy(realIdb, {
      get(target, prop) {
        if (prop === 'open') return wrappedOpen;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.defineProperty(window, 'indexedDB', {
      value: proxiedFactory,
      configurable: true,
    });
  }, SETTINGS_STORAGE);
});

async function gotoBook(page: Page, expectedText = 'What is') {
  await page.goto('/mistake-book');
  await expect(page.getByText(expectedText, { exact: false }).first()).toBeVisible({
    timeout: 15_000,
  });
}

/** Accept exactly the NEXT confirm dialog (clear-course asks each time). */
function acceptNextConfirm(page: Page) {
  return new Promise<void>((resolve) => {
    page.once('dialog', (dialog) => {
      void dialog.accept();
      resolve();
    });
  });
}

/** The Mark-mastered button on the 'Second card?' card (the matrix target). */
function secondCardMasteredButton(page: Page) {
  return page
    .getByText('Second card?', { exact: false })
    .first()
    .locator('xpath=ancestor::div[.//button[@aria-label="Delete"]][1]/..')
    .getByRole('button', { name: 'Mark mastered' });
}

/** The Delete button on the card showing the given question text. */
function deleteCardButton(page: Page, questionText: string) {
  // The card's delete control is ICON-ONLY (aria-label, no text content).
  return page
    .getByText(questionText, { exact: false })
    .first()
    .locator('xpath=ancestor::div[.//button[@aria-label="Delete"]][1]')
    .getByRole('button', { name: 'Delete' });
}

// ─── Classroom helpers ──────────────────────────────────────────────────────

interface SeedQuestion {
  id: string;
  type: 'single' | 'short_answer';
  question: string;
  options?: Array<{ label: string; value: string }>;
  answer?: string[];
  commentPrompt?: string;
  hasAnswer?: boolean;
  points: number;
}

/** A single-choice question whose WRONG option is `wrongLabel` (value B). */
function wrongChoice(
  id: string,
  question: string,
  wrongLabel: string,
  rightLabel: string,
): SeedQuestion {
  return {
    id,
    type: 'single',
    question,
    options: [
      { label: rightLabel, value: 'A' },
      { label: wrongLabel, value: 'B' },
    ],
    answer: ['A'],
    points: 1,
  };
}

async function seedClassroom(page: Page, stageId: string, questions: SeedQuestion[]) {
  // A real same-origin page first (about:blank denies IndexedDB); readiness
  // is the DOM itself — never a whole-network quiescence assumption.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
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
            name: 'C2 quiz deck',
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
            title: 'CP',
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

async function quizAttemptIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return new Promise<string[]>((resolve, reject) => {
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
              .map((row) => String(row.id)),
          );
        };
        req.onerror = () => reject(req.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/** Directly seed the capture outbox store (synthetic records only). */
async function seedOutbox(page: Page, rows: Array<Record<string, unknown>>) {
  await page.evaluate((events) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MAIC-mistake-outbox');
      request.onupgradeneeded = () => {
        request.result.createObjectStore('events', { keyPath: 'key' });
      };
      request.onsuccess = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = db.transaction('events', 'readwrite');
        for (const row of events) tx.objectStore('events').put(row);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, rows);
}

/** Answer every question wrong and submit; asserts the INCORRECT review. */
async function answerAllWrongAndSubmit(page: Page, questionCount: number) {
  for (let index = 0; index < questionCount; index += 1) {
    await page.getByRole('button', { name: /No/ }).nth(index).click();
  }
  await page.getByRole('button', { name: 'Submit Answers' }).click();
  await expect(page.getByText(`/ ${questionCount}`)).toBeVisible({ timeout: 15_000 });
  // PROVE the answers were graded incorrect before observing any outbox
  // effect — a fixture that accidentally answers right is a false negative.
  await expect(page.getByText(`${questionCount} incorrect`)).toBeVisible({ timeout: 15_000 });
}

const pillText = {
  uploaded: 'Mistakes synced',
  queued: 'Mistakes saved offline',
  localFailed: 'Mistakes could not be saved locally',
  unbound: 'identity not linked yet',
  conflict: 'Not saved: this answer conflicts with an already recorded event',
  unconfigured: 'no mistake-book persistence',
} as const;

test.describe('C2-1 classroom typed capture states & same-event recovery', () => {
  test('local-failed capture shows retry; SAME event recovers after a real IDB abort (exactly one wrong count)', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-localfail', [
      wrongChoice('q-lf', 'Local fail?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/e2e-c2-localfail');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible();
    expect(state.posts).toHaveLength(0); // persist-first failed → nothing sent
    const attemptsBefore = await quizAttemptIds(page);
    expect(attemptsBefore).toHaveLength(1);

    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1); // exactly one commit for the one wrong answer
    const shipped = (state.posts[0]!.items as Array<Record<string, unknown>>)[0]!;
    expect(shipped.userAnswer).toBe('B'); // the picked answer, verbatim
    expect(state.recordsByOwner['owner-a']).toHaveLength(1);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1); // counted once
    expect(await quizAttemptIds(page)).toEqual(attemptsBefore); // SAME attempt
  });

  test('PARTIAL persistence: first question kept, second aborted → retry reuses the SAME events, no double count', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-partial', [
      wrongChoice('q-p1', 'First?', 'No', 'Yes'),
      wrongChoice('q-p2', 'Second?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/e2e-c2-partial');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(1);
    });
    await answerAllWrongAndSubmit(page, 2);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    const attemptsBefore = await quizAttemptIds(page);
    expect(attemptsBefore).toHaveLength(1);

    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    const ids = state.posts.map((post) => (post.items as Array<{ eventId?: string }>)[0]!.eventId);
    expect(new Set(ids).size).toBe(2); // distinct events, no re-minted duplicates
    for (const row of state.recordsByOwner['owner-a'] ?? []) expect(row.wrongCount).toBe(1);
    expect(await quizAttemptIds(page)).toEqual(attemptsBefore); // SAME attempt
  });

  test('queued capture upgrades to synced on the ONLINE lifecycle flush (same event, one count)', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    let postCount = 0;
    await page.route('**/api/mistakes**', async (route) => {
      if (route.request().method() === 'POST') {
        postCount += 1;
        if (postCount === 1) return route.fulfill({ status: 500, body: 'boom' });
        return route.fallback();
      }
      return route.fallback();
    });
    await seedClassroom(page, 'e2e-c2-online', [wrongChoice('q-on', 'Online?', 'No', 'Yes')]);
    await page.goto('/classroom/e2e-c2-online');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    // The first POST (500) was gate-fulfilled in front of the mock, so the
    // mock recorded exactly the committed retransmit: ONE business capture.
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect((state.posts[0]!.items as Array<Record<string, unknown>>)[0]!.userAnswer).toBe('B');
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1); // counted once
  });

  test('CONFLICT pill is honest (never "saved, will sync"); the frozen original only ships via an EXPLICIT legal flush', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-conflict', [wrongChoice('q-cf', 'Conflict?', 'No', 'Yes')]);
    await page.goto('/classroom/e2e-c2-conflict');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // The runtime session materializes with the first answer — answer, then
    // poll, then PRE-FREEZE the conflicting record under the predicted key.
    await page.getByRole('button', { name: /No/ }).click();
    await expect.poll(async () => (await quizAttemptIds(page)).length, { timeout: 15_000 }).toBe(1);
    const attemptIds = await quizAttemptIds(page);
    const eventId = JSON.stringify([attemptIds[0], 'q-cf']);
    await seedOutbox(page, [
      {
        key: `owner-a|${eventId}`,
        eventId,
        owner: 'owner-a',
        creationToken: 'seeded',
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending',
        payload: {
          eventId,
          stageId: 'e2e-c2-conflict',
          stageName: 'C2 quiz deck',
          sceneId: 'scene-quiz',
          items: [
            {
              questionId: 'q-cf',
              eventId,
              questionType: 'single',
              question: 'TAMPERED',
              userAnswer: 'Z',
            },
          ],
        },
      },
    ]);
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 1')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('1 incorrect')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(pillText.conflict)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(pillText.queued)).toHaveCount(0); // never "saved offline"
    // C1's accepted contract: an all-local-conflict submission does NOT flush
    // — the learner's answer never borrowed the frozen original's success.
    expect(state.posts).toHaveLength(0);

    // Verifying the frozen original still uploads is a SEPARATE, legal
    // lifecycle flush (connectivity event), not the conflict verdict.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    const shipped = (state.posts[0]!.items as Array<Record<string, unknown>>)[0]!;
    expect(shipped.question).toBe('TAMPERED'); // frozen original, unmodified
    expect(shipped.userAnswer).not.toBe('B'); // the real answer never shipped
  });

  test("SAME-ID CROSS-OWNER: another owner's old upload never upgrades this pill; only ours does", async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    state.recordsByOwner['owner-b'] = [];
    let failFirstPosts = true;
    state.failPost = () => (failFirstPosts ? '500' : null);
    await seedClassroom(page, 'e2e-c2-xowner', [wrongChoice('q-xo', 'Cross owner?', 'No', 'Yes')]);
    await page.goto('/classroom/e2e-c2-xowner');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });
    const [ourId] = state.posts.map(
      (post) => (post.items as Array<{ eventId?: string }>)[0]!.eventId!,
    );
    // An OLD record of owner-b sharing the eventId (different content).
    await seedOutbox(page, [
      {
        key: `owner-b|${ourId}`,
        eventId: ourId,
        owner: 'owner-b',
        creationToken: 'old-b',
        createdAt: Date.now() - 60_000,
        attempts: 0,
        status: 'pending',
        payload: {
          eventId: ourId,
          stageId: 'legacy-stage',
          stageName: 'B legacy',
          sceneId: 'sc-b',
          items: [
            {
              questionId: 'q-old-b',
              eventId: ourId,
              questionType: 'single',
              question: 'OLD B',
              userAnswer: 'X',
            },
          ],
        },
      },
    ]);
    failFirstPosts = false;
    // Identity flips to B: the lifecycle flush uploads B's OLD record and
    // parks OUR owner-a record — the pill must NOT report synced.
    state.echoOwner = 'owner-b';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2); // B's old record shipped…
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 5_000 }); // …ours did not
    expect((state.posts[1]!.items as Array<Record<string, unknown>>)[0]!.question).toBe('OLD B');

    // Identity back to A: now OUR record uploads and the pill upgrades.
    state.echoOwner = 'owner-a';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(3);
    expect((state.posts[2]!.items as Array<Record<string, unknown>>)[0]!.question).toBe(
      'Cross owner?',
    );
  });

  test('PARTIAL lifecycle upgrade: one of two pending handles commits → the pill stays honest (queued), then completes', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-plifecycle', [
      wrongChoice('q-pl1', 'Partial one?', 'No', 'Yes'),
      wrongChoice('q-pl2', 'Partial two?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/e2e-c2-plifecycle');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // Both POSTs fail first → both handles pending, pill queued.
    state.failPost = () => '500';
    await answerAllWrongAndSubmit(page, 2);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });
    // Then only q-pl2's event keeps failing: the flush commits q-pl1 alone.
    state.failPost = (body) => {
      const eventId = (body.items as Array<{ eventId?: string }>)[0]!.eventId!;
      return eventId.includes('q-pl2') ? '500' : null;
    };
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(4); // capture posted both + online posted both (1 ok, 1 failed)
    // ALL targets confirmed is the only upgrade condition: still queued.
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(pillText.uploaded)).toHaveCount(0);

    state.failPost = null;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(5); // the remaining handle committed
    for (const row of state.recordsByOwner['owner-a'] ?? []) expect(row.wrongCount).toBe(1);
  });

  test('a REAL re-answer clears the old notice and retry payload (no cross-attempt leakage)', async ({
    page,
  }) => {
    await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-oldattempt', [
      wrongChoice('q-oa1', 'Old attempt?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/e2e-c2-oldattempt');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible();

    // A real re-answer (review → Retry) starts a NEW attempt: the previous
    // attempt's notice and retry affordance must not survive into it.
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /Yes/ }).click(); // answer RIGHT
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 1')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(pillText.localFailed)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry save' })).toHaveCount(0);
    const attempts = await quizAttemptIds(page);
    expect(attempts).toHaveLength(2); // genuinely NEW attempt identity
  });
});

test.describe('C2-2 background refresh keeps inputs and dialogs', () => {
  test('GET 500 keeps cards, picked answer, AND an open classify dialog — also after recovery', async ({
    page,
  }) => {
    await mockMistakes(page);
    await gotoBook(page);

    // Hydration-readiness gate for the PINNED locale: the English Submit
    // control must actually be rendered before anything interacts with it
    // (this is the control that rendered Chinese 提交 in the 308 first run).
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();

    // Prove the input is REALLY picked before injecting the error.
    await page.getByRole('button', { name: /^A\./ }).click();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();

    await page.getByRole('button', { name: 'Classify', exact: true }).first().click();
    const dialog = page.locator('div.absolute.right-0.top-6');
    await expect(dialog).toBeVisible();
    await dialog.locator('select').first().selectOption({ label: 'Math' });

    let inject500 = true;
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'GET' && inject500) {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fallback();
    });
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText(/Not the latest list/).first()).toBeVisible({ timeout: 15_000 });

    // Cards kept, picked input kept, dialog STILL open with its pick intact.
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('select').first()).toHaveValue('math');

    // Recovery (GET 200 via the banner's re-read): everything still intact.
    inject500 = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText(/Not the latest list/)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('select').first()).toHaveValue('math');
  });

  test('503 on first load is the dedicated notConfigured panel, never an error page', async ({
    page,
  }) => {
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 503, body: 'not configured' });
      }
      return route.fallback();
    });
    await page.goto('/mistake-book');
    await expect(
      page.getByText('The mistake book requires server persistence', { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Failed to load the mistake book')).toHaveCount(0);
  });
});

test.describe('C2-3 mutation/GET interleaving', () => {
  test('a stale all-view GET cannot resurrect a DELETED record (real request abort); other stages stay', async ({
    page,
  }) => {
    const state = await mockMistakes(page, [
      RECORD({ questionId: 'q-keep', question: 'Keep me?' }),
      RECORD({ questionId: 'q-gone', question: 'Delete me?' }),
      RECORD({
        stageId: 's-other',
        sceneId: 'sc-other',
        questionId: 'q-other',
        question: 'Other stage?',
      }),
    ]);
    await gotoBook(page, 'Keep me?');

    let holdFirstList = true;
    let releaseList!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let intercepted = 0;
    await page.route('**/api/mistakes**', async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === 'GET' &&
        url.searchParams.get('count') === null &&
        holdFirstList &&
        intercepted === 0
      ) {
        intercepted += 1;
        await held; // the superseded generation stays unanswered…
        // …and would answer with the OLD full list, resurrecting q-gone.
        const stale = state.recordsByOwner['owner-a']!.concat(
          RECORD({ questionId: 'q-gone', question: 'Delete me?' }),
        );
        return route.fulfill({
          status: 200,
          headers: { 'x-owner-id': state.echoOwner },
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { mistakes: stale } }),
        });
      }
      return route.fallback();
    });
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await deleteCardButton(page, 'Delete me?').click();
    await expect(page.getByText('Delete me?')).toHaveCount(0, { timeout: 15_000 });
    holdFirstList = false;
    releaseList();
    await page.waitForTimeout(400); // let the stale response actually land
    await expect(page.getByText('Delete me?')).toHaveCount(0); // never resurrected
    await expect(page.getByText('Keep me?').first()).toBeVisible();
    await expect(page.getByText('Other stage?').first()).toBeVisible(); // other stage kept
    expect(state.recordsByOwner['owner-a']!.map((row) => row.questionId).sort()).toEqual([
      'q-keep',
      'q-other',
    ]);
  });

  test('an OLD all-view GET cannot un-master a record the PATCH already mastered', async ({
    page,
  }) => {
    await mockMistakes(page, [RECORD({ questionId: 'q-m', question: 'Master me?' })]);
    await gotoBook(page, 'Master me?');

    // Hold the PATCH until the test switched the filter to All — the
    // mutation's own refresh GET is then the NEWER generation.
    let patchReceived!: () => void;
    let releasePatch!: () => void;
    const patchHeld = new Promise<void>((resolve) => {
      patchReceived = resolve;
    });
    const patchRelease = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    // And hold the FIRST list GET after the switch (the stale unmastered
    // snapshot) until the mastered refresh has already landed.
    let holdOldGet = false;
    let releaseOldGet!: () => void;
    const oldGetHeld = new Promise<void>((resolve) => {
      releaseOldGet = resolve;
    });
    let oldGetIntercepted = false;
    await page.route('**/api/mistakes**', async (route) => {
      const method = route.request().method();
      const url = new URL(route.request().url());
      if (method === 'PATCH' && route.request().postDataJSON()?.classifyStage === undefined) {
        patchReceived();
        await patchRelease;
        return route.fallback();
      }
      if (
        method === 'GET' &&
        url.searchParams.get('count') === null &&
        holdOldGet &&
        !oldGetIntercepted
      ) {
        oldGetIntercepted = true;
        await oldGetHeld;
        return route.fulfill({
          status: 200,
          headers: { 'x-owner-id': 'owner-a' },
          contentType: 'application/json',
          // The STALE world: the record was still unmastered.
          body: JSON.stringify({
            success: true,
            data: { mistakes: [RECORD({ questionId: 'q-m', question: 'Master me?' })] },
          }),
        });
      }
      return route.fallback();
    });

    await page.getByRole('button', { name: 'Mark mastered' }).click();
    await patchHeld;
    holdOldGet = true;
    await page.getByRole('button', { name: 'All', exact: true }).click();
    releasePatch();
    // The mastered refresh (newer generation) lands first…
    await expect(page.getByText('Back to unmastered').first()).toBeVisible({ timeout: 15_000 });
    // …then the stale unmastered snapshot resolves and must be discarded.
    releaseOldGet();
    await page.waitForTimeout(400);
    await expect(page.getByText('Back to unmastered').first()).toBeVisible(); // still mastered
  });

  test('POST committed + refresh failed: retry re-reads ONLY (no re-POST)', async ({ page }) => {
    const state = await mockMistakes(page);
    let refreshBroken = false;
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'GET' && refreshBroken && state.posts.length >= 1) {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fallback();
    });
    await gotoBook(page);
    refreshBroken = true;
    await page.getByRole('button', { name: /^A\./ }).click();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Saved, but the list refresh failed')).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1); // committed exactly once

    refreshBroken = false;
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByText('Saved, but the list refresh failed')).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(state.posts).toHaveLength(1); // the retry was a GET, never a POST
  });
});

test.describe('C2-4 claim outcomes & mutation failure matrix', () => {
  const unboundSeed = (key: string, eventId: string, questionId: string, question: string) => ({
    key,
    eventId,
    owner: '',
    creationToken: 'old-session',
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending',
    payload: {
      eventId,
      stageId: 's-c2',
      stageName: 'C2 mistakes',
      sceneId: 'sc-c2',
      items: [{ questionId, eventId, questionType: 'single', question, userAnswer: 'A' }],
    },
  });

  test('claim → immediate flush → honest outcome; record appears from the server', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await page.goto('/'); // real origin before touching IndexedDB
    await seedOutbox(page, [unboundSeed('|evt-seed-1', 'evt-seed-1', 'q-seed', 'Seeded offline?')]);
    await page.goto('/mistake-book');
    await expect(page.getByText(/no confirmed identity/i)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect(page.getByText('Claimed 1 event(s); 1 synced to the server')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Seeded offline?').first()).toBeVisible({ timeout: 15_000 });
    expect(state.posts).toHaveLength(1);
  });

  test('claim with a different-content target reports kept conflicts and claims nothing', async ({
    page,
  }) => {
    await mockMistakes(page);
    await page.goto('/');
    const eventId = 'evt-dup-c2';
    const payloadFor = (question: string, userAnswer: string) => ({
      eventId,
      stageId: 's-c2',
      stageName: 'C2 mistakes',
      sceneId: 'sc-c2',
      items: [{ questionId: 'q1', eventId, questionType: 'single', question, userAnswer }],
    });
    await seedOutbox(page, [
      {
        key: `owner-a|${eventId}`,
        eventId,
        owner: 'owner-a',
        creationToken: 'bound',
        createdAt: Date.now(),
        attempts: 0,
        // 'rejected' keeps the mount flush from shipping this frozen target
        // before the claim runs — the claim must meet it in the queue.
        status: 'rejected',
        lastError: 'seeded-quarantine',
        payload: payloadFor('What is $2+2$?', 'BOUND'),
      },
      {
        key: `|${eventId}`,
        eventId,
        owner: '',
        creationToken: 'old-session',
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending',
        payload: payloadFor('What is $2+2$?', 'UNBOUND'),
      },
    ]);
    await page.goto('/mistake-book');
    await expect(page.getByText(/no confirmed identity/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect(
      page.getByText('1 event(s) kept unclaimed: the same id already holds different content'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('claim while identity unconfirmed says so — nothing silently claimed', async ({ page }) => {
    await mockMistakes(page, []);
    await page.goto('/');
    await seedOutbox(page, [
      unboundSeed('|evt-offline-1', 'evt-offline-1', 'q-off', 'Offline seed?'),
    ]);
    await page.route('**/api/mistakes**', (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'GET' && url.searchParams.get('count') !== null) {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fallback();
    });
    await page.goto('/mistake-book');
    await expect(page.getByText(/no confirmed identity/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect(page.getByText('Identity not confirmed — please retry while online')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('claim whose move transaction LATE-ABORTS reports the storage failure — never an empty success', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await page.goto('/');
    await seedOutbox(page, [
      unboundSeed('|evt-abort-claim', 'evt-abort-claim', 'q-abort', 'Aborted claim?'),
    ]);
    await page.goto('/mistake-book');
    await expect(page.getByText(/no confirmed identity/i)).toBeVisible({ timeout: 15_000 });
    // Abort the claim's move transaction (the outbox put) for real.
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect(page.getByText('Local queue unreadable — please retry')).toBeVisible({
      timeout: 15_000,
    });
    expect(state.posts).toHaveLength(0); // nothing shipped, nothing claimed

    // Recovery: disarm and claim again — now it succeeds.
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect(page.getByText('Claimed 1 event(s); 1 synced to the server')).toBeVisible({
      timeout: 15_000,
    });
  });

  const matrixScenarios = [
    { op: 'classify', mode: '500' as const, banner: 'Failed to save classification, please retry' },
    {
      op: 'classify',
      mode: 'abort' as const,
      banner: 'Failed to save classification, please retry',
    },
    { op: 'mastered', mode: '500' as const, banner: 'Saving mastery failed, please retry' },
    { op: 'mastered', mode: 'abort' as const, banner: 'Saving mastery failed, please retry' },
    { op: 'unmaster', mode: '500' as const, banner: 'Saving mastery failed, please retry' },
    { op: 'unmaster', mode: 'abort' as const, banner: 'Saving mastery failed, please retry' },
    { op: 'delete', mode: '500' as const, banner: 'Delete failed, please retry' },
    { op: 'delete', mode: 'abort' as const, banner: 'Delete failed, please retry' },
    { op: 'clearStage', mode: '500' as const, banner: 'Clear failed, please retry' },
    { op: 'clearStage', mode: 'abort' as const, banner: 'Clear failed, please retry' },
  ];
  for (const scenario of matrixScenarios) {
    test(`mutation failure (${scenario.op}, ${scenario.mode}): banner, data intact, same action retries`, async ({
      page,
    }) => {
      const state = await mockMistakes(page, [
        RECORD({
          questionId: 'q-mastered',
          question: 'Already mastered?',
          masteredAt: '2026-10-03T00:00:00.000Z',
        }),
        RECORD({ questionId: 'q2', question: 'Second card?' }),
        RECORD({
          stageId: 's-other',
          sceneId: 'sc-other',
          questionId: 'q-other',
          question: 'Other stage?',
        }),
      ]);
      await gotoBook(page, 'Second card?');
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await expect(page.getByText('Already mastered?').first()).toBeVisible({ timeout: 15_000 });
      let failing = true;
      const setFail = (mode: '500' | 'abort' | null) => {
        state.failMutation =
          scenario.op === 'classify'
            ? { mode, methods: ['PATCH'] }
            : { mode, methods: ['PATCH', 'DELETE'] };
      };
      setFail(failing ? scenario.mode : null);

      const trigger = async () => {
        if (scenario.op === 'classify') {
          await page.getByRole('button', { name: 'Classify', exact: true }).first().click();
          const dialog = page.locator('div.absolute.right-0.top-6');
          // A DIFFERENT subject (the stage is already math — re-picking math
          // is a legitimate no-op that never issues a PATCH).
          await dialog.locator('select').first().selectOption({ label: 'Science' });
          await dialog.getByRole('button', { name: 'Save', exact: true }).click();
          return dialog;
        }
        if (scenario.op === 'mastered') {
          await secondCardMasteredButton(page).click();
          return null;
        }
        if (scenario.op === 'unmaster') {
          await page.getByRole('button', { name: 'Back to unmastered' }).first().click();
          return null;
        }
        if (scenario.op === 'delete') {
          await deleteCardButton(page, 'Second card?').click();
          return null;
        }
        void acceptNextConfirm(page);
        await page.getByRole('button', { name: 'Clear course' }).first().click();
        return null;
      };

      const firstDialog = await trigger();
      await expect(
        page.getByText(scenario.banner),
        `patchLog=${JSON.stringify(state.patchLog)}`,
      ).toBeVisible({
        timeout: 15_000,
      });
      // Everything stays on screen — data AND inputs.
      await expect(page.getByText('Already mastered?').first()).toBeVisible();
      await expect(page.getByText('Second card?').first()).toBeVisible();
      if (scenario.op === 'classify') {
        // The dialog stayed open with its pick.
        await expect(firstDialog!).toBeVisible();
        await expect(firstDialog!.locator('select').first()).toHaveValue('science');
      }

      // Recover and retry the SAME action through the same affordance.
      failing = false;
      setFail(null);
      if (scenario.op === 'classify') {
        await firstDialog!.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText(scenario.banner)).toHaveCount(0, { timeout: 15_000 });
      } else if (scenario.op === 'mastered') {
        // The SAME card the failure hit (its own Mark mastered), and the All
        // view keeps cards — assert THIS card's state flipped, the originally
        // mastered card still shows, and the natural-key PATCH committed.
        await secondCardMasteredButton(page).click();
        await expect(secondCardMasteredButton(page)).toHaveCount(0, { timeout: 15_000 });
        const secondRow = state.recordsByOwner['owner-a']!.find((row) => row.questionId === 'q2');
        expect(secondRow!.masteredAt).not.toBeNull();
        await expect(page.getByText('Already mastered?').first()).toBeVisible(); // kept in All
      } else if (scenario.op === 'unmaster') {
        await page.getByRole('button', { name: 'Back to unmastered' }).first().click();
        await expect(page.getByText(scenario.banner)).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByRole('button', { name: 'Mark mastered' }).first()).toBeVisible({
          timeout: 15_000,
        });
      } else if (scenario.op === 'delete') {
        await deleteCardButton(page, 'Second card?').click();
        await expect(page.getByText('Second card?')).toHaveCount(0, { timeout: 15_000 });
      } else {
        void acceptNextConfirm(page);
        await page.getByRole('button', { name: 'Clear course' }).first().click();
        // The REAL targets of this stage disappear; the other stage stays.
        await expect(page.getByText('Already mastered?')).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByText('Second card?')).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByText('Other stage?').first()).toBeVisible({ timeout: 15_000 });
        expect(state.recordsByOwner['owner-a']!.map((row) => row.questionId)).toEqual(['q-other']);
      }
    });
  }
});

test.describe('C2-5 home badge & list coverage', () => {
  test('restore/delete move the badge by ROW count; a queued NEW capture syncs via the home flush', async ({
    page,
  }) => {
    const state = await mockMistakes(page, [
      RECORD({ questionId: 'q-a', question: 'Badge A?' }),
      RECORD({ questionId: 'q-b', question: 'Badge B?' }),
    ]);
    const badge = page.getByRole('button', { name: 'Mistake book' }).locator('span');
    await page.goto('/');
    await expect(badge).toHaveText('2', { timeout: 15_000 });

    await page.goto('/mistake-book');
    await expect(page.getByText('Badge A?').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Mark mastered' }).first().click();
    await expect(page.getByText('Badge A?')).toHaveCount(0, { timeout: 15_000 });
    await page.goto('/');
    await expect(badge).toHaveText('1', { timeout: 15_000 });

    // Restore (un-master) moves the count back up.
    await page.goto('/mistake-book');
    await page.getByRole('button', { name: 'Mastered', exact: true }).click();
    await page.getByRole('button', { name: 'Back to unmastered' }).first().click();
    await page.goto('/');
    await expect(badge).toHaveText('2', { timeout: 15_000 });

    // Delete moves it down.
    await page.goto('/mistake-book');
    await deleteCardButton(page, 'Badge A?').click();
    await expect(page.getByText('Badge A?')).toHaveCount(0, { timeout: 15_000 });
    await page.goto('/');
    await expect(badge).toHaveText('1', { timeout: 15_000 });

    // A queued NEW capture (classroom, POST 500 → durable) syncs via the
    // home mount flush and the badge reflects the new ROW.
    state.failPost = () => '500';
    await seedClassroom(page, 'e2e-c2-badge', [wrongChoice('q-new', 'Badge new?', 'No', 'Yes')]);
    await page.goto('/classroom/e2e-c2-badge');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });
    // The failed transmission WAS recorded; no business record exists yet.
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect(state.recordsByOwner['owner-a']!.some((row) => row.questionId === 'q-new')).toBe(false);

    state.failPost = null;
    await page.goto('/'); // home mount flush uploads the durable queue
    await expect(badge).toHaveText('2', { timeout: 15_000 });
    // One failed attempt + one committed retransmit of the SAME event; the
    // server counted the question exactly once.
    await expect
      .poll(async () => state.posts.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    const ids = state.posts.map((post) => (post.items as Array<{ eventId?: string }>)[0]!.eventId);
    expect(new Set(ids).size).toBe(1); // every POST is the SAME event
    expect(
      state.recordsByOwner['owner-a']!.filter((row) => row.questionId === 'q-new').map(
        (row) => row.wrongCount,
      ),
    ).toEqual([1]);
  });

  test('a slow OLD count response never overwrites a newer value (request barriers, fresh context)', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      // The FIRST count response is held until the NEWER one has landed;
      // releasing it then must not overwrite the fresh value.
      let releaseOld!: () => void;
      const oldHeld = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let served = 0;
      await page.route('**/api/mistakes**', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' && url.searchParams.get('count') !== null) {
          served += 1;
          if (served === 1) {
            await oldHeld; // the OLD response is held…
            return route.fulfill({
              status: 200,
              headers: { 'x-owner-id': 'owner-a' },
              contentType: 'application/json',
              body: JSON.stringify({ success: true, data: { count: 5 } }),
            });
          }
          return route.fulfill({
            status: 200,
            headers: { 'x-owner-id': 'owner-a' },
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { count: 2 } }),
          });
        }
        if (route.request().method() === 'GET') {
          return route.fulfill({
            status: 200,
            headers: { 'x-owner-id': 'owner-a' },
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { mistakes: [] } }),
          });
        }
        return route.fulfill({ status: 200, body: '{"success":true}' });
      });
      await page.goto('/');
      const badge = page.getByRole('button', { name: 'Mistake book' }).locator('span');
      // A second refresh (the mistakes-changed trigger) races the held one.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('openmaic:mistakes-changed')));
      await expect(badge).toHaveText('2', { timeout: 15_000 });
      // NOW the old response resolves — the guard must reject it.
      releaseOld();
      await page.waitForTimeout(500); // let it actually arrive
      await expect(badge).toHaveText('2');
    } finally {
      await context.close();
    }
  });

  test('>100 rows render completely and stay owner-scoped across an identity switch', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const many = Array.from({ length: 120 }, (_, index) =>
        RECORD({ questionId: `q-big-${index}`, question: `Big list ${index}?`, sceneOrder: index }),
      );
      const state = await mockMistakes(page, many);
      state.recordsByOwner['owner-b'] = [
        RECORD({
          stageId: 's-b',
          sceneId: 'sc-b',
          questionId: 'q-b-only',
          question: 'Only owner B?',
        }),
      ];
      await page.goto('/mistake-book');
      // The full list rendered: the LAST row is reachable.
      await expect(page.getByText('Big list 119?')).toBeVisible({ timeout: 15_000 });
      // Owner isolation: flip the identity, reload — only B's record shows.
      state.echoOwner = 'owner-b';
      await page.reload();
      await expect(page.getByText('Only owner B?')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Big list 0?')).toHaveCount(0);
      await expect(page.getByText('Big list 119?')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('invalid/empty classification normalizes per dimension (subject and grade independently)', async ({
    page,
  }) => {
    await mockMistakes(page, [
      // Bad/empty SUBJECT with a VALID grade → subject-unclassified only.
      RECORD({ questionId: 'q-bad', question: 'Bogus subject?', subject: 'bogus-code' }),
      RECORD({ questionId: 'q-empty', question: 'Empty subject?', subject: '' }),
      // VALID subject (math) with a BOGUS grade → grade-unclassified only;
      // the legal subject must NOT be wiped by the bad grade.
      RECORD({ questionId: 'q-badgrade', question: 'Bogus grade?', gradeSemester: 'nope' }),
    ]);
    await gotoBook(page, 'Bogus subject?');
    await expect(page.getByText('Empty subject?').first()).toBeVisible();
    await expect(page.getByText('Bogus grade?').first()).toBeVisible();

    // Subject = Unclassified → exactly the two subject-broken records; the
    // math+bad-grade record stays under Math.
    await page.getByRole('combobox', { name: 'Subject' }).selectOption({ label: 'Unclassified' });
    await expect(page.getByText('Bogus subject?').first()).toBeVisible();
    await expect(page.getByText('Empty subject?').first()).toBeVisible();
    await expect(page.getByText('Bogus grade?')).toHaveCount(0);

    // Grade = Unclassified → exactly the grade-broken record (subject kept).
    await page.getByRole('combobox', { name: 'Subject' }).selectOption({ index: 0 });
    await page.getByRole('combobox', { name: 'Grade' }).selectOption({ label: 'Unclassified' });
    await expect(page.getByText('Bogus grade?').first()).toBeVisible();
    await expect(page.getByText('Bogus subject?')).toHaveCount(0);
    await expect(page.getByText('Empty subject?')).toHaveCount(0);
  });
});

test.describe('C2-6 classroom refresh (mixed + completed, original identity)', () => {
  test('mixed quiz RELOAD restores the same attempt; recovery completes the ORIGINAL identity; completed reload never re-captures', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
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
    await seedClassroom(page, 'e2e-c2-mixed', [
      wrongChoice('q-m1', 'Mixed choice?', 'No', 'Yes'),
      {
        id: 'q-m2',
        type: 'short_answer',
        question: 'Say hello',
        commentPrompt: 'A greeting.',
        hasAnswer: false,
        points: 1,
      },
    ]);
    await page.goto('/classroom/e2e-c2-mixed');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/ }).click();
    await page.getByPlaceholder('Type your answer here...').fill('bonjour');
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('1 incorrect')).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1); // only the decided-wrong choice captured
    expect((state.posts[0]!.items as Array<Record<string, unknown>>)[0]!.questionId).toBe('q-m1');
    const attemptBefore = (await quizAttemptIds(page))[0];

    // RELOAD mid-grading-recovery: the same attempt restores with the same
    // partial verdict — no new identity, no second capture.
    await page.reload();
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('1 incorrect')).toBeVisible({ timeout: 15_000 });
    expect(await quizAttemptIds(page)).toEqual([attemptBefore]);

    // Recovery completes the SAME attempt: the short answer is now decided
    // wrong and captured; the choice verdict is NOT re-captured.
    aiAvailable = true;
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect(page.getByText('1 ungraded')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(/2\s*incorrect/)).toBeVisible();
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    expect((state.posts[1]!.items as Array<Record<string, unknown>>)[0]!.questionId).toBe('q-m2');
    expect(await quizAttemptIds(page)).toEqual([attemptBefore]); // completed, original identity
    // And a completed-attempt reload restores the review without re-capture.
    await page.reload();
    await expect(page.getByText(/2\s*incorrect/)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(state.posts).toHaveLength(2); // no re-capture on completed reload
  });
});

test.describe('C2-7 capture-state design counters (same-attempt ledger)', () => {
  test('NO-CACHE owner: unbound persist → committed bind → POST 500 → online 200 upgrades along the MIGRATED handle', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    // Identity stays UNCONFIRMED for every probe until the test enables the
    // echo — the capture's records persist UNBOUND first.
    let echoEnabled = false;
    let failPosts = true;
    await page.route('**/api/mistakes**', async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (method === 'GET' && url.searchParams.get('count') !== null && !echoEnabled) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { count: 0 } }),
        }); // no x-owner-id: identity NOT confirmed
      }
      if (method === 'POST' && failPosts) {
        return route.fulfill({
          status: 500,
          headers: { 'x-owner-id': 'owner-a' },
          body: 'offline',
        });
      }
      return route.fallback();
    });
    await seedClassroom(page, 'e2e-c2-nocache', [wrongChoice('q-nc', 'No cache?', 'No', 'Yes')]);
    await page.goto('/classroom/e2e-c2-nocache');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    echoEnabled = true; // the capture's own probe confirms owner-a from here
    await answerAllWrongAndSubmit(page, 1);
    // Unbound record → live bind → POST 500: durable under its owner now.
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });

    failPosts = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    // The flush confirms the MIGRATED handle (owner|event, not the stale
    // |event) — the pill upgrades, the question counted exactly once.
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
  });

  test('PARTIAL abort + online WITHOUT retry: the persisted subset may upload, the pill stays local-failed with its recovery', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-partialonline', [
      wrongChoice('q-po1', 'Partial online one?', 'No', 'Yes'),
      wrongChoice('q-po2', 'Partial online two?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/e2e-c2-partialonline');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(1);
    });
    await answerAllWrongAndSubmit(page, 2);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });

    // Connectivity returns WITHOUT any retry save: the persisted subset
    // uploads — but the unfinished target keeps the honest local-failed
    // notice and the recovery affordance alive.
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1); // subset only
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(pillText.uploaded)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible();

    // NOW the same-event recovery finishes the attempt: each question
    // counted exactly once. (Concurrent-flush reconciliation: the accepted
    // per-instance coordination makes the retry RE-VALIDATE the live row —
    // the already-uploaded subset is NOT retransmitted; only the unfinished
    // target ships. The old third POST was precisely the duplicate-transport
    // behavior the design removes.)
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    const counts = new Map<string, number>();
    for (const row of state.recordsByOwner['owner-a'] ?? [])
      counts.set(String(row.questionId), row.wrongCount as number);
    expect(counts.get('q-po1')).toBe(1);
    expect(counts.get('q-po2')).toBe(1);
  });

  test('no-owner PARTIAL abort: Retry save carries the ORIGINAL proofs, binds its own record; an old unknown stays unbound', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    let echoEnabled = false;
    await page.route('**/api/mistakes**', async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (method === 'GET' && url.searchParams.get('count') !== null && !echoEnabled) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { count: 0 } }),
        });
      }
      return route.fallback();
    });
    await seedClassroom(page, 'e2e-c2-proofretry', [
      wrongChoice('q-pr1', 'Proof one?', 'No', 'Yes'),
      wrongChoice('q-pr2', 'Proof two?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/e2e-c2-proofretry');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(1);
    });
    await answerAllWrongAndSubmit(page, 2);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    // q-pr1 persisted UNBOUND (no owner ever confirmed yet) with proof P1.

    // An unrelated OLD unknown event that must stay exactly where it is.
    // (Disarm first: the armed outbox abort would kill the seed transaction.)
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await seedOutbox(page, [
      {
        key: '|old-unknown-1',
        eventId: 'old-unknown-1',
        owner: '',
        creationToken: 'very-old-session',
        createdAt: Date.now() - 120_000,
        attempts: 0,
        status: 'pending',
        payload: {
          eventId: 'old-unknown-1',
          stageId: 'ancient',
          stageName: 'Ancient',
          sceneId: 'sc-ancient',
          items: [
            {
              questionId: 'q-ancient',
              eventId: 'old-unknown-1',
              questionType: 'single',
              question: 'Ancient?',
              userAnswer: 'A',
            },
          ],
        },
      },
    ]);

    // Identity appears; the retry carries the ORIGINAL operation's proofs:
    // its own unbound record continues binding — the ancient one must NOT.
    echoEnabled = true;
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    const counts = new Map<string, number>();
    for (const row of state.recordsByOwner['owner-a'] ?? [])
      counts.set(String(row.questionId), row.wrongCount as number);
    expect(counts.get('q-pr1')).toBe(1);
    expect(counts.get('q-pr2')).toBe(1);
    // The ancient unknown record is untouched: still unbound (surfaced by the
    // mistake-book queue banner), never shipped.
    await page.goto('/mistake-book');
    await expect(page.getByText(/no confirmed identity/i)).toBeVisible({ timeout: 15_000 });
    expect(state.posts.some((post) => JSON.stringify(post).includes('Ancient?'))).toBe(false);
  });

  test('SAME-ATTEMPT interleave: the choice verdict held at a barrier — no full-success while the short is unresolved; the late choice SUCCESS cannot mask it; then completion', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
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
    // Hold EVERY POST of the choice's event at a barrier in front of the
    // mock (each flush retries the record, so first-only gating would let a
    // later flush commit it out from under the test), and fail the short
    // answer's POST while gated.
    const holdChoice = true;
    let releaseChoice!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseChoice = () => resolve();
    });
    let heldCount = 0;
    let released = false;
    await page.route('**/api/mistakes**', async (route) => {
      const body = route.request().postDataJSON?.() as Record<string, unknown> | undefined;
      const items = body?.items as Array<{ eventId?: string }> | undefined;
      const isChoicePost =
        route.request().method() === 'POST' && String(items?.[0]?.eventId).includes('q-iv1');
      if (isChoicePost && holdChoice && !released) {
        heldCount += 1;
        await gate;
        // Fall through to the mock so the release is a REAL business commit
        // (record insert + deduped replays), not a synthetic response.
        return route.fallback();
      }
      return route.fallback();
    });
    let failShort = true;
    state.failPost = (body) => {
      const eventId = String((body.items as Array<{ eventId?: string }>)[0]?.eventId);
      return eventId.includes('q-iv2') && failShort ? '500' : null;
    };
    await seedClassroom(page, 'e2e-c2-interleave', [
      wrongChoice('q-iv1', 'Interleave choice?', 'No', 'Yes'),
      {
        id: 'q-iv2',
        type: 'short_answer',
        question: 'Say hello',
        commentPrompt: 'A greeting.',
        hasAnswer: false,
        points: 1,
      },
    ]);
    await page.goto('/classroom/e2e-c2-interleave');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/ }).click();
    await page.getByPlaceholder('Type your answer here...').fill('bonjour');
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });

    // The short answer recovers while the choice's POSTs stay held: q1 has
    // NO verdict (saving), q2 is durable-queued (its POST failed).
    aiAvailable = true;
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect(page.getByText(/2\s*incorrect/)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => heldCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1); // the barrier really holds the choice
    // BARRIER ASSERTION (before any release): no full-success claim while
    // any verdict is unresolved. (P2 semantic reconciliation: since the
    // accepted progress protocol, 'saved offline' asserts DURABLE evidence
    // — q1's enqueue committed, so a queued pill here is honest; the
    // original pre-P2 "no queued while transport pending" claim is stale.)
    await expect(page.getByText(pillText.uploaded)).toHaveCount(0);
    await expect(page.getByText(pillText.queued).first()).toBeVisible();

    // Release the held choice POSTs as a LATE SUCCESS: q1 genuinely commits
    // (server-deduped across held retries) — but q2 is STILL unresolved, so
    // the pill must NOT claim full success; the honest state is queued.
    released = true;
    releaseChoice();
    await expect(page.getByText(pillText.queued).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(pillText.uploaded)).toHaveCount(0);

    // Finally the short answer's POST succeeds (connectivity): full success,
    // each question counted exactly once.
    failShort = false;
    state.failPost = null;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    const counts = new Map<string, number>();
    for (const row of state.recordsByOwner['owner-a'] ?? [])
      counts.set(String(row.questionId), row.wrongCount as number);
    expect(counts.get('q-iv1')).toBe(1);
    expect(counts.get('q-iv2')).toBe(1);
  });
});

test.describe('C2-8 claim consumption & upload-receipt counters', () => {
  const unboundSeed = (key: string, eventId: string, questionId: string, question: string) => ({
    key,
    eventId,
    owner: '',
    creationToken: 'old-session',
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending',
    payload: {
      eventId,
      stageId: 's-c2',
      stageName: 'C2 mistakes',
      sceneId: 'sc-c2',
      items: [{ questionId, eventId, questionType: 'single', question, userAnswer: 'A' }],
    },
  });

  test("MIXED claim: an OLD bound record uploads fine, THIS claim's target conflicts — the outcome reports the conflict, never a borrowed success", async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await page.goto('/');
    const eventId = 'evt-claimmix';
    const boundPayload = {
      eventId,
      stageId: 's-old',
      stageName: 'Old bound stage',
      sceneId: 'sc-old',
      items: [
        {
          questionId: 'q-oldbound',
          eventId,
          questionType: 'single',
          question: 'Old bound?',
          userAnswer: 'BOUND',
        },
      ],
    };
    await seedOutbox(page, [
      // An OLD owner-a record that legitimately ships after the claim.
      {
        key: `owner-a|${eventId}`,
        eventId,
        owner: 'owner-a',
        creationToken: 'old-bound',
        createdAt: Date.now() - 60_000,
        attempts: 0,
        status: 'rejected',
        lastError: 'seeded-quarantine',
        payload: boundPayload,
      },
      // THIS claim's unbound target collides with a DIFFERENT-content
      // owner-a record under the same event id.
      {
        key: `|${eventId}`,
        eventId,
        owner: '',
        creationToken: 'old-session',
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending',
        payload: {
          eventId,
          stageId: 's-c2',
          stageName: 'C2 mistakes',
          sceneId: 'sc-c2',
          items: [
            {
              questionId: 'q1',
              eventId,
              questionType: 'single',
              question: 'What is $2+2$?',
              userAnswer: 'UNBOUND',
            },
          ],
        },
      },
      // And a DIFFERENT claimable unbound event with no collision.
      unboundSeed('|evt-claimmix-ok', 'evt-claimmix-ok', 'q-mix-ok', 'Mixed claim ok?'),
    ]);
    await page.goto('/mistake-book');
    await expect(page.getByText(/no confirmed identity/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    // The claim itself reports the kept conflict — never "all synced".
    // Exactly ONE collision (the evt-claimmix twin); the ok event claims and
    // the old bound record ships — the outcome reflects the real numbers,
    // never borrowing the old record's success for the conflicted target.
    // BOTH truths visible (closing gate #4): the success line counts only the
    // ok claim; the kept conflict renders its OWN line.
    await expect(page.getByTestId('claim-outcome')).toHaveText(
      'Claimed 1 event(s); 1 synced to the server',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('claim-conflicts')).toContainText('1 event(s) kept unclaimed', {
      timeout: 5_000,
    });
    expect(state.posts.some((post) => JSON.stringify(post).includes('Old bound?'))).toBe(false);
  });

  test('OWNER SWITCH during the claim flush: claimed records park (409), the outcome honestly reports unsynced — and stays after the queue banner clears', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await page.goto('/');
    await seedOutbox(page, [unboundSeed('|evt-switch', 'evt-switch', 'q-switch', 'Switch claim?')]);
    // Flip the identity ON THE FIRST POST: the claim's probe confirmed
    // owner-a, the flush POST carries expectedOwnerId=owner-a — the echo is
    // now owner-b and the production guard refuses the write (409).
    let flipped = false;
    await page.route('**/api/mistakes**', async (route) => {
      if (route.request().method() === 'POST' && !flipped) {
        flipped = true;
        state.echoOwner = 'owner-b';
      }
      return route.fallback();
    });
    await page.goto('/mistake-book');
    await expect(page.getByText(/no confirmed identity/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    // Claimed but NOT synced — honest unsynced line, record parked not lost.
    await expect(page.getByText('Claimed 1, but 1 still syncing', { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    // REAL request/response observation (closing gate #1): exactly one POST
    // went out under the confirmed identity, the production guard refused it
    // with 409 OWNER_MISMATCH, and NEITHER owner's records were written.
    await expect.poll(async () => state.postRequests.length, { timeout: 15_000 }).toBe(1);
    expect(state.postRequests[0]!.body.expectedOwnerId).toBe('owner-a');
    expect(state.postRequests[0]!.body.items).toHaveLength(1);
    await expect.poll(async () => state.ownerRefusals.length, { timeout: 5_000 }).toBe(1);
    expect(state.ownerRefusals[0]!.body.expectedOwnerId).toBe('owner-a');
    expect(
      (state.recordsByOwner['owner-a'] ?? []).some((row) => row.questionId === 'q-switch'),
    ).toBe(false);
    expect(
      (state.recordsByOwner['owner-b'] ?? []).some((row) => row.questionId === 'q-switch'),
    ).toBe(false);
    // The original owner's frozen queue row is INTACT (parked, not deleted).
    await expect(page.getByText('1 capture(s) pending sync (1 parked').first()).toBeVisible({
      timeout: 15_000,
    });
    const queue = await page.evaluate(() => {
      return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const request = indexedDB.open('MAIC-mistake-outbox');
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const req = db.transaction('events', 'readonly').objectStore('events').getAll();
          req.onsuccess = () => {
            db.close();
            resolve(req.result as Array<Record<string, unknown>>);
          };
          req.onerror = () => reject(req.error);
        };
        request.onerror = () => reject(request.error);
      });
    });
    const parked = queue.find((row) => row.key === 'owner-a|evt-switch');
    expect(parked).toBeDefined();
    expect(parked!['status']).toBe('pending'); // frozen original preserved
  });

  test('RECEIPT race: a background flush uploads+deletes our record before the capture reads — the capture still confirms via the receipt, exactly one count', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-receipt', [
      wrongChoice('q-rc', 'Receipt race?', 'No', 'Yes'),
    ]);
    // Gate the CAPTURE's identity probe: while it hangs, fire 'online' so the
    // lifecycle flush commits + deletes the record first; THEN release the
    // probe — the capture's own flush reads an empty queue and must still
    // confirm through the committed receipt.
    let gateProbeCount = 0;
    let holdProbes = false;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    await page.route('**/api/mistakes**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'GET' && url.searchParams.get('count') !== null) {
        gateProbeCount += 1;
        if (holdProbes && gateProbeCount === 2) {
          await probeGate; // the capture's probe hangs here
        }
      }
      return route.fallback();
    });
    await page.goto('/classroom/e2e-c2-receipt');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    holdProbes = true; // the next count probe (the capture's) will hang
    // Submit; the capture's probe hangs AFTER its records are durable.
    await page.getByRole('button', { name: /No/ }).click();
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('1 incorrect')).toBeVisible({ timeout: 15_000 });
    // Let the background lifecycle flush win the race…
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    // …then release the capture's probe: its own flush reads an EMPTY queue,
    // but the receipt confirms — uploaded, wrongCount exactly one.
    releaseProbe();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1); // no re-POST
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
  });
});

test.describe('C2-9 closing-gate counters', () => {
  const unboundSeed = (key: string, eventId: string, questionId: string, question: string) => ({
    key,
    eventId,
    owner: '',
    creationToken: 'old-session',
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending',
    payload: {
      eventId,
      stageId: 's-c2',
      stageName: 'C2 mistakes',
      sceneId: 'sc-c2',
      items: [{ questionId, eventId, questionType: 'single', question, userAnswer: 'A' }],
    },
  });
  const boundSeed = (
    eventId: string,
    questionId: string,
    question: string,
    userAnswer = 'BOUND',
  ) => ({
    key: `owner-a|${eventId}`,
    eventId,
    owner: 'owner-a',
    creationToken: 'old-bound',
    createdAt: Date.now() - 60_000,
    attempts: 0,
    status: 'pending',
    payload: {
      eventId,
      stageId: 's-old',
      stageName: 'Old bound stage',
      sceneId: 'sc-old',
      items: [{ questionId, eventId, questionType: 'single', question, userAnswer }],
    },
  });

  test('INDEPENDENT old-bound success is NOT borrowed: this claim POST 500 → claimed 1 / synced 0', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await page.goto('/');
    await seedOutbox(page, [
      boundSeed('evt-oldx', 'q-oldx', 'Old independent?'),
      unboundSeed('|evt-mine', 'evt-mine', 'q-mine', 'This claim?'),
    ]);
    // ONLY this claim's event fails; the independent old record succeeds.
    state.failPost = (body) =>
      String((body.items as Array<{ eventId?: string }>)[0]?.eventId).includes('evt-mine')
        ? '500'
        : null;
    await page.goto('/mistake-book');
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    // The old record's success is real but NOT this claim's: synced counts
    // ONLY the claim's committed handles.
    await expect(page.getByText('Claimed 1 event(s); 0 synced to the server')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Old independent?').first()).toBeVisible({ timeout: 15_000 });
    // The claimed record stays durably queued — parked for retry, not lost.
    await expect(page.getByText('1 capture(s) pending sync').first()).toBeVisible({
      timeout: 15_000,
    });
    state.failPost = null;
  });

  test('REVERSE: both succeed — synced counts exactly THIS claim (1), never the old record too', async ({
    page,
  }) => {
    await mockMistakes(page, []);
    await page.goto('/');
    await seedOutbox(page, [
      boundSeed('evt-oldy', 'q-oldy', 'Old independent two?'),
      unboundSeed('|evt-mine2', 'evt-mine2', 'q-mine2', 'This claim two?'),
    ]);
    await page.goto('/mistake-book');
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect(page.getByText('Claimed 1 event(s); 1 synced to the server')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Old independent two?').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('This claim two?').first()).toBeVisible({ timeout: 15_000 });
  });

  test('PARTIAL claim success AND partial conflict are BOTH visible', async ({ page }) => {
    await mockMistakes(page, []);
    await page.goto('/');
    await seedOutbox(page, [
      // Claims cleanly and uploads.
      unboundSeed('|evt-ok9', 'evt-ok9', 'q-ok9', 'Partial ok?'),
      // Conflicts: its target holds DIFFERENT frozen content (quarantined so
      // the mount flush cannot ship or delete it before the claim).
      unboundSeed('|evt-bad9', 'evt-bad9', 'q1', 'What is $2+2$?'),
      {
        ...boundSeed('evt-bad9', 'q1', 'What is $2+2$?', 'FROZEN'),
        status: 'rejected',
        lastError: 'seeded-quarantine',
      },
    ]);
    await page.goto('/mistake-book');
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    // BOTH truths render at once: the success count AND the kept conflict.
    await expect(page.getByText('Claimed 1 event(s); 1 synced to the server')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText('1 event(s) kept unclaimed: the same id already holds different content'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('BARRIER (saving blocks durable copy): q1 verdict held, q2 uploaded — BEFORE release the pill claims nothing', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
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
    let gated = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await page.route('**/api/mistakes**', async (route) => {
      const body = route.request().postDataJSON?.() as Record<string, unknown> | undefined;
      if (route.request().method() === 'POST' && !gated && body?.expectedOwnerId) {
        gated = true; // q1's capture POST hangs: its verdict stays 'saving'
        await gate;
        return route.fulfill({ status: 200, body: 'late' });
      }
      return route.fallback();
    });
    await seedClassroom(page, 'e2e-c2-saving', [
      wrongChoice('q-sv1', 'Saving one?', 'No', 'Yes'),
      {
        id: 'q-sv2',
        type: 'short_answer',
        question: 'Say hello',
        commentPrompt: 'A greeting.',
        hasAnswer: false,
        points: 1,
      },
    ]);
    await page.goto('/classroom/e2e-c2-saving');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/ }).click();
    await page.getByPlaceholder('Type your answer here...').fill('bonjour');
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    // q1's transport verdict is held. Recover the short answer: the regrade
    // pass DEFERS the in-flight q1 instance (per-instance coordination) and
    // sends UNRELATED q2 NOW — q2 really uploads and commits its server row
    // and receipt BEFORE q1's held response is released (the restored
    // independent-interleave counterexample).
    aiAvailable = true;
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect(page.getByText(/2\s*incorrect/)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          state.recordsByOwner['owner-a']?.some((row) => row.questionId === 'q-sv2') ?? false,
        { timeout: 15_000 },
      )
      .toBe(true); // q2 committed BEFORE any release
    // BEFORE releasing q1's held response: no whole-set success claim. (P2
    // reconciliation: q1's enqueue adopted its COMPLETE own durable
    // identity, so an honest "saved offline" label is expected here.)
    await expect(page.getByText(pillText.uploaded)).toHaveCount(0);
    await expect(page.getByText(pillText.queued).first()).toBeVisible();
    // Release: q1 commits (late success) — only then the full success shows,
    // each question counted exactly once.
    releaseGate();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    for (const row of state.recordsByOwner['owner-a'] ?? []) expect(row.wrongCount).toBe(1);
  });
});

test.describe('C2-10 legacy completed/null refresh', () => {
  /**
   * Seed a REAL historical RuntimeStore attempt: a completed session whose
   * reviewed tail still holds an explicitly-undecided (status 'ungraded',
   * correct null) short answer next to a decided-wrong choice. This is the
   * durable state an old client left behind — the LS snapshot path cannot
   * stand in for it.
   */
  async function seedLegacyCompletedRuntime(page: Page, stageId: string) {
    await page.evaluate(
      ({ stageId: id }) => {
        return new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('maic-runtime', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            // EXACTLY the app store's schema (index names included).
            const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
            sessions.createIndex('by-stage-learner', ['stageId', 'learnerKey'], {
              unique: false,
            });
            sessions.createIndex('by-learner', 'learnerKey', { unique: false });
            sessions.createIndex('by-stage', 'stageId', { unique: false });
            db.createObjectStore('records', { keyPath: ['sessionId', 'seq'] });
          };
          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            const learnerKey = JSON.parse(
              localStorage.getItem('maic:device:runtime.learnerKey') ?? '',
            ) as string;
            const tx = db.transaction(['sessions', 'records'], 'readwrite');
            const now = '2026-10-01T00:00:00.000Z';
            tx.objectStore('sessions').put({
              id: 'legacy-completed-1',
              runtimeDslVersion: '0.1.0',
              kind: 'quizAttempt',
              stageId: id,
              learnerKey,
              status: 'completed',
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('records').put({
              id: 'legacy-completed-record-1',
              sessionId: 'legacy-completed-1',
              seq: 0,
              sceneId: 'scene-quiz',
              createdAt: now,
              payload: {
                payloadVersion: 1,
                phase: 'reviewed',
                answers: { 'q-lc1': 'B', 'q-lc2': 'bonjour' },
                results: [
                  { questionId: 'q-lc1', correct: false, status: 'incorrect', earned: 0 },
                  { questionId: 'q-lc2', correct: null, status: 'ungraded', earned: 0 },
                ],
              },
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
      { stageId },
    );
  }

  test('REAL completed RuntimeStore fixture with an undecided verdict: refresh restores ungraded on the ORIGINAL attempt, repair reactivates it, re-grading appends in place (no rollover), capture once along the original identity', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
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
    // Pin the learner key BEFORE anything else so the seeded session lands in
    // the same partition the classroom reads.
    await page.addInitScript(() => {
      // BrowserKVStore persists JSON-encoded values.
      localStorage.setItem('maic:device:runtime.learnerKey', JSON.stringify('anon:fixture-legacy'));
    });
    await seedClassroom(page, 'e2e-c2-legacyrt', [
      wrongChoice('q-lc1', 'LegacyRT choice?', 'No', 'Yes'),
      {
        id: 'q-lc2',
        type: 'short_answer',
        question: 'Say hello',
        commentPrompt: 'A greeting.',
        hasAnswer: false,
        points: 1,
      },
    ]);
    await seedLegacyCompletedRuntime(page, 'e2e-c2-legacyrt');
    await page.goto('/classroom/e2e-c2-legacyrt');
    // The review restores: decided-wrong visible, the null verdict honest.
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('1 incorrect')).toBeVisible({ timeout: 15_000 });
    // The authoritative session is STILL the original completed history —
    // no rollover child was minted, and nothing was captured yet.
    let attempts = await quizAttemptIds(page);
    expect(attempts).toEqual(['legacy-completed-1']);
    await page.waitForTimeout(600);
    expect(state.posts).toHaveLength(0);

    // Reload: same restoration, same identity, still nothing captured.
    await page.reload();
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    attempts = await quizAttemptIds(page);
    expect(attempts).toEqual(['legacy-completed-1']);

    // Re-grade the undecided short answer: this appends to the ORIGINAL
    // attempt (the repair reactivated it) — NOT a rollover retry child —
    // and only the newly-decided question captures, exactly once, with the
    // original attempt embedded in the event id.
    aiAvailable = true;
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect(page.getByText(/2\s*incorrect/)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect((state.posts[0]!.items as Array<Record<string, unknown>>)[0]!.questionId).toBe('q-lc2');
    expect(String((state.posts[0]!.items as Array<{ eventId?: string }>)[0]!.eventId)).toContain(
      'legacy-completed-1',
    );
    expect(
      state.recordsByOwner['owner-a']!.filter((row) => row.questionId === 'q-lc2').map(
        (row) => row.wrongCount,
      ),
    ).toEqual([1]);

    // The authoritative attempt stayed the original throughout — no retry.
    attempts = await quizAttemptIds(page);
    expect(attempts).toEqual(['legacy-completed-1']);
    // Completed reload: the review restores with ZERO new capture.
    await page.reload();
    await expect(page.getByText(/2\s*incorrect/)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(state.posts).toHaveLength(1);
    expect(await quizAttemptIds(page)).toEqual(['legacy-completed-1']);
  });

  test('LS legacy snapshot migrates ONCE (written by the page, cleared by the migration) and never re-creates old data on reload', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-legacyls', [
      wrongChoice('q-ll1', 'LegacyLS choice?', 'No', 'Yes'),
      {
        id: 'q-ll2',
        type: 'short_answer',
        question: 'Say hello',
        commentPrompt: 'A greeting.',
        hasAnswer: false,
        points: 1,
      },
    ]);
    // Same-origin write of the historical localStorage snapshot — NOT an
    // init script (that would re-inject it on every reload).
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem(
        'quizAnswers:scene-quiz',
        JSON.stringify({ 'q-ll1': 'B', 'q-ll2': 'salut' }),
      );
      localStorage.setItem(
        'quizResults:scene-quiz',
        JSON.stringify([
          { questionId: 'q-ll1', correct: false, status: 'incorrect', earned: 0 },
          { questionId: 'q-ll2', correct: null, status: 'ungraded', earned: 0 },
        ]),
      );
      localStorage.setItem('quizAttemptId:scene-quiz', 'legacy-ls-1');
    });
    await page.goto('/classroom/e2e-c2-legacyls');
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('1 incorrect')).toBeVisible({ timeout: 15_000 });
    let attempts = await quizAttemptIds(page);
    expect(attempts).toEqual(['legacy-ls-1']);
    await page.waitForTimeout(400);
    expect(state.posts).toHaveLength(0);

    // Reload: the migration consumed the snapshot — restoring, not
    // re-migrating, and minting nothing new.
    await page.reload();
    await expect(page.getByText('1 ungraded')).toBeVisible({ timeout: 15_000 });
    attempts = await quizAttemptIds(page);
    expect(attempts).toEqual(['legacy-ls-1']);
    await page.waitForTimeout(400);
    expect(state.posts).toHaveLength(0);
  });
});

test.describe('P1 focused: real QuizView new-attempt plan identity', () => {
  test('first attempt q1 wrong (plan A) → REAL re-answer → second attempt q1 wrong (plan B): headers/events/tokens all distinct, each counted once', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'e2e-c2-p1rans', [
      wrongChoice('q-r1', 'P1 reanswer one?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/e2e-c2-p1rans');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    const firstPosts = state.posts.length;
    expect(firstPosts).toBe(1);

    // Read the FIRST attempt's persisted plan straight from the runtime.
    const readPlans = () =>
      page.evaluate(() => {
        return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const request = indexedDB.open('maic-runtime');
          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            const tx = db.transaction('records', 'readonly');
            const req = tx.objectStore('records').getAll();
            req.onsuccess = () => {
              db.close();
              const plans = (req.result as Array<Record<string, unknown>>)
                .map((row) => (row.payload as Record<string, unknown>)?.capturePlan)
                .filter((plan) => plan !== undefined);
              resolve(plans as Array<Record<string, unknown>>);
            };
            req.onerror = () => reject(req.error);
          };
          request.onerror = () => reject(request.error);
        });
      });
    const plans1 = await readPlans();
    expect(plans1).toHaveLength(1);
    const plan1 = plans1[0]!;
    const item1 = (plan1['items'] as Array<Record<string, unknown>>)[0]!;

    // REAL re-answer: Retry → new attempt → wrong again.
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });

    const plans2 = await readPlans();
    expect(plans2).toHaveLength(2); // attempt 1's plan + attempt 2's NEW plan
    const plan2 = plans2.find((plan) => plan['attemptId'] !== plan1['attemptId'])!;
    expect(plan2).toBeDefined();
    const item2 = (plan2['items'] as Array<Record<string, unknown>>)[0]!;

    // Distinct headers (episode/attempt), events, and tokens — nothing reused.
    expect(plan2['attemptId']).not.toBe(plan1['attemptId']);
    expect(plan2['originEpisodeId']).not.toBe(plan1['originEpisodeId']);
    expect(item2['eventId']).not.toBe(item1['eventId']);
    expect(item2['recordToken']).not.toBe(item1['recordToken']);

    // Each attempt's question counted EXACTLY once server-side.
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    const ids = state.posts.map((post) => (post.items as Array<{ eventId?: string }>)[0]!.eventId);
    expect(new Set(ids).size).toBe(2); // two distinct business events
    // The mock's REAL owner-a row: same question, wrongCount exactly 2 (once
    // per attempt) — business counting, not POST counting.
    const rows = state.recordsByOwner['owner-a'] ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wrongCount).toBe(2);
    // Still exactly two persisted plans — no third from re-execution.
    expect((await readPlans()).length).toBe(2);
  });
});
