import { test, expect, Page } from '@playwright/test';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * P3-r1 REAL QuizView entry acceptance — the four focused entry gaps the
 * initial P3 review called out, exercised on real pages (production-
 * semantics API mocks, real IndexedDB, the real plan executor wiring).
 * Hand-seeded ledger entries are NOT used: every assertion observes the
 * page's own durable stores (outbox events / receipts / bindings, capture
 * progress, attempt authority) and the network boundary.
 *
 *   1. known-owner POST 500 → 'queued' pill (full adopted identity) →
 *      ONLINE retry uploads → durable progress CONFIRMED.
 *   2. review+plan committed but the enqueue aborted → refresh → the
 *      recovery runs ONCE from the ready-gated entry and completes.
 *   3. modern unknown-origin capture → explicit claim (real user action,
 *      same-transaction binding journal) → refresh rebuilds NOTHING and a
 *      later q2 enqueues directly under the PROVEN owner A.
 *   4. a pre-existing LEGACY token-less target: the flush's bind dedupes
 *      onto it, the consumer confirms via the legacy destination's own
 *      date, and a subsequent empty-report pass replays receipts only.
 *   5-7. retained r2/r3 barriers: restored attempts are claim-only, a held
 *      POST under a cookie flip never mints B, and a REAL re-answer child
 *      gets exactly one narrow creation ticket.
 *   8-10. r4c REAL old-executor barriers: the OLD operation's executor is
 *      held at a REAL IndexedDB open success (before its queue/progress
 *      transactions), a REAL regrade advances the operation sequence to
 *      its own queued targets, and only then is the old path released —
 *      failure (real first-transaction abort), success, and the old
 *      flush's late-503 probe variants all leave the newer targets'
 *      identity/state/opSeq/durable progress intact with zero B work.
 *   11. restored-session coverage: a RELOADED view whose canonical advanced
 *      to another actor's child Y adopts Y claim-only. (The LIVE child-X
 *      receipt vs canonical-Y race — create X, receipt alive, reader
 *      paused, Y advances, redemption refuses — is a real-RuntimeStore
 *      unit gate: tests/quiz/creation-ticket-race.test.ts, with the
 *      sticky-created-X/existing-Y no-Web-Locks counterexample in
 *      tests/quiz/runtime.test.ts.)
 */

const RECORD = (overrides: Record<string, unknown> = {}) => ({
  stageId: 's-p3r1',
  stageName: 'P3r1 deck',
  sceneId: 'scene-quiz',
  sceneTitle: 'CP',
  sceneOrder: 0,
  subject: 'math',
  gradeSemester: 'grade-1-up',
  questionId: 'q1',
  questionType: 'single',
  question: 'What is $1+1$?',
  options: [
    { label: '1', value: 'A' },
    { label: '2', value: 'B' },
  ],
  correctAnswer: ['A'],
  analysis: '1+1=2.',
  lastUserAnswer: ['B'],
  wrongCount: 1,
  firstWrongAt: '2026-10-03T00:00:00.000Z',
  lastWrongAt: '2026-10-03T00:00:00.000Z',
  masteredAt: null,
  ...overrides,
});

interface MockState {
  recordsByOwner: Record<string, Array<Record<string, unknown>>>;
  posts: Array<Record<string, unknown>>;
  seenEvents: Map<string, string>;
  echoOwner: string;
  failPost: null | ((body: Record<string, unknown>) => '500' | 'abort' | null);
  /** When set, every identity count-probe GET answers with this status. */
  countProbeStatus: null | number;
}

async function mockMistakes(page: Page, seed: Array<Record<string, unknown>> = []) {
  const state: MockState = {
    recordsByOwner: { 'owner-a': seed.map((row) => ({ ...row })) },
    posts: [],
    seenEvents: new Map(),
    echoOwner: 'owner-a',
    failPost: null,
    countProbeStatus: null,
  };
  const findRow = (owner: string, body: Record<string, unknown>) => {
    const rows = state.recordsByOwner[owner] ?? [];
    return rows.find((row) => row.stageId === body.stageId && row.questionId === body.questionId);
  };
  await page.route('**/api/mistakes**', async (route) => {
    const method = route.request().method();
    const owner = state.echoOwner;
    const headers = { 'x-owner-id': owner };
    if (method === 'GET') {
      if (new URL(route.request().url()).searchParams.get('count') !== null) {
        if (state.countProbeStatus !== null) {
          return route.fulfill({
            status: state.countProbeStatus,
            headers,
            body: 'probe-status',
          });
        }
        const rows = state.recordsByOwner[owner] ?? [];
        const count = rows.filter((row) => row.masteredAt == null).length;
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { count } }),
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
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (typeof body.expectedOwnerId === 'string' && body.expectedOwnerId !== owner) {
        return route.fulfill({
          status: 409,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ errorCode: 'OWNER_MISMATCH', message: 'refused' }),
        });
      }
      state.posts.push(body);
      const fail = state.failPost?.(body) ?? null;
      if (fail === '500') return route.fulfill({ status: 500, headers, body: 'offline' });
      const items = body.items as Array<Record<string, unknown>>;
      const eventId = (body.eventId ?? items[0]?.eventId) as string | undefined;
      const dedupeKey = eventId !== undefined ? `${owner}|${eventId}` : undefined;
      const frozen = JSON.stringify(items);
      if (dedupeKey !== undefined && state.seenEvents.has(dedupeKey)) {
        if (state.seenEvents.get(dedupeKey) !== frozen) {
          return route.fulfill({
            status: 409,
            headers,
            contentType: 'application/json',
            body: JSON.stringify({ errorCode: 'EVENT_PAYLOAD_CONFLICT', message: 'conflict' }),
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
      for (const item of items) {
        const row = findRow(owner, { ...body, questionId: item.questionId });
        if (row) {
          row.wrongCount = (row.wrongCount as number) + 1;
          row.lastUserAnswer = item.userAnswer;
        } else {
          (state.recordsByOwner[owner] ??= []).push({
            ...RECORD(),
            questionId: item.questionId as string,
            question: item.question as string,
            lastUserAnswer: item.userAnswer,
            wrongCount: 1,
          });
        }
      }
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { captured: items.length } }),
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
    // Armable IDB late-abort on the OUTBOX database's readwrite puts only
    // (same staging as the C2 suite): window.__armIdbAbort(n) aborts every
    // put AFTER the first n successful ones; __disarmIdbAbort() stops it.
    const abortState = { armed: false, after: 0, seen: 0 };
    (window as unknown as Record<string, unknown>).__armIdbAbort = (after: number) => {
      abortState.armed = true;
      abortState.after = after;
      abortState.seen = 0;
    };
    (window as unknown as Record<string, unknown>).__disarmIdbAbort = () => {
      abortState.armed = false;
    };

    // r4c: armable ONE-SHOT IndexedDB OPEN hold. __holdNextIdbOpen(name)
    // defers the SUCCESS delivery of the NEXT open(name): the REAL database
    // opens (onupgradeneeded included), but the caller's success handler is
    // captured and only invoked by __releaseHeldIdbOpen(mode) — 'ok'
    // releases normally, 'abort-first-tx' additionally makes THAT
    // connection's first transaction really abort once. Later opens of the
    // same name are untouched, so a newer operation proceeds freely.
    const openHold: {
      armed: boolean;
      name: string;
      captured: boolean;
      released: boolean;
      realRequest: IDBOpenDBRequest | null;
      proxy: IDBOpenDBRequest | null;
      success: Array<((event: { target: unknown; type: string }) => void) | null>;
      error: Array<((event: { target: unknown; type: string }) => void) | null>;
      listeners: Array<{ type: string; fn: (event: { target: unknown; type: string }) => void }>;
      dbWrapper: unknown;
      realError: unknown;
    } = {
      armed: false,
      name: '',
      captured: false,
      released: false,
      realRequest: null,
      proxy: null,
      success: [],
      error: [],
      listeners: [],
      dbWrapper: null,
      realError: null,
    };
    const resetOpenHold = (name: string) => {
      openHold.armed = true;
      openHold.name = String(name);
      openHold.captured = false;
      openHold.released = false;
      openHold.realRequest = null;
      openHold.proxy = null;
      openHold.success = [];
      openHold.error = [];
      openHold.listeners = [];
      openHold.dbWrapper = null;
      openHold.realError = null;
    };
    (window as unknown as Record<string, unknown>).__holdNextIdbOpen = (name: string) => {
      resetOpenHold(name);
    };
    (window as unknown as Record<string, unknown>).__idbHoldCaptured = () => openHold.captured;
    (window as unknown as Record<string, unknown>).__releaseHeldIdbOpen = (mode: string) => {
      if (!openHold.captured || openHold.released) return 'idle';
      openHold.released = true;
      const realRequest = openHold.realRequest as (IDBOpenDBRequest & { error?: unknown }) | null;
      const realError = openHold.realError ?? (realRequest ? realRequest.error : null);
      if (realError !== null && realError !== undefined) {
        const fireError = (
          handler:
            | ((event: { target: unknown; type: string; error?: unknown }) => void)
            | null
            | undefined,
        ) =>
          handler?.call(openHold.proxy, {
            target: openHold.proxy,
            type: 'error',
            error: realError,
          });
        for (const entry of openHold.listeners.splice(0)) {
          if (entry.type === 'error') fireError(entry.fn);
        }
        for (const handler of openHold.error.splice(0)) fireError(handler);
        return 'error';
      }
      if (mode === 'abort-first-tx') {
        const realDb = (realRequest as IDBOpenDBRequest).result as IDBDatabase;
        let abortedOnce = false;
        openHold.dbWrapper = new Proxy(realDb, {
          get(target: IDBDatabase, prop: string | symbol) {
            if (prop === 'transaction') {
              return (...txArgs: unknown[]) => {
                const tx = target.transaction(
                  ...(txArgs as [string | string[], IDBTransactionMode?]),
                );
                const w = window as unknown as Record<string, unknown>;
                w.__heldDebug = {
                  ...((w.__heldDebug as object) ?? {}),
                  txCalls: ((w.__heldDebug as { txCalls?: number })?.txCalls ?? 0) + 1,
                };
                if (!abortedOnce) {
                  abortedOnce = true;
                  ((w.__heldDebug as { aborts?: number }) ??= {}).aborts =
                    ((w.__heldDebug as { aborts?: number }).aborts ?? 0) + 1;
                  try {
                    tx.abort();
                  } catch {
                    /* already inactive — the read still fails honestly */
                  }
                }
                return tx;
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          // Event-handler assignments (e.g. db.onversionchange) must run with
          // the REAL database as receiver — a WebIDL setter invoked on the
          // proxy itself throws "Illegal invocation".
          set(target: IDBDatabase, prop: string | symbol, value: unknown) {
            return Reflect.set(target, prop, value);
          },
        });
      }
      const fireSuccess = (handler: (event: { target: unknown; type: string }) => void) =>
        handler.call(openHold.proxy, { target: openHold.proxy, type: 'success' });
      for (const entry of openHold.listeners.splice(0)) {
        if (entry.type === 'success') fireSuccess(entry.fn);
      }
      for (const handler of openHold.success.splice(0)) {
        if (handler) fireSuccess(handler);
      }
      return 'released';
    };
    const makeHeldRequest = (request: IDBOpenDBRequest): IDBOpenDBRequest => {
      openHold.realRequest = request;
      const proxy = new Proxy(request, {
        get(target: IDBOpenDBRequest, prop: string | symbol) {
          if (prop === 'onsuccess') return openHold.success[0] ?? null;
          if (prop === 'onerror') return openHold.error[0] ?? null;
          if (prop === 'result') {
            return openHold.dbWrapper ?? Reflect.get(target, prop, target);
          }
          if (prop === 'addEventListener') {
            return (
              type: string,
              listener: (event: { target: unknown; type: string }) => void,
              ...rest: unknown[]
            ) => {
              if (type === 'success' || type === 'error') {
                openHold.listeners.push({ type, fn: listener });
                return;
              }
              return (
                target.addEventListener as unknown as (
                  this: EventTarget,
                  t: string,
                  l: EventListener,
                  ...o: unknown[]
                ) => void
              ).call(target, type, listener as EventListener, ...rest);
            };
          }
          if (prop === 'removeEventListener') {
            return (type: string, listener: (e: unknown) => void) => {
              const index = openHold.listeners.findIndex(
                (entry) => entry.type === type && entry.fn === listener,
              );
              if (index >= 0) openHold.listeners.splice(index, 1);
              return;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target: IDBOpenDBRequest, prop: string | symbol, value: unknown) {
          if (prop === 'onsuccess') {
            openHold.success[0] = value as (event: { target: unknown; type: string }) => void;
            return true;
          }
          if (prop === 'onerror') {
            openHold.error[0] = value as (event: { target: unknown; type: string }) => void;
            return true;
          }
          Reflect.set(target, prop, value);
          return true;
        },
      });
      openHold.proxy = proxy;
      // A real open ERROR while held must still surface on release.
      request.addEventListener('error', (event) => {
        openHold.realError = (event.target as IDBOpenDBRequest).error;
      });
      return proxy;
    };

    const realIdb = window.indexedDB;
    const realOpen = realIdb.open.bind(realIdb);
    const wrappedOpen = (...args: unknown[]) => {
      const openedName = String(args[0]);
      const request = realOpen(...(args as [string, number?]));
      if (openHold.armed && !openHold.captured && openedName === openHold.name) {
        openHold.captured = true;
        openHold.armed = false;
        return makeHeldRequest(request);
      }
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

// ─── Classroom helpers (real maic-documents seeding) ────────────────────────

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

function shortAnswer(id: string, question: string): SeedQuestion {
  return {
    id,
    type: 'short_answer',
    question,
    commentPrompt: 'Explain',
    hasAnswer: true,
    points: 1,
  };
}

async function seedClassroom(page: Page, stageId: string, questions: SeedQuestion[]) {
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
            name: 'P3r1 quiz deck',
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

async function answerAllWrongAndSubmit(page: Page, questionCount: number) {
  for (let index = 0; index < questionCount; index += 1) {
    await page
      .getByRole('button', { name: /No|wrong/i })
      .nth(index)
      .click();
  }
  await page.getByRole('button', { name: 'Submit Answers' }).click();
  await expect(page.getByText(`/ ${questionCount}`)).toBeVisible({ timeout: 15_000 });
}

const pillText = {
  uploaded: 'Mistakes synced',
  queued: 'Mistakes saved offline',
  localFailed: 'Mistakes could not be saved locally',
  storeError: "Couldn't save mistakes. Retry.",
  unbound: 'identity not linked yet',
  unconfigured: 'Not saved: this deployment has no mistake-book persistence',
} as const;

// ─── r4c barrier helpers (real old-executor holds) ──────────────────────────

/** Whether the armed one-shot IndexedDB open hold has captured its open. */
const idbHoldCaptured = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __idbHoldCaptured: () => boolean }).__idbHoldCaptured(),
  );

/** Release the held open ('ok') or release with a real first-tx abort. */
const releaseHeldIdbOpen = (page: Page, mode: 'ok' | 'abort-first-tx') =>
  page.evaluate(
    (m) =>
      (window as unknown as { __releaseHeldIdbOpen: (x: string) => string }).__releaseHeldIdbOpen(
        m,
      ),
    mode,
  );

/** Outbox rows reduced to their INSTANCE identity (never retry counters). */
async function outboxEventIdentities(page: Page) {
  const rows = await outboxEvents(page);
  return rows.map((row) => ({
    key: row.key,
    eventId: row.eventId,
    owner: row.owner,
    creationToken: row.creationToken,
    createdAt: row.createdAt,
    payload: row.payload,
    status: row.status,
  }));
}

/** Progress rows reduced to the durable decision plane. */
async function progressSnapshot(page: Page) {
  return (await progressRows(page)).map((row) => ({
    scope: row.scope,
    state: row.state,
    actual: row.actual,
    adoption: row.adoption,
    planIdentity: row.planIdentity,
  }));
}

/**
 * Record EVERY downgrade pill text the DOM ever renders from here on: a
 * TRANSIENT store-error/unconfigured flash is a real regression even when
 * a later pass repairs it, so the barriers assert the bad markers were
 * never rendered at all (observed via MutationObserver, not end-state).
 */
async function armPillTransienceProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__pillBadSeen = [] as string[];
    const markers = ["Couldn't save mistakes", 'Not saved: this deployment'];
    const record = () => {
      const text = document.body?.innerText ?? '';
      const seen = w.__pillBadSeen as string[];
      for (const marker of markers) {
        if (text.includes(marker) && !seen.includes(marker)) seen.push(marker);
      }
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

const pillBadSeen = (page: Page) =>
  page.evaluate(
    () => (window as unknown as Record<string, unknown>).__pillBadSeen ?? ([] as string[]),
  );

// ─── Durable-store observers (assert the PAGE's own writes) ─────────────────

/** Read every outbox event row (key/owner/eventId/token/createdAt/status). */
async function outboxEvents(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const open = indexedDB.open('MAIC-mistake-outbox');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('events', 'readonly');
        const req = tx.objectStore('events').getAll();
        req.onsuccess = () => {
          const rows = (req.result ?? []) as Array<Record<string, unknown>>;
          db.close();
          resolve(rows);
        };
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
}

/** Read every capture-progress row (the durable confirmation store). */
async function progressRows(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const open = indexedDB.open('MAIC-capture-progress', 1);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('progress')) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction('progress', 'readonly');
        const req = tx.objectStore('progress').getAll();
        req.onsuccess = () => {
          const rows = (req.result ?? []) as Array<Record<string, unknown>>;
          db.close();
          resolve(rows);
        };
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
}

/** Read every attempt-authority row. */
async function authorityRows(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const open = indexedDB.open('MAIC-capture-progress', 1);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('attempt-authority')) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction('attempt-authority', 'readonly');
        const req = tx.objectStore('attempt-authority').getAll();
        req.onsuccess = () => {
          const rows = (req.result ?? []) as Array<Record<string, unknown>>;
          db.close();
          resolve(rows);
        };
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
}

/** Read every durable-binding journal ENTRY (flattened across composite
 * rows; r1 flat single-record rows map to one entry each). */
async function bindingRows(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const open = indexedDB.open('MAIC-mistake-outbox');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('bindings')) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction('bindings', 'readonly');
        const req = tx.objectStore('bindings').getAll();
        req.onsuccess = () => {
          const rows = (req.result ?? []) as Array<Record<string, unknown>>;
          const entries: Array<Record<string, unknown>> = [];
          for (const row of rows) {
            if (Array.isArray(row.entries)) {
              entries.push(...(row.entries as Array<Record<string, unknown>>));
            } else {
              entries.push(row); // flat r1 row
            }
          }
          db.close();
          resolve(entries);
        };
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
}

test.describe('P3-r1 real QuizView entry acceptance', () => {
  test('1) known-owner POST 500 → queued (full identity) → ONLINE upload → durable progress confirmed', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p3r1-online', [wrongChoice('q-on', 'Online?', 'No', 'Yes')]);
    let postCount = 0;
    await page.route('**/api/mistakes**', async (route) => {
      if (route.request().method() === 'POST') {
        postCount += 1;
        if (postCount === 1) return route.fulfill({ status: 500, body: 'boom' });
        return route.fallback();
      }
      return route.fallback();
    });
    await page.goto('/classroom/p3r1-online');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    // The 500 leaves the record durable under its owner: 'queued', and the
    // page's OWN ledger target now carries the full adopted identity.
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });
    const queuedRows = await outboxEvents(page);
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0]!.owner).toBe('owner-a');
    expect(typeof queuedRows[0]!.creationToken).toBe('string'); // real instance
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1); // counted once
    // The durable progress store is CONFIRMED for this attempt's item with
    // the real upload basis (r1: the online path commits modern progress).
    await expect
      .poll(
        async () => {
          const rows = await progressRows(page);
          return rows.some(
            (row) =>
              row.state === 'confirmed' &&
              (row.adoption === 'upload' || row.adoption === 'receipt') &&
              (row.actual as Record<string, unknown> | undefined)?.owner === 'owner-a',
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test('2) review+plan committed, enqueue aborted → refresh → recovery runs ONCE and completes', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p3r1-recover', [wrongChoice('q-rc', 'Recover?', 'No', 'Yes')]);
    await page.goto('/classroom/p3r1-recover');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // The review + capturePlan commit (runtime store), but the OUTBOX
    // enqueue aborts: nothing is queued, the item honestly fails locally.
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    expect((await outboxEvents(page)).length).toBe(0); // nothing durable queued
    expect(state.posts).toHaveLength(0);
    // Refresh: the review+plan hydrate, and the READY-GATED recovery entry
    // (not a racy void call) re-executes the frozen plan exactly once.
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.reload();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
    const events = await outboxEvents(page);
    expect(events).toHaveLength(0); // uploaded & deleted — no duplicates
    await expect
      .poll(
        async () => {
          const rows = await progressRows(page);
          return rows.some((row) => row.state === 'confirmed');
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    // No duplicate POST after a settling beat (the recovery ran ONCE).
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(1);
  });

  test('3) unknown-origin capture → EXPLICIT CLAIM → refresh rebuilds nothing; later q2 follows A', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    // The identity probe answers with NO echo while the quiz runs, so the
    // plan is genuinely unknown-origin and the record enqueues unbound.
    state.echoOwner = '';
    await seedClassroom(page, 'p3r1-claim', [
      wrongChoice('q-c1', 'Claim one?', 'No', 'Yes'),
      shortAnswer('q-c2', 'Claim two? Explain.'),
    ]);
    await page.route('**/api/quiz-grade', async (route) => {
      // The REAL contract is a score payload; grading unavailable (502) is
      // an honest UNDECIDED verdict — q2 stays ungraded on the first pass.
      return route.fulfill({ status: 502, body: 'Grading unavailable; retry' });
    });
    await page.goto('/classroom/p3r1-claim');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/i }).first().click();
    await page.getByRole('textbox').first().fill('because');
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 2')).toBeVisible({ timeout: 15_000 });
    // r2 item 5 CONTRACT: an unbound record without committed authority is
    // 'unbound' — saved locally, identity not linked, asking for a claim —
    // NEVER a 'sync when back online' promise it cannot keep.
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 15_000 });
    let unbound = (await outboxEvents(page)).filter((row) => row.owner === '');
    expect(unbound).toHaveLength(1); // q1 only — q2 is ungraded (no item)

    // r2 item 5 BARRIER: coming online with identity B and NO claim changes
    // nothing — the record stays unbound and ZERO B POSTs happen.
    state.echoOwner = 'owner-b';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1_500);
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 5_000 });
    expect((await outboxEvents(page)).filter((row) => row.owner === '')).toHaveLength(1);
    expect(state.posts).toHaveLength(0); // no B record, no B POST
    expect(state.recordsByOwner['owner-b']).toBeUndefined();

    // The user EXPLICITLY claims (a real user action on the mistake-book
    // page): the claim commits the move AND the binding journal, and the
    // claimed records upload.
    state.echoOwner = 'owner-a';
    await page.goto('/mistake-book');
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect
      .poll(async () => (await outboxEvents(page)).filter((row) => row.owner === '').length, {
        timeout: 15_000,
      })
      .toBe(0);
    await expect
      .poll(async () => state.posts.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    expect((await bindingRows(page)).length).toBeGreaterThanOrEqual(1);
    const claimBindings = await bindingRows(page);
    expect(claimBindings[0]!.reason).toBe('explicit-claim');

    // Refresh the classroom: the recovery bridge consumes the journal —
    // NOTHING re-enqueues unbound, the progress migrated, the authority
    // is PROVEN for owner A.
    await page.goto('/classroom/p3r1-claim');
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    unbound = (await outboxEvents(page)).filter((row) => row.owner === '');
    expect(unbound).toHaveLength(0); // no rebuilt unbound record
    const authority = await authorityRows(page);
    expect(authority.length).toBeGreaterThanOrEqual(1);
    expect(authority[0]!.effectiveOwner).toBe('owner-a');
    expect((authority[0]!.proof as Record<string, unknown>).kind).toBe('explicit-claim');

    // The later q2 (Retry grading decides it wrong) enqueues DIRECTLY under
    // the PROVEN owner A — never unbound, never cache-B. The decisive grade
    // route is registered BEFORE the click (the request fires immediately).
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 0, comment: 'Not complete.' }),
      });
    });
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    // q2's capture committed exactly once, DIRECTLY under the proven owner:
    // its POST carries the owner-scoped record (uploaded+deleted from the
    // queue), and the durable progress holds a CONFIRMED q2 row under A.
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    await expect
      .poll(
        async () => {
          const rows = await progressRows(page);
          return rows.filter(
            (row) =>
              String((row.planIdentity as Record<string, unknown>)?.questionId) === 'q-c2' &&
              row.state === 'confirmed' &&
              (row.actual as Record<string, unknown> | undefined)?.owner === 'owner-a',
          ).length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    // And no UNBOUND record was ever created for q2 (directly under A).
    expect((await outboxEvents(page)).filter((row) => row.owner === '')).toHaveLength(0);
    for (const row of state.recordsByOwner['owner-a'] ?? []) expect(row.wrongCount).toBe(1);
  });

  test('4) LEGACY dedupe target: same-content reuse adopts its own date; empty-report replays receipts only', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    // KNOWN owner from the start: the mount probe confirms owner-a before
    // grading, so the plan freezes originOwner='owner-a' and its item
    // enqueues directly under the owner-scoped key.
    await seedClassroom(page, 'p3r1-dedupe', [wrongChoice('q-d1', 'Dedupe?', 'No', 'Yes')]);
    await page.goto('/classroom/p3r1-dedupe');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // The review + plan commit, but the outbox enqueue ABORTS — nothing is
    // queued, so the LEGACY target can be seeded before the retry runs.
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    expect((await outboxEvents(page)).length).toBe(0);
    // Disarm the abort FIRST: the seeding below writes to the outbox store
    // the hook scopes, and it must commit.
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    // Seed a LEGACY token-less bound record under owner-a with the EXACT
    // frozen payload the plan committed (read from the runtime store): the
    // retry's enqueue must REUSE this same-content record — never re-mint.
    const frozenPayload = await page.evaluate(() => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const open = indexedDB.open('maic-runtime');
        open.onsuccess = () => {
          const db = open.result;
          const storeNames = [...db.objectStoreNames];
          const records = storeNames.find((name) => name === 'records');
          if (records === undefined) {
            db.close();
            reject(new Error('records store missing'));
            return;
          }
          const tx = db.transaction('records', 'readonly');
          const req = tx.objectStore('records').getAll();
          req.onsuccess = () => {
            const rows = (req.result ?? []) as Array<{
              payload?: { capturePlan?: { items?: Array<{ payload?: unknown }> } };
            }>;
            const item = rows
              .flatMap((row) => row.payload?.capturePlan?.items ?? [])
              .find((entry) => entry.payload !== undefined);
            db.close();
            if (item?.payload === undefined) {
              reject(new Error('capturePlan item payload not found'));
              return;
            }
            resolve(item.payload as Record<string, unknown>);
          };
          req.onerror = () => reject(req.error);
        };
        open.onerror = () => reject(open.error);
      });
    });
    await page.evaluate(
      ({ payload }) => {
        return new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('MAIC-mistake-outbox');
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('events', 'readwrite');
            tx.objectStore('events').put({
              key: `owner-a|${payload.eventId}`,
              eventId: payload.eventId,
              owner: 'owner-a',
              payload,
              createdAt: 555_000,
              attempts: 0,
              status: 'pending',
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          };
          open.onerror = () => reject(open.error);
        });
      },
      { payload: frozenPayload },
    );
    // The plan-item retry (r1 §6) re-runs the MODERN frozen-plan executor:
    // the enqueue REUSES the legacy record (identical content at the same
    // owner+event), the ledger adopts its REAL token-less identity + date,
    // and the flush uploads exactly that instance.
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    // The durable progress adopted the LEGACY instance's OWN identity.
    await expect
      .poll(
        async () => {
          const rows = await progressRows(page);
          return rows.some(
            (row) =>
              row.state === 'confirmed' &&
              (row.actual as Record<string, unknown> | undefined)?.kind === 'legacy' &&
              (row.actual as Record<string, unknown> | undefined)?.recordCreatedAt === 555_000,
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    // No binding journal entry exists (nothing ever bound — the record was
    // created bound); the legacy reuse is the adoption, not a move.
    expect(await bindingRows(page)).toHaveLength(0);
    // A subsequent EMPTY-report pass (everything already uploaded+deleted)
    // replays strict receipts only — no duplicate POST.
    const postsBefore = state.posts.length;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1_500);
    expect(state.posts.length).toBe(postsBefore);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
  });
  test('5) r2 §1 RESTORED unknown attempt regains NO auto-bind privilege (cookie B regrade counterexample)', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    // First live episode: NO identity echo — the plan is unknown-origin and
    // q1's record enqueues unbound; q2 is ungraded (no item yet).
    state.echoOwner = '';
    await seedClassroom(page, 'p3r2-restore', [
      wrongChoice('q-r1', 'Restore one?', 'No', 'Yes'),
      shortAnswer('q-r2', 'Restore two? Explain.'),
    ]);
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({ status: 502, body: 'Grading unavailable; retry' });
    });
    await page.goto('/classroom/p3r2-restore');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/i }).first().click();
    await page.getByRole('textbox').first().fill('because');
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 2')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 15_000 });
    expect((await outboxEvents(page)).filter((row) => row.owner === '')).toHaveLength(1);

    // REFRESH: the attempt is now RESTORED (hydration found stored state) —
    // the ephemeral original-operation capability is revoked. The actual
    // identity cookie is B now (the mocked SERVER ECHO, not localStorage).
    state.echoOwner = 'owner-b';
    await page.reload();
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 15_000 });

    // Retry grading decides q2 WRONG: the regrade mints q2's item and
    // enqueues it — but a restored attempt NEVER auto-binds: no bind proofs
    // are supplied, so q2's fresh unbound row cannot bind to current B.
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 0, comment: 'Not complete.' }),
      });
    });
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (await outboxEvents(page)).filter(
            (row) => row.owner === '' && String(row.eventId).includes('q-r2'),
          ).length,
        { timeout: 15_000 },
      )
      .toBe(1); // q2's record EXISTS — unbound
    // ZERO B POSTs: both records stay unbound until an EXPLICIT claim.
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(0);
    expect(state.recordsByOwner['owner-b']).toBeUndefined();
    expect((await outboxEvents(page)).filter((row) => row.owner !== '')).toHaveLength(0);
    expect(await bindingRows(page)).toHaveLength(0); // no bind committed

    // The explicit claim (real user action) is the ONLY binding path — it
    // syncs BOTH records to B, proving the records were intact all along.
    await page.goto('/mistake-book');
    await page.getByRole('button', { name: 'Claim to this account' }).click();
    await expect
      .poll(async () => (await outboxEvents(page)).filter((row) => row.owner === '').length, {
        timeout: 15_000,
      })
      .toBe(0);
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    expect(state.recordsByOwner['owner-b']).toHaveLength(2);
    for (const row of state.recordsByOwner['owner-b'] ?? []) expect(row.wrongCount).toBe(1);
  });

  test('6) r2 §2 held-POST barrier: q1 bound to A with its POST held; cookie → B; regrade q2 targets A (zero B)', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    // Live episode, unknown origin: echo '' during grading so the plan is
    // unknown; then flip the SERVER ECHO to A right before submission so the
    // executor's own flush probe confirms A and binds the fresh creation.
    state.echoOwner = '';
    await seedClassroom(page, 'p3r2-hold', [
      wrongChoice('q-h1', 'Hold one?', 'No', 'Yes'),
      shortAnswer('q-h2', 'Hold two? Explain.'),
    ]);
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({ status: 502, body: 'Grading unavailable; retry' });
    });
    await page.goto('/classroom/p3r2-hold');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/i }).first().click();
    await page.getByRole('textbox').first().fill('because');
    // HOLD the first mistakes POST behind a DETERMINISTIC RELEASABLE
    // barrier (r3 evidence fix — no permanently unresolved route promise):
    // q1's upload stays in flight, so the report consumption — and with it
    // the progress/authority commits — never runs for q1 until release.
    let heldArrive: (() => void) | null = null;
    const heldArrived = new Promise<void>((resolve) => {
      heldArrive = resolve;
    });
    const releaseHolder: { release?: (response: Response) => void } = {};
    state.echoOwner = 'owner-a';
    await page.route('**/api/mistakes**', async (route) => {
      if (route.request().method() === 'POST') {
        state.posts.push(route.request().postDataJSON() as Record<string, unknown>);
        heldArrive?.();
        const response = await new Promise<Response>((resolve) => {
          releaseHolder.release = resolve;
        });
        return route.fulfill({
          status: response.status,
          contentType: 'application/json',
          headers: { 'x-owner-id': 'owner-a' },
          body: '{"success":true,"data":{"captured":1}}',
        });
      }
      return route.fallback();
    });
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 2')).toBeVisible({ timeout: 15_000 });
    await heldArrived; // q1's POST is genuinely in flight (and held)

    // RAW PRECONDITIONS at the barrier (final review): the committed plan
    // header froze originOwner='' (a periodic probe must NOT have made the
    // plan known-A before creation); the full unknown-source→A binding
    // journal committed in the same transaction as the move — BEFORE the
    // held POST; and the progress/authority migration has NOT committed
    // yet (the report consumption awaits the held flush).
    const barrierPlan = await page.evaluate(() => {
      return new Promise<Record<string, unknown> | null>((resolve, reject) => {
        const open = indexedDB.open('maic-runtime');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('records', 'readonly');
          const req = tx.objectStore('records').getAll();
          req.onsuccess = () => {
            const rows = (req.result ?? []) as Array<{
              payload?: { capturePlan?: Record<string, unknown> };
            }>;
            const withPlan = rows.filter((row) => row.payload?.capturePlan !== undefined).at(-1);
            db.close();
            resolve(withPlan?.payload?.capturePlan ?? null);
          };
          req.onerror = () => reject(req.error);
        };
        open.onerror = () => reject(open.error);
      });
    });
    expect((barrierPlan as { originOwner?: string } | null)?.originOwner).toBe('');
    const barrierBindings = await bindingRows(page);
    expect(barrierBindings.length).toBeGreaterThanOrEqual(1);
    expect(barrierBindings[0]!.reason).toBe('active-bind');
    expect((await progressRows(page)).every((row) => row.state !== 'confirmed')).toBe(true); // progress migration not yet committed at the barrier
    expect(await authorityRows(page)).toHaveLength(0); // authority not yet either

    // The identity cookie changes to B (SERVER ECHO — not localStorage):
    // regrade q2 wrong while q1's POST is still held.
    state.echoOwner = 'owner-b';
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 0, comment: 'Not complete.' }),
      });
    });
    await page.getByRole('button', { name: 'Retry grading' }).click();
    // q2's enqueue resolves the attempt owner FRESH: the durable journal
    // (committed in the bind transaction, BEFORE the held POST) repairs the
    // authority to A — so q2 targets A, parks under B, and NEVER creates a
    // B record. The bind itself already committed A for q1.
    await expect
      .poll(
        async () => {
          const events = await outboxEvents(page);
          return events.some(
            (row) => String(row.eventId).includes('q-h2') && row.owner === 'owner-a',
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await page.waitForTimeout(1_500);
    expect((await outboxEvents(page)).filter((row) => row.owner === 'owner-b')).toHaveLength(0);
    expect(state.recordsByOwner['owner-b']).toBeUndefined();
    const authority = await authorityRows(page);
    expect(authority.length).toBeGreaterThanOrEqual(1);
    expect(authority[0]!.effectiveOwner).toBe('owner-a');
    // The held q1 POST carries A's record identity (expectedOwnerId A).
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]!.expectedOwnerId).toBe('owner-a');
    expect(state.posts[0]!.items).toHaveLength(1);
    // RELEASE the held POST (deterministic drain — this handler fulfills
    // success directly, bypassing the seeding mock) and verify the final
    // bounded facts: q1's A-instance commits (receipt + progress confirm,
    // record leaves the queue); q2 stays parked under B for the owner-A
    // flush; NO B record was ever created.
    releaseHolder.release?.(new Response(null, { status: 200 }));
    await expect
      .poll(
        async () => {
          const rows = await progressRows(page);
          return rows.some(
            (row) =>
              String((row.planIdentity as Record<string, unknown>)?.questionId) === 'q-h1' &&
              row.state === 'confirmed',
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () => (await outboxEvents(page)).some((row) => String(row.eventId).includes('q-h1')),
        { timeout: 15_000 },
      )
      .toBe(false); // uploaded & deleted
    await page.waitForTimeout(1_000);
    expect(state.recordsByOwner['owner-b']).toBeUndefined();
    expect((await outboxEvents(page)).filter((row) => row.owner === 'owner-b')).toHaveLength(0);
  });

  test('7) r3 group 2: REAL re-answer child gets the creation ticket — legal first bind; refresh makes it claim-only', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    // First live episode with NO echo: unknown-origin attempt 1.
    state.echoOwner = '';
    await seedClassroom(page, 'p3r3-reanswer', [wrongChoice('q-a1', 'First?', 'No', 'Yes')]);
    await page.goto('/classroom/p3r3-reanswer');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 15_000 });

    // The identity becomes A DURING this same live episode (the next
    // original operation), and the user performs a REAL re-answer: the
    // retry transition durably creates a NEW child attempt — the narrow
    // creation ticket grants the child the original-operation capability.
    state.echoOwner = 'owner-a';
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    // The child's fresh unbound creation binds LEGALLY to the live-episode
    // confirmed identity A and uploads — the positive the review requires.
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect(state.posts[0]!.expectedOwnerId).toBe('owner-a');
    const childEvents = await outboxEvents(page);
    expect(childEvents.filter((row) => row.owner === '').length).toBe(1); // the OLD attempt's unbound row only
    const childBindings = await bindingRows(page);
    expect(childBindings.length).toBe(1);
    expect(childBindings[0]!.reason).toBe('active-bind'); // the legal fresh bind
    const childAuthority = await authorityRows(page);
    expect(childAuthority.length).toBe(1);
    expect(childAuthority[0]!.effectiveOwner).toBe('owner-a');

    // REFRESH the child (its stored state now exists; the ticket is gone):
    // under cookie B another wrong (a NEW q2 via regrade) is CLAIM-ONLY —
    // no new bind, zero B rows.
    state.echoOwner = 'owner-b';
    await page.reload();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 15_000 });
    expect((await bindingRows(page)).length).toBe(1); // no new binding after refresh
    expect((await authorityRows(page))[0]!.effectiveOwner).toBe('owner-a'); // A preserved
  });
  // ── r4c REAL old/new operation barriers ────────────────────────────────────
  // The prior r4 test here held a POST (already AFTER the old operation's
  // enqueue) and finished with an always-valid progress-schema check — it
  // could not prove the old-local-result/new-target boundary. These three
  // barriers hold the OLD operation's executor at REAL IndexedDB open
  // success continuations (before its queue/progress transactions start —
  // an active IDB put transaction would auto-commit), let a REAL QuizView
  // regrade advance the operation sequence to its own queued targets, and
  // only then release the old path (failure, success, and late-503
  // variants). Later opens stay available, which is exactly what lets the
  // newer operation proceed while the old one is held.

  test('8) r4c OLD-executor REAL barrier (failure variant): precheck open held → regrade re-queues → released read REALLY aborts → newer state intact, zero B', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p3r4c-oldfail', [
      wrongChoice('q-of1', 'Oldfail one?', 'No', 'Yes'),
      shortAnswer('q-of2', 'Oldfail two? Explain.'),
    ]);
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({ status: 502, body: 'unavailable' });
    });
    await page.goto('/classroom/p3r4c-oldfail');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/i }).first().click();
    await page.getByRole('textbox').first().fill('ans');
    // HOLD the OLD operation's executor at its FIRST progress-store open —
    // the precheck read, BEFORE any queue/progress transaction of the old
    // operation starts.
    await page.evaluate(() => {
      (window as unknown as { __holdNextIdbOpen: (n: string) => void }).__holdNextIdbOpen(
        'MAIC-capture-progress',
      );
    });
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 2')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => idbHoldCaptured(page)).toBe(true);

    // The identity flips to B and the user REGRADES: a NEWER same-attempt
    // operation re-owns BOTH questions (fresh opSeq), enqueues both records
    // under the frozen owner A, and settles 'queued' (parked under B, so
    // nothing ever POSTs). The old operation stays held mid-precheck.
    state.echoOwner = 'owner-b';
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 0, comment: 'No.' }),
      });
    });
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect
      .poll(
        async () => {
          const events = await outboxEvents(page);
          return (
            events.some((row) => String(row.eventId).includes('q-of2')) &&
            events.every((row) => row.owner !== 'owner-b')
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });
    const rowsBefore = await outboxEventIdentities(page);
    const progressBefore = await progressSnapshot(page);
    expect(rowsBefore).toHaveLength(2); // BOTH rows minted by the NEWER operation
    for (const row of rowsBefore) expect(row.owner).toBe('owner-a');

    // Release the held open in the FAILURE variant: the old executor's
    // first transaction on the released connection REALLY aborts, so its
    // honest 'unreadable' verdict belongs to the OLD operation. It must
    // land on NOTHING: no store-error downgrade of the newer targets, no
    // obsolete enqueue, no bind, no POST under B.
    await armPillTransienceProbe(page);
    expect(await releaseHeldIdbOpen(page, 'abort-first-tx')).toBe('released');
    await page.waitForTimeout(2_000);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(pillText.storeError)).toHaveCount(0);
    expect(await pillBadSeen(page)).toEqual([]); // no TRANSIENT downgrade either
    expect(await outboxEventIdentities(page)).toEqual(rowsBefore); // identity plane unchanged
    expect(await progressSnapshot(page)).toEqual(progressBefore); // durable progress unchanged
    expect(state.posts).toHaveLength(0); // parked under B — nothing POSTed
    expect(state.recordsByOwner['owner-b']).toBeUndefined();
  });

  test('9) r4c OLD-executor REAL barrier (success variant): released old precheck finds newer evidence → adoption verdict dropped, target intact', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p3r4c-oldok', [
      wrongChoice('q-oo1', 'Oldok one?', 'No', 'Yes'),
      shortAnswer('q-oo2', 'Oldok two? Explain.'),
    ]);
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({ status: 502, body: 'unavailable' });
    });
    await page.goto('/classroom/p3r4c-oldok');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/i }).first().click();
    await page.getByRole('textbox').first().fill('ans');
    await page.evaluate(() => {
      (window as unknown as { __holdNextIdbOpen: (n: string) => void }).__holdNextIdbOpen(
        'MAIC-capture-progress',
      );
    });
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 2')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => idbHoldCaptured(page)).toBe(true);

    state.echoOwner = 'owner-b';
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 0, comment: 'No.' }),
      });
    });
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect
      .poll(
        async () => {
          const events = await outboxEvents(page);
          return (
            events.some((row) => String(row.eventId).includes('q-oo2')) &&
            events.every((row) => row.owner !== 'owner-b')
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });
    const rowsBefore = await outboxEventIdentities(page);
    const progressBefore = await progressSnapshot(page);
    expect(rowsBefore).toHaveLength(2);

    // Release CLEANLY (the success variant): the old precheck now really
    // READS the newer operation's durable facts — pending progress + the
    // queued queue instance — and returns an evidence-queued adoption. That
    // SUCCESS verdict of the old operation must be dropped just the same:
    // the newer target keeps its exact identity/state/opSeq.
    await armPillTransienceProbe(page);
    expect(await releaseHeldIdbOpen(page, 'ok')).toBe('released');
    await page.waitForTimeout(2_000);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 5_000 });
    expect(await pillBadSeen(page)).toEqual([]); // no transient downgrade either
    expect(await outboxEventIdentities(page)).toEqual(rowsBefore);
    expect(await progressSnapshot(page)).toEqual(progressBefore);
    expect(state.posts).toHaveLength(0);
    expect((await outboxEvents(page)).filter((row) => row.owner === 'owner-b')).toHaveLength(0);
  });

  test('10) r4c late-503 REAL barrier: OLD flush probe held → newer operation queued → released OLD 503 cannot downgrade the newer ledger', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p3r4c-late503', [
      wrongChoice('q-lf1', 'Late503 one?', 'No', 'Yes'),
      shortAnswer('q-lf2', 'Late503 two? Explain.'),
    ]);
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({ status: 502, body: 'unavailable' });
    });
    // A route ABOVE the mock holds the FIRST armed identity count-probe —
    // the OLD operation's flush probe (its enqueue and durable note have
    // already committed by the time it fires). Issuing a FRESH 503 after
    // the old operation finished would prove nothing; this hold is the old
    // operation's own in-flight status result.
    // Serialized flush passes (r5 supplement) fix the probe ORDER after the
    // old pass releases: the NEWER operation's chained flush probes FIRST
    // (it was parked on the single-flight chain behind the old pass), and
    // only then the OLD execution's own late-503 sweep status probe runs.
    // The barrier holds BOTH: the newer pass parks at its probe (its own
    // verdicts are not this barrier's subject), and the old sweep's status
    // probe gets the 503 so the OLD sweep truly runs.
    let probeRelease!: (status: number) => void;
    let probeCaptured = false;
    let probeArmed = false;
    let parkedRelease!: (status: number) => void;
    let parkedCaptured = false;
    let oldSweepStatusServed = false;
    await page.route('**/api/mistakes**', async (route) => {
      const isCountProbe =
        route.request().method() === 'GET' &&
        new URL(route.request().url()).searchParams.get('count') !== null;
      if (isCountProbe && probeArmed && !probeCaptured) {
        probeCaptured = true; // the OLD operation's own flush probe
        const status = await new Promise<number>((resolve) => {
          probeRelease = resolve;
        });
        return route.fulfill({ status, body: 'late-probe' });
      }
      if (isCountProbe && probeCaptured && !parkedCaptured) {
        parkedCaptured = true; // the NEWER pass's probe: park it
        const status = await new Promise<number>((resolve) => {
          parkedRelease = resolve;
        });
        return route.fulfill({
          status,
          headers: { 'x-owner-id': 'owner-a' },
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { count: 0 } }),
        });
      }
      if (isCountProbe && parkedCaptured && !oldSweepStatusServed) {
        oldSweepStatusServed = true; // the OLD sweep's status probe: 503
        return route.fulfill({ status: 503, body: 'old-sweep-status' });
      }
      return route.fallback();
    });
    await page.goto('/classroom/p3r4c-late503');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /No/i }).first().click();
    await page.getByRole('textbox').first().fill('ans');
    probeArmed = true; // nothing else probes between here and the old flush
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('/ 2')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => probeCaptured).toBe(true);
    // The held probe IS the old operation's flush: its record is already
    // durably enqueued AND noted (the flush only starts after both).
    await expect.poll(async () => (await outboxEvents(page)).length, { timeout: 15_000 }).toBe(1);
    await expect
      .poll(async () => (await progressRows(page)).some((row) => row.state === 'pending'), {
        timeout: 15_000,
      })
      .toBe(true);

    // The NEWER operation (regrade decides q2 wrong) runs to QUEUED while
    // the old probe is still held: q1 adopts the old record's identity at
    // the NEW opSeq, q2 enqueues fresh, and both stay queued (500s).
    state.failPost = () => '500';
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 0, comment: 'No.' }),
      });
    });
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect
      .poll(
        async () => {
          const events = await outboxEvents(page);
          return events.some((row) => String(row.eventId).includes('q-lf2'));
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 15_000 });
    const rowsBefore = await outboxEventIdentities(page);
    const progressBefore = await progressSnapshot(page);
    const postsBefore = state.posts.length;
    expect(rowsBefore).toHaveLength(2);

    // Release the OLD probe as a 503: the old flush reports unconfigured,
    // the NEWER pass parks at its (held) probe, and the OLD execution's
    // late-503 sweep runs for real against the NEWER targets. The
    // entry-opSeq guard must drop every patch — the pill is NOT downgraded
    // to 'unconfigured' and neither identity nor durable progress moves.
    await armPillTransienceProbe(page);
    probeRelease(503);
    await expect.poll(() => parkedCaptured).toBe(true); // newer pass parked
    await page.waitForTimeout(1_500); // the old sweep runs while it parks
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(pillText.unconfigured)).toHaveCount(0);
    expect(await pillBadSeen(page)).toEqual([]); // never rendered, even transiently
    expect(await outboxEventIdentities(page)).toEqual(rowsBefore);
    expect(await progressSnapshot(page)).toEqual(progressBefore);
    expect(state.posts.length).toBe(postsBefore); // nothing POSTed while held
    // Drain: release the parked newer pass healthily (200 echo) — its own
    // 500-POSTs are its own legitimate work and stay owner-a.
    parkedRelease(200);
    await page.waitForTimeout(1_500);
    await expect(page.getByText(pillText.queued)).toBeVisible({ timeout: 5_000 });
    for (const post of state.posts.slice(postsBefore)) {
      expect(post.expectedOwnerId).toBe('owner-a'); // zero non-A work
    }
  });

  // ── r4c honest coverage note ───────────────────────────────────────────────
  // The prior r4 test here claimed a "child-X vs canonical-Y race", but it
  // waited for the retry AND hydration to settle, created Y, then reloaded
  // the page — the ticket was already consumed and reload destroyed every
  // live ref, so the EARLIER boolean ticket would also have passed it. It
  // is retained below as what it actually is: restored-session coverage.
  // The REAL live-ticket race (create X → receipt alive → canonical reader
  // paused pre-query → another actor advances to Y → redemption refuses Y)
  // is proven against the actual RuntimeStore + the production redemption
  // helper in tests/quiz/creation-ticket-race.test.ts, with the sticky
  // created-X/existing-Y no-Web-Locks counterexample in
  // tests/quiz/runtime.test.ts.

  test("11) restored-session coverage: a RELOADED view whose canonical advanced to another actor's child Y adopts Y claim-only (post-reload; live race in unit gates)", async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    state.echoOwner = '';
    await seedClassroom(page, 'p3r4-race', [wrongChoice('q-x1', 'Race one?', 'No', 'Yes')]);
    await page.goto('/classroom/p3r4-race');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 15_000 });

    // The identity becomes A during this live episode; the user performs
    // the REAL re-answer: this view's locked write creates child X (and
    // consumes the ticket for X on its canonical hydration).
    state.echoOwner = 'owner-a';
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.waitForTimeout(1_000); // the retry write + hydration settle

    // ANOTHER ACTOR advances the canonical latest to child Y (a second
    // retry child written directly into the runtime store), THEN this view
    // re-hydrates (reload): canonical returns Y — no capability for Y.
    const childY = await page.evaluate(() => {
      return new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('maic-runtime');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['sessions', 'records'], 'readwrite');
          const sessions = tx.objectStore('sessions');
          const getAll = sessions.getAll();
          getAll.onsuccess = () => {
            const rows = (getAll.result ?? []) as Array<{
              id: string;
              kind: string;
              status: string;
              stageId: string;
              learnerKey: string;
              createdAt: string;
              updatedAt: string;
            }>;
            const quiz = rows.filter((row) => row.kind === 'quizAttempt');
            const parent = quiz.find((row) => row.status === 'completed');
            if (!parent) {
              db.close();
              reject(new Error('parent not found'));
              return;
            }
            const now = new Date().toISOString();
            // Child Y: newer than everything, ACTIVE, WITH its own stored
            // draft record (another actor's real write) — canonical
            // hydration lands on Y WITH state: no first-ever ambiguity.
            const childY = `${parent.id}#2`;
            sessions.put({
              id: childY,
              kind: 'quizAttempt',
              stageId: parent.stageId,
              learnerKey: parent.learnerKey,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('records').put({
              sessionId: childY,
              seq: 1,
              id: 'y-draft',
              sceneId: undefined,
              createdAt: now,
              payload: { payloadVersion: 1, phase: 'draft', answers: {} },
            });
            tx.oncomplete = () => {
              db.close();
              resolve(childY);
            };
            tx.onerror = () => reject(tx.error);
          };
          getAll.onerror = () => reject(getAll.error);
        };
        open.onerror = () => reject(open.error);
      });
    });
    state.echoOwner = ''; // Y grades under NO identity: unknown-origin plan
    await page.reload(); // canonical hydration now returns child Y (stored)
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.unbound)).toBeVisible({ timeout: 15_000 });
    // Identity B becomes current and an ONLINE flush runs: Y has NO
    // original-operation capability (the ticket names X, consumed/expired),
    // so its fresh unbound record is NEVER auto-bound to B.
    state.echoOwner = 'owner-b';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1_500);
    expect((await outboxEvents(page)).filter((row) => row.owner === 'owner-b')).toHaveLength(0);
    expect(state.posts).toHaveLength(0);
    expect(state.recordsByOwner['owner-b']).toBeUndefined();
    expect(await bindingRows(page)).toHaveLength(0); // no bind committed for Y
    const authority = await authorityRows(page);
    expect(authority).toHaveLength(0); // Y minted no capability
    void childY;
  });

  test('12) r5 supplement DETERMINISTIC concurrent-flush trigger: mount flush held at probe + first POST held → recovery enqueues → release → exactly ONE transport POST', async ({
    page,
  }) => {
    // The r4 FIRST full DOM run (preserved 108a-p3r4-first-run-failure-preserved.log,
    // lines 4371-4388) failed this suite's case 2 with THREE POSTs: the
    // recovery executor's flush raced the mount lifecycle flush (dev
    // StrictMode mounts it twice) inside the enqueue→first-delete window,
    // and every pass that re-read the queue there re-POSTed the same event
    // (business counting stayed 1 only through event-id idempotency). This
    // test triggers that concurrency DETERMINISTICALLY — holding the mount
    // flush's identity probe and the first upload POST — and pins the
    // exactly-once ENTRY contract with the ORIGINAL assertions: one
    // transport POST, wrongCount 1, queue drained, owner-a identity.
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p3r5-flush-race', [wrongChoice('q-fr1', 'Flushrace?', 'No', 'Yes')]);
    await page.goto('/classroom/p3r5-flush-race');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // Review + plan commit; the OUTBOX enqueue aborts (nothing queued).
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    expect((await outboxEvents(page)).length).toBe(0);
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    // Hold the mount lifecycle flush at its IDENTITY PROBE (the first
    // count-probe after reload) and hold the FIRST upload POST: until the
    // probe releases, the serialized passes queue up; without serialization
    // the recovery's own flush POSTs first and the mount pass re-reads the
    // still-queued record when released — the 3-POST interleaving, made
    // deterministic.
    let probeRelease!: () => void;
    let probeCaptured = false;
    let probeArmed = false;
    let postRelease!: (response: { status: number }) => void;
    let postCaptured = false;
    await page.route('**/api/mistakes**', async (route) => {
      const url = new URL(route.request().url());
      const isCountProbe =
        route.request().method() === 'GET' && url.searchParams.get('count') !== null;
      if (isCountProbe && probeArmed && !probeCaptured) {
        probeCaptured = true;
        await new Promise<void>((resolve) => {
          probeRelease = resolve;
        });
        return route.fulfill({ status: 200, headers: { 'x-owner-id': 'owner-a' }, body: '{}' });
      }
      if (route.request().method() === 'POST' && !postCaptured) {
        postCaptured = true;
        await new Promise<{ status: number }>((resolve) => {
          postRelease = resolve;
        });
        // Fall through to the SEEDING mock: it performs the real bookkeeping
        // (posts record, event-id dedupe, wrongCount) for the released POST.
        return route.fallback();
      }
      return route.fallback();
    });
    probeArmed = true;
    await page.reload();
    await expect.poll(() => probeCaptured).toBe(true); // mount flush parked at its probe
    // The recovery runs regardless of the parked flush pass: its ENQUEUE and
    // durable note commit (its own flush queues behind the serialization).
    await expect.poll(async () => (await outboxEvents(page)).length, { timeout: 20_000 }).toBe(1);
    await expect
      .poll(async () => (await progressRows(page)).some((row) => row.state === 'pending'), {
        timeout: 20_000,
      })
      .toBe(true);
    // Release the mount flush's probe: its pass reads the NOW-enqueued
    // record and reaches its upload POST — which is HELD. Only after the
    // settle beat is the POST released; a serialized later pass then finds
    // the queue empty and confirms via the receipt replay.
    probeRelease();
    await expect.poll(() => postCaptured).toBe(true); // a pass is mid-POST, record still queued
    await page.waitForTimeout(1_000); // an unserialized pass would re-read NOW
    postRelease({ status: 200 });
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1); // ONE transport POST — the original exactly-once entry contract
    const body = state.posts[0]! as Record<string, unknown>;
    expect(body.expectedOwnerId).toBe('owner-a');
    expect((body.items as Array<{ questionId: string }>)[0]!.questionId).toBe('q-fr1');
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1); // counted once
    // The queue is drained (uploaded & deleted) and a settle beat adds no
    // replay POST.
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(1);
    expect(await outboxEvents(page)).toHaveLength(0);
    await expect
      .poll(async () => (await progressRows(page)).some((row) => row.state === 'confirmed'), {
        timeout: 15_000,
      })
      .toBe(true);
  });
});
