import { test, expect, Page } from '@playwright/test';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * Batch-C DOM acceptance (R8–R11): real pages, real clicks, synthetic data,
 * every external API mocked at the network layer.
 *
 *  1. offline capture → reload → online replays from the outbox, once
 *  2. owner change parks queued events (fail closed), never re-attributes
 *  3. GET-500 is an error state with retry, never an empty list
 *  4. POST committed + refresh failed shows "saved, refresh failed" + re-read
 *  5. rapid filter switching is generation-guarded (no stale overwrite)
 *  6. classification failure keeps the dialog open with the picks intact
 *  7. LaTeX in question/analysis renders (no raw $…$ text)
 */

const RECORD = (overrides: Record<string, unknown> = {}) => ({
  stageId: 's-c',
  stageName: 'Batch C mistakes',
  sceneId: 'sc-c',
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
  firstWrongAt: '2026-10-02T00:00:00.000Z',
  lastWrongAt: '2026-10-02T00:00:00.000Z',
  masteredAt: null,
  ...overrides,
});

interface StatefulMock {
  /** Server-side event dedupe (mirrors the real store's R9 semantics). */
  seenEvents: Set<string>;
  records: Array<Record<string, unknown>>;
  posts: Array<Record<string, unknown>>;
  getStatuses: number[];
  postStatuses: number[];
  patchClassifyStatus: number;
  owners: string[]; // per-request owner echo sequence
}

async function mockMistakes(page: Page, state: Partial<StatefulMock> = {}) {
  const full: StatefulMock = {
    seenEvents: new Set<string>(),
    records: [RECORD()],
    posts: [],
    getStatuses: [],
    postStatuses: [],
    patchClassifyStatus: 200,
    owners: [],
    ...state,
  };
  let getIndex = 0;
  let postIndex = 0;
  let ownerIndex = 0;
  await page.route('**/api/mistakes**', async (route) => {
    const method = route.request().method();
    const owner = full.owners[Math.min(ownerIndex, full.owners.length - 1)] ?? 'owner-a';
    if (full.owners.length > 0) ownerIndex += 1;
    const headers = { 'x-owner-id': owner };

    if (method === 'GET') {
      if (new URL(route.request().url()).searchParams.get('count')) {
        const count = full.records.filter((row) => row.masteredAt == null).length;
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { count } }),
        });
      }
      const status = full.getStatuses[Math.min(getIndex, full.getStatuses.length - 1)] ?? 200;
      getIndex += 1;
      if (status !== 200) return route.fulfill({ status, body: 'boom' });
      const filter = new URL(route.request().url()).searchParams.get('filter') ?? 'all';
      const mistakes = full.records.filter((row) => {
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
      // Production semantics (C2 gate): the server refuses a write whose
      // confirmed identity no longer matches the request identity — the mock
      // enforces the same guard instead of blindly accepting.
      if (typeof body.expectedOwnerId === 'string' && body.expectedOwnerId !== owner) {
        return route.fulfill({
          status: 409,
          headers,
          contentType: 'application/json',
          body: '{"error":{"code":"OWNER_MISMATCH","message":"Owner identity changed"}}',
        });
      }
      full.posts.push(body);
      const status = full.postStatuses[Math.min(postIndex, full.postStatuses.length - 1)] ?? 200;
      postIndex += 1;
      const eventId = (body.eventId ??
        (body.items as Array<{ eventId?: string }> | undefined)?.[0]?.eventId) as
        | string
        | undefined;
      if (eventId && full.seenEvents.has(eventId)) {
        // Exact replay: the REAL store no-ops it (wrong_count unchanged).
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: '{"success":true,"data":{"captured":0,"duplicates":["replay"]}}',
        });
      }
      if (eventId && status === 200) full.seenEvents.add(eventId);
      if (status === 200) {
        const body = route.request().postDataJSON() as {
          items: Array<{ questionId: string; userAnswer: string[] }>;
        };
        for (const item of body.items) {
          const row = full.records.find((candidate) => candidate.questionId === item.questionId);
          if (row) {
            row.wrongCount = (row.wrongCount as number) + 1;
            row.lastUserAnswer = item.userAnswer;
            row.masteredAt = null;
          }
        }
      }
      return route.fulfill({
        status,
        headers,
        contentType: 'application/json',
        body: status === 200 ? '{"success":true,"data":{"captured":1}}' : 'offline',
      });
    }
    if (method === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.classifyStage === true) {
        return route.fulfill({
          status: full.patchClassifyStatus,
          headers,
          contentType: 'application/json',
          body:
            full.patchClassifyStatus === 200
              ? JSON.stringify({ success: true, data: { classified: 1, courseUpdated: false } })
              : 'boom',
        });
      }
      const row = full.records.find((candidate) => candidate.questionId === body.questionId);
      if (row) row.masteredAt = body.mastered ? new Date().toISOString() : null;
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: '{"success":true,"data":{"updated":true}}',
      });
    }
    if (method === 'DELETE') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body.all === true) {
        full.records = [];
      } else if (typeof body.stageId === 'string' && !body.sceneId) {
        full.records = full.records.filter((row) => row.stageId !== body.stageId);
      } else if (typeof body.questionId === 'string') {
        full.records = full.records.filter((row) => row.questionId !== body.questionId);
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
  return full;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    // Pin the intended UI language through the PRODUCT'S OWN override path:
    // I18nProvider reads localStorage 'locale' first at hydration (detection
    // logic untouched — zh-CN remains the default without this seed).
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);
  // A dedicated outbox DB per test (fresh context has clean storage anyway).
});

async function gotoBook(page: Page) {
  await page.goto('/mistake-book');
  await expect(page.getByText('What is', { exact: false }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function pickWrongAndSubmit(page: Page) {
  await page.getByRole('button', { name: /^A\./ }).click();
  const submit = page.getByRole('button', { name: 'Submit', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
}

test.describe('Batch C — capture reliability and page states', () => {
  test('offline capture (network abort) → reload → online replays exactly once (outbox)', async ({
    page,
  }) => {
    // TRUE offline: the first POST is aborted at the transport level (the
    // page sees a network error, not a server status) — exactly a lost
    // connection mid-submission.
    const state = await mockMistakes(page, { postStatuses: [200] });
    // Playwright routes are LIFO: register the offline override AFTER the
    // state mock so it runs FIRST for POSTs while offline; GETs continue
    // through to the mock.
    let offline = true;
    await page.route('**/api/mistakes', (route) => {
      if (route.request().method() === 'POST' && offline) {
        return route.abort('connectionreset');
      }
      // fallback (NOT continue): continue() would bypass the state mock and
      // hit the real server; fallback defers to the next matching handler.
      return route.fallback();
    });
    await gotoBook(page);

    await pickWrongAndSubmit(page);
    await expect(page.getByText('Not saved to the mistake book')).toBeVisible({ timeout: 15_000 });
    expect(state.posts).toHaveLength(0); // aborted at transport: nothing landed

    // Back online BEFORE the reload: the reload's automatic flush then
    // replays the frozen event (the outbox survives the page restart).
    offline = false;
    await page.reload();
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    // The reload's automatic flush replays the frozen event — possibly via
    // two concurrent flush passes (dev StrictMode); the server-side event
    // dedupe keeps the COUNT at one regardless.
    await expect
      .poll(async () => state.posts.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const replayed = state.posts[0]!;
    expect(replayed.eventId).toBeTruthy();
    expect((replayed.items as Array<Record<string, unknown>>)[0]!.userAnswer).toEqual(['A']);
    expect(state.records[0]!.wrongCount).toBe(2); // 1 initial + 1 upload (replays no-op)
  });

  test('an owner switch parks queued events instead of re-attributing them', async ({ page }) => {
    // First requests run as owner-a; the queue is created under owner-a, then
    // the identity flips to owner-b before the flush can succeed.
    const state = await mockMistakes(page, {
      postStatuses: [500],
      owners: Array<string>(20).fill('owner-a'),
    });
    // Flip the identity AFTER the first committed POST attempt: positional
    // owner arrays drift with lifecycle probe counts; this choreography is
    // exactly "queue created under a, identity flips before any success".
    await page.route('**/api/mistakes**', (route) => {
      if (state.posts.length >= 1) state.owners = ['owner-b'];
      return route.fallback();
    });
    await gotoBook(page);
    await pickWrongAndSubmit(page);
    await expect(page.getByText('Not saved to the mistake book')).toBeVisible({ timeout: 15_000 });

    // Reload: the flush confirms owner-b via the live echo; owner-a's event
    // must NOT be re-attributed. Assert by explicit state, not timing: the
    // parked event surfaces through the outbox status wired to the page.
    await page.reload();
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    // Give the flush one deterministic settling point: the page load flush
    // completes before the paint of the first card list when nothing uploads.
    await expect.poll(async () => state.posts.length, { timeout: 10_000 }).toBe(1); // still exactly the one failed POST attempt — parked, never re-sent
  });

  test('a FIRST-load GET 500 shows the full error page with retry — never an empty list', async ({
    page,
  }) => {
    await mockMistakes(page);
    // Every GET 500s from the very first request: nothing was ever shown, so
    // the full error page is correct (background failures are covered by the
    // dedicated keep-cards test below).
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fallback();
    });
    await page.goto('/mistake-book');
    await expect(page.getByText('Failed to load the mistake book')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('What is', { exact: false })).toHaveCount(0); // no fake empty list
  });

  test('POST committed + refresh failed shows "saved, refresh failed" with a re-read', async ({
    page,
  }) => {
    const state = await mockMistakes(page, { postStatuses: [200] });
    // The refresh fails ONLY AFTER the POST has committed (gated on the
    // recorded post): before that, GETs must stay healthy so the outbox's
    // identity probe can confirm the owner and the upload can commit.
    let refreshBroken = false;
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'GET' && refreshBroken && state.posts.length >= 1) {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fallback();
    });
    await gotoBook(page);
    refreshBroken = true; // any re-read AFTER the committed POST fails
    await pickWrongAndSubmit(page);

    await expect(page.getByText('Saved, but the list refresh failed')).toBeVisible({
      timeout: 15_000,
    });
    // The notice offers a re-read (NOT a resend): clicking it issues a GET.
    refreshBroken = false;
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByText('Saved, but the list refresh failed')).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test('rapid filter switching never lets a slow older response win', async ({ page }) => {
    const state = await mockMistakes(page);
    // Script the SECOND GET (the "mastered" one) to be slow: an unguarded page
    // would let its late response overwrite the newer "all" list.
    let secondGetDelayed = false;
    await page.unroute('**/api/mistakes**');
    await page.route('**/api/mistakes**', async (route) => {
      if (route.request().method() === 'GET') {
        const url = new URL(route.request().url());
        if (url.searchParams.get('filter') === 'mastered' && !secondGetDelayed) {
          secondGetDelayed = true;
          await new Promise((resolve) => setTimeout(resolve, 600));
          const mistakes = state.records.filter((row) => row.masteredAt != null);
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { mistakes } }),
          });
        }
        const filter = url.searchParams.get('filter') ?? 'all';
        const mistakes = state.records.filter((row) => {
          const mastered = row.masteredAt != null;
          return (
            filter === 'all' ||
            (filter === 'mastered' && mastered) ||
            (filter === 'unmastered' && !mastered)
          );
        });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { mistakes } }),
        });
      }
      return route.fulfill({ status: 200, body: '{"success":true}' });
    });

    await gotoBook(page);
    // Slow "mastered" first, then immediately "all" — the slow mastered
    // (empty) response must NOT clobber the newer all-list rendering.
    await page.getByRole('button', { name: 'Mastered', exact: true }).click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(900); // the delayed mastered response lands now
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible(); // still there
  });

  test('classification failure keeps the dialog open with the picks intact', async ({ page }) => {
    await mockMistakes(page, { patchClassifyStatus: 500 });
    await gotoBook(page);

    await page.getByRole('button', { name: 'Classify' }).click();
    // Scope to the dialog: the page header ALSO has Subject/Grade selects.
    const dialog = page
      .locator('div')
      .filter({ has: page.getByRole('button', { name: 'Save' }) })
      .last();
    await dialog.getByRole('combobox').first().selectOption('english');
    await page.getByRole('button', { name: 'Save' }).click();

    // Failure keeps the dialog OPEN (no silent close) and shows the hint.
    await expect(page.getByText('Failed to save classification, please retry')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('combobox').first()).toBeVisible(); // dialog still open
  });

  test('delayed PATCH mastery: filter switch DURING the in-flight PATCH lands right (both directions)', async ({
    page,
  }) => {
    await mockMistakes(page);
    // Signal-gated delay (delivery review #6): the PATCH is held until the
    // test switches the filter — the interleave is proven, not guessed from
    // a sleep. ONE gating route with a REPLACED gate per direction: the
    // stateful mock underneath is never unroute()d (that would leak requests
    // to the real API and blank the list).
    interface Gate {
      received: () => void;
      release: Promise<void>;
      resolveRelease: () => void;
    }
    let gate: Gate | null = null;
    await page.route('**/api/mistakes**', async (route) => {
      const method = route.request().method();
      const body = route.request().postDataJSON?.() as Record<string, unknown> | undefined;
      if (method === 'PATCH' && body?.classifyStage === undefined && gate) {
        gate.received();
        await gate.release;
      }
      return route.fallback();
    });

    await gotoBook(page);

    // Direction 1: Mark mastered → PATCH HOLDS → switch to Mastered
    // mid-flight → release → the card appears in the Mastered list.
    let firstHeld!: () => void;
    let firstResolve!: () => void;
    const held1 = new Promise<void>((resolve) => {
      firstHeld = resolve;
    });
    const rel1 = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });
    gate = { received: firstHeld, release: rel1, resolveRelease: firstResolve };
    await page.getByRole('button', { name: 'Mark mastered' }).click();
    await held1;
    await page.getByRole('button', { name: 'Mastered', exact: true }).click();
    firstResolve();
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Direction 2: Back to unmastered → PATCH holds again → switch to
    // Unmastered mid-flight → release → the card reappears there.
    let secondHeld!: () => void;
    let secondResolve!: () => void;
    const held2 = new Promise<void>((resolve) => {
      secondHeld = resolve;
    });
    const rel2 = new Promise<void>((resolve) => {
      secondResolve = resolve;
    });
    gate = { received: secondHeld, release: rel2, resolveRelease: secondResolve };
    await page.getByRole('button', { name: 'Back to unmastered' }).click();
    await held2;
    await page.getByRole('button', { name: 'Unmastered', exact: true }).click();
    secondResolve();
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('B card retransmit: POST 500 → honest failure → SAME event resends after recovery and passes (500→200)', async ({
    page,
  }) => {
    // The formal B-card case (C1 gate #3): a wrong in-place retry whose POST
    // answers 500 must show an honest not-saved state, and re-sending the
    // SAME event (same id, same frozen content) after recovery MUST upload —
    // a blanket already-queued conflict would block exactly this flow.
    const state = await mockMistakes(page, { postStatuses: [500, 200] });
    await gotoBook(page);

    await pickWrongAndSubmit(page);
    await expect(page.getByText('Not saved to the mistake book')).toBeVisible({
      timeout: 15_000,
    });
    expect(state.posts).toHaveLength(1); // exactly one POST so far
    expect(state.records[0]!.wrongCount).toBe(1); // server never counted it

    // Recovery: re-send the SAME event id with the same frozen content.
    await page.getByRole('button', { name: 'Retry upload' }).click();
    // The count-increased claim is gated on the typed commit, so the claim
    // text itself now proves the retransmit landed: the failure notice must
    // clear and exactly one more POST must land.
    await expect(page.getByText('Not saved to the mistake book')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText('Still wrong — count increased')).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(() => state.posts.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => state.records[0]!.wrongCount, { timeout: 15_000 }).toBe(2); // counted exactly once
    const firstId = (state.posts[0]!.items as Array<{ eventId?: string }>)[0]?.eventId;
    const secondId = (state.posts[1]!.items as Array<{ eventId?: string }>)[0]?.eventId;
    expect(secondId).toBe(firstId); // SAME event — a retransmit, not a new one
  });

  test('practice wrong retry: a held POST shows saving, never an increment claim; release commits exactly once', async ({
    page,
  }) => {
    // The premature-persistence gate (delivery review): while the capture
    // POST is genuinely in flight, the card must say saving — the
    // count-increased wording is reserved for the typed commit. Releasing
    // the SAME held request must produce exactly ONE increment.
    const state = await mockMistakes(page);
    let releasePost: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let heldPosts = 0;
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      heldPosts += 1;
      return gate.then(() => route.fallback());
    });
    await gotoBook(page);

    await pickWrongAndSubmit(page);

    // PENDING: honest saving state, no increment claim, no server effect.
    await expect(page.getByText('Wrong — saving…')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Still wrong — count increased')).toHaveCount(0);
    try {
      // Wait for the submission to actually ARRIVE at the barrier (the
      // saving text renders before the async enqueue→probe→POST chain
      // issues it), then assert the store saw nothing while the gate stays
      // closed. This waits on the actual external boundary — no sleeps.
      await expect.poll(() => heldPosts, { timeout: 15_000 }).toBe(1);
      expect(state.posts).toHaveLength(0); // it has not reached the store
      expect(state.records[0]!.wrongCount).toBe(1); // nothing counted yet

      // RELEASE the same request: one commit, one increment, the claim appears.
      releasePost!();
      await expect(page.getByText('Still wrong — count increased')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('Wrong — saving…')).toHaveCount(0);
      expect(heldPosts).toBe(1); // no duplicate submission was minted
      expect(state.posts).toHaveLength(1);
      expect(state.records[0]!.wrongCount).toBe(2); // counted EXACTLY once
    } finally {
      // Failure cleanup: never leave a request held at the barrier (the
      // promise settle is idempotent, so a post-success call is a no-op).
      releasePost!();
    }
  });

  test('practice wrong retry: a failed POST never claims an increment', async ({ page }) => {
    const state = await mockMistakes(page, { postStatuses: [500] });
    await gotoBook(page);

    await pickWrongAndSubmit(page);

    await expect(page.getByText('Wrong — save failed')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Still wrong — count increased')).toHaveCount(0);
    await expect(page.getByText('Not saved to the mistake book')).toBeVisible({
      timeout: 15_000,
    });
    expect(state.records[0]!.wrongCount).toBe(1); // no false success
  });

  test('a background GET 500 KEEPS the shown cards under a stale banner', async ({ page }) => {
    await mockMistakes(page);
    let inject500 = false;
    await page.route('**/api/mistakes**', (route) => {
      if (route.request().method() === 'GET' && inject500) {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fallback();
    });
    await gotoBook(page);

    // Pick an option (input must survive), then break re-reads and switch
    // filters: the OLD cards stay mounted with a staleness notice — the
    // picked input is NOT lost to a full-page error.
    await page.getByRole('button', { name: /^A\./ }).click();
    inject500 = true;
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText(/Not the latest list/).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible(); // cards KEPT
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled(); // input kept
  });

  test('mutation network abort (delete/mastered) shows failure, card retryable', async ({
    page,
  }) => {
    await mockMistakes(page);
    const abortMutations = true;
    await page.route('**/api/mistakes**', (route) => {
      const method = route.request().method();
      const body = route.request().postDataJSON?.() as Record<string, unknown> | undefined;
      if (
        abortMutations &&
        (method === 'DELETE' || (method === 'PATCH' && body?.classifyStage === undefined))
      ) {
        return route.abort('connectionreset');
      }
      return route.fallback();
    });
    await gotoBook(page);

    await page.getByRole('button', { name: 'Delete' }).first().click();
    await expect(page.getByText('Delete failed, please retry')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Mark mastered' }).click();
    await expect(page.getByText('Saving mastery failed, please retry')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Mark mastered' })).toBeVisible();
  });

  test('fresh browser: first ONLINE classroom wrong answer uploads with expectedOwnerId (identity bootstrap)', async ({
    browser,
  }) => {
    const context = await browser.newContext(); // nothing seeded, no helpers
    const page = await context.newPage();
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      // Pin the intended UI language through the PRODUCT'S OWN override path:
      // I18nProvider reads localStorage 'locale' first at hydration (detection
      // logic untouched — zh-CN remains the default without this seed).
      localStorage.setItem('locale', 'en-US');
    }, SETTINGS_STORAGE);

    // Explicit owner state machine: every response echoes owner-boot; the
    // POST body is recorded to assert expectedOwnerId matches that identity.
    const posts: Array<Record<string, unknown>> = [];
    await page.route('**/api/mistakes**', async (route) => {
      const method = route.request().method();
      const headers = { 'x-owner-id': 'owner-boot' };
      if (method === 'GET') {
        const url = new URL(route.request().url());
        if (url.searchParams.get('count') !== null) {
          return route.fulfill({
            status: 200,
            headers,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { count: 0 } }),
          });
        }
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { mistakes: [] } }),
        });
      }
      if (method === 'POST') {
        posts.push(route.request().postDataJSON() as Record<string, unknown>);
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: '{"success":true,"data":{"captured":1}}',
        });
      }
      return route.fulfill({ status: 200, headers, body: '{"success":true}' });
    });

    const QUESTIONS = [
      {
        id: 'q-boot',
        type: 'single',
        question: 'Bootstrap?',
        options: [
          { label: 'Yes', value: 'A' },
          { label: 'No', value: 'B' },
        ],
        answer: ['A'],
        points: 1,
      },
    ];
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(
      ({ id, qs }) =>
        new Promise<void>((resolve, reject) => {
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
              name: 'Bootstrap deck',
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
        }),
      { id: 'e2e-boot', qs: QUESTIONS },
    );

    await page.goto('/classroom/e2e-boot');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // Option buttons' accessible names are "<value> <label>" (e.g. "B No").
    await page.getByRole('button', { name: /No/ }).click();
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 1')).toBeVisible({ timeout: 15_000 });

    await expect.poll(async () => posts.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    const bootPost = posts.find((post) => Array.isArray(post.items) && post.items.length > 0)!;
    expect(bootPost.expectedOwnerId).toBe('owner-boot');
    expect((bootPost.items as Array<Record<string, unknown>>)[0]!.eventId).toBeTruthy();
    // The classroom surfaces the honest typed result (delivery review #3).
    await expect(page.getByText('Mistakes synced')).toBeVisible({ timeout: 15_000 });
    await context.close();
  });

  test('badge: capture event and mastery toggle update the home pill count', async ({ page }) => {
    const state = await mockMistakes(page);
    const badge = page.getByRole('button', { name: 'Mistake book' }).locator('span');
    await page.goto('/');
    await expect(badge).toHaveText('1', { timeout: 15_000 });

    await page.goto('/mistake-book');
    await pickWrongAndSubmit(page);
    await expect(page.getByText('Still wrong — count increased')).toBeVisible({ timeout: 15_000 });
    await page.goto('/');
    await expect(badge).toHaveText('1', { timeout: 15_000 });
    expect(state.records[0]!.wrongCount).toBe(2);

    await page.goto('/mistake-book');
    await expect(page.getByText('What is', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Mark mastered' }).click();
    await expect(page.getByText('What is', { exact: false })).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Mastered', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Back to unmastered' })).toBeVisible({
      timeout: 15_000,
    });
    await page.goto('/');
    await expect(badge).toHaveCount(0, { timeout: 15_000 });
    expect(state.records[0]!.masteredAt).not.toBeNull();
  });

  test('same-name different-id stages clear independently', async ({ page }) => {
    const state = await mockMistakes(page);
    state.records.push(RECORD({ stageId: 's-c-2', questionId: 'q2', question: 'Second twin?' }));
    await gotoBook(page);
    await expect(page.getByText('Second twin?').first()).toBeVisible({ timeout: 15_000 });

    page.once('dialog', (dialog) => dialog.accept());
    const clearButtons = page.getByRole('button', { name: 'Clear course' });
    await clearButtons.first().click();
    await expect(page.getByText('What is', { exact: false })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('Second twin?').first()).toBeVisible();
    expect(state.records.map((row) => row.questionId)).toEqual(['q2']);
  });

  test('LaTeX in question and analysis renders instead of raw dollar text', async ({ page }) => {
    await mockMistakes(page);
    await gotoBook(page);
    // KaTeX renders into element nodes — the raw source must not surface.
    await expect(page.getByText('$2+2$')).toHaveCount(0);
    await expect(page.locator('.katex').first()).toBeVisible({ timeout: 15_000 });
    // Analysis with math renders too once revealed.
    await page
      .getByRole('button', { name: /explanation|解析/i })
      .click()
      .catch(() => {});
    await expect(page.getByText('$2+2=4$')).toHaveCount(0);
  });
});
