import { test, expect, Page } from '@playwright/test';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * C2-P4 REAL page recovery matrix + both-consumer empty-report race
 * (codex-c2-p4-full-acceptance-design-2026-10-03.md), on the real QuizView
 * / runtime writer / plan executor with real IndexedDB and production-
 * semantics API mocks. Raw persisted plan/progress/queue/receipt facts and
 * the network boundary are asserted — a green pill alone proves nothing.
 *
 *   M1 review+plan committed, first queue tx aborted → refresh recovers the
 *      frozen event/payload/token/owner EXACTLY once; settling is stable.
 *   M2 q1 confirmed while q2's local enqueue fails → refresh retries ONLY
 *      q2; a completed-plan refresh POSTs nothing.
 *   M3 (retained e2e p3-entry test 6: held q1 upload, retry-grading usable,
 *      bind A committed pre-hold, cookie→B keeps q2 A/parked, zero B.)
 *   M4 frozen known-A empty plan → refresh under cookie B → new wrong q2
 *      still enqueues under frozen A (parked under B, zero B).
 *   M5 progress writes really abort → honest retryable (never uploaded);
 *      after repair the durable receipt confirms with NO new POST.
 *   M6 LEGACY no-plan review → modern upgrade keeps the immutable legacy
 *      exemption: q1 is never re-captured; only q2 captures.
 *   RACE classroom empty-report race: page1's flush read is held after its
 *      record committed; a SECOND PAGE in the SAME browser context (shared
 *      IndexedDB) uploads+deletes it; the released original returns the
 *      empty report and its consumer settles once via the exact receipt.
 */

const RECORD = (overrides: Record<string, unknown> = {}) => ({
  stageId: 's-p4',
  stageName: 'P4 deck',
  sceneId: 'scene-quiz',
  sceneTitle: 'P4',
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
          return route.fulfill({ status: state.countProbeStatus, headers, body: 'probe-status' });
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

/** Context-wide mistakes mock: every page in the context is intercepted. */
async function mockMistakesOnContext(
  context: import('@playwright/test').BrowserContext,
  seed: Array<Record<string, unknown>> = [],
) {
  const state: MockState = {
    recordsByOwner: { 'owner-a': seed.map((row) => ({ ...row })) },
    posts: [],
    seenEvents: new Map(),
    echoOwner: 'owner-a',
    failPost: null,
    countProbeStatus: null,
  };
  const handler = async (route: import('@playwright/test').Route) => {
    const method = route.request().method();
    const owner = state.echoOwner;
    const headers = { 'x-owner-id': owner };
    if (method === 'GET') {
      if (new URL(route.request().url()).searchParams.get('count') !== null) {
        if (state.countProbeStatus !== null) {
          return route.fulfill({ status: state.countProbeStatus, headers, body: 'probe-status' });
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
      const items = body.items as Array<Record<string, unknown>>;
      const eventId = (body.eventId ?? items[0]?.eventId) as string | undefined;
      const dedupeKey = eventId !== undefined ? `${owner}|${eventId}` : undefined;
      const frozen = JSON.stringify(items);
      const rows = state.recordsByOwner[owner] ?? [];
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
        const row = rows.find(
          (r) => r.stageId === body.stageId && r.questionId === item.questionId,
        );
        if (row) {
          row.wrongCount = (row.wrongCount as number) + 1;
          row.lastUserAnswer = item.userAnswer;
        } else {
          rows.push({
            ...RECORD(),
            questionId: item.questionId as string,
            question: item.question as string,
            lastUserAnswer: item.userAnswer,
            wrongCount: 1,
          });
        }
      }
      state.recordsByOwner[owner] = rows;
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { captured: items.length } }),
      });
    }
    return route.fulfill({ status: 200, headers, body: '{"success":true}' });
  };
  await context.route('**/api/mistakes**', handler);
  return state;
}

async function installPageHooks(page: Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    // Pin the intended UI language through the PRODUCT'S OWN override path:
    // I18nProvider reads localStorage 'locale' first at hydration (detection
    // logic untouched — zh-CN remains the default without this seed).
    localStorage.setItem('locale', 'en-US');
    // Armable IDB late-abort, per database: puts AFTER the first n
    // successful ones abort (their transaction really aborts).
    const abortState = { armed: false, after: 0, seen: 0, name: '' };
    const w = window as unknown as Record<string, unknown>;
    w.__armIdbAbort = (after: number, name = 'MAIC-mistake-outbox') => {
      abortState.armed = true;
      abortState.after = after;
      abortState.seen = 0;
      abortState.name = name;
    };
    w.__disarmIdbAbort = () => {
      abortState.armed = false;
    };
    // One-shot IndexedDB OPEN hold: defer the success delivery of the NEXT
    // open(name) until released ('ok' | 'abort-first-tx').
    const openHold = {
      armed: false,
      name: '',
      targetOrdinal: 1,
      seenArmed: 0,
      captured: false,
      released: false,
      realRequest: null as IDBOpenDBRequest | null,
      proxy: null as IDBOpenDBRequest | null,
      success: [] as Array<((event: { target: unknown; type: string }) => void) | null>,
      error: [] as Array<((event: { target: unknown; type: string }) => void) | null>,
      listeners: [] as Array<{
        type: string;
        fn: (event: { target: unknown; type: string }) => void;
      }>,
      dbWrapper: null as unknown,
    };
    w.__holdNextIdbOpen = (name: string, nth = 1) => {
      openHold.armed = true;
      openHold.name = String(name);
      openHold.targetOrdinal = nth;
      openHold.seenArmed = 0;
      openHold.captured = false;
      openHold.released = false;
      openHold.realRequest = null;
      openHold.proxy = null;
      openHold.success = [];
      openHold.error = [];
      openHold.listeners = [];
      openHold.dbWrapper = null;
    };
    w.__idbHoldCaptured = () => openHold.captured;
    w.__releaseHeldIdbOpen = (mode: string) => {
      if (!openHold.captured || openHold.released) return 'idle';
      openHold.released = true;
      if (mode === 'abort-first-tx') {
        const realDb = (openHold.realRequest as IDBOpenDBRequest).result as IDBDatabase;
        let abortedOnce = false;
        openHold.dbWrapper = new Proxy(realDb, {
          get(target: IDBDatabase, prop: string | symbol) {
            if (prop === 'transaction') {
              return (...txArgs: unknown[]) => {
                const tx = target.transaction(
                  ...(txArgs as [string | string[], IDBTransactionMode?]),
                );
                if (!abortedOnce) {
                  abortedOnce = true;
                  try {
                    tx.abort();
                  } catch {
                    /* already inactive */
                  }
                }
                return tx;
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target: IDBDatabase, prop: string | symbol, value: unknown) {
            return Reflect.set(target, prop, value);
          },
        });
      }
      const fire = (handler: (event: { target: unknown; type: string }) => void) =>
        handler.call(openHold.proxy, { target: openHold.proxy, type: 'success' });
      for (const entry of openHold.listeners.splice(0)) {
        if (entry.type === 'success') fire(entry.fn);
      }
      for (const handler of openHold.success.splice(0)) {
        if (handler) fire(handler);
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
      return proxy;
    };
    const realIdb = window.indexedDB;
    const realOpen = realIdb.open.bind(realIdb);
    const wrappedOpen = (...args: unknown[]) => {
      const openedName = String(args[0]);
      const request = realOpen(...(args as [string, number?]));
      if (openHold.armed && !openHold.captured && openedName === openHold.name) {
        openHold.seenArmed += 1;
        if (openHold.seenArmed < openHold.targetOrdinal) {
          request.addEventListener('success', () => {
            const db = request.result as IDBDatabase;
            const realTransaction = db.transaction.bind(db);
            (db as unknown as Record<string, unknown>)['transaction'] = (
              stores: string | string[],
              mode?: IDBTransactionMode,
            ) => realTransaction(stores, mode);
          });
          return request;
        }
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
          if (mode === 'readwrite' && openedName === abortState.name) {
            const realObjectStore = tx.objectStore.bind(tx);
            (tx as unknown as Record<string, unknown>)['objectStore'] = (name: string) => {
              const store = realObjectStore(name);
              if (
                (openedName !== 'MAIC-mistake-outbox' || name === 'events') &&
                openedName === abortState.name
              ) {
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
              }
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
}

test.beforeEach(async ({ page }) => {
  await installPageHooks(page);
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

function rightChoice(id: string, question: string): SeedQuestion {
  return {
    id,
    type: 'single',
    question,
    options: [
      { label: 'Right', value: 'A' },
      { label: 'Wrong', value: 'B' },
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
            name: 'P4 quiz deck',
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
            title: 'P4',
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

// ─── Durable-store observers ────────────────────────────────────────────────

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
              entries.push(row);
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

/** The persisted capture plan of the latest review (runtime store). */
async function latestCapturePlan(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
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
}

const idbHoldCaptured = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __idbHoldCaptured: () => boolean }).__idbHoldCaptured(),
  );

test.describe('P4 real recovery matrix + empty-report race', () => {
  test('M1 enqueue aborted before queue commit → refresh recovers frozen event/payload/token/owner EXACTLY once', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p4-m1', [wrongChoice('q-m1', 'M4 one?', 'No', 'Yes')]);
    await page.goto('/classroom/p4-m1');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    expect((await outboxEvents(page)).length).toBe(0);
    expect(state.posts).toHaveLength(0);
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.reload();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    // The frozen identity recovered EXACTLY once: one transport POST with
    // the frozen event id + owner, wrongCount counted once, queue drained.
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    const body = state.posts[0]! as Record<string, unknown>;
    expect(body.expectedOwnerId).toBe('owner-a');
    expect(String(body.eventId)).toContain('q-m1');
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
    expect(await outboxEvents(page)).toHaveLength(0);
    // The durable progress carries the FROZEN plan token and the real owner.
    const plan = await latestCapturePlan(page);
    const token = String(
      (plan as { items?: Array<{ recordToken?: string }> })?.items?.[0]?.recordToken,
    );
    expect(token).toBeTruthy();
    await expect
      .poll(
        async () =>
          (await progressRows(page)).some(
            (row) =>
              row.state === 'confirmed' &&
              String((row.planIdentity as Record<string, unknown>)?.planRecordToken) === token &&
              (row.actual as Record<string, unknown> | undefined)?.owner === 'owner-a',
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    // Settling is stable: no replay POST, and a further refresh of the
    // completed plan produces ZERO POSTs.
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(1);
    await page.reload();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(1); // zero new POST on completed refresh
  });

  test('M2 q1 confirmed + q2 local enqueue fails → refresh retries ONLY q2; completed refresh POSTs nothing', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p4-m2', [
      wrongChoice('q-m2a', 'M2 one?', 'No', 'Yes'),
      wrongChoice('q-m2b', 'M2 two?', 'No', 'Yes'),
    ]);
    await page.goto('/classroom/p4-m2');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // q1's enqueue put succeeds (#1); q2's enqueue put aborts. Both are
    // locally-graded choices, so BOTH items exist on the first pass.
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(1);
    });
    await answerAllWrongAndSubmit(page, 2);
    // q1 uploads and DRAINS (the abort counts only events-store puts, so
    // its receipt+delete commit); q2 honestly failed locally.
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect(String(state.posts[0]!.eventId)).toContain('q-m2a');
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    // Refresh: ONLY q2 retries — q1 creates no new POST and no new record.
    await page.reload();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(2);
    expect(String(state.posts[1]!.eventId)).toContain('q-m2b');
    expect(state.posts[1]!.expectedOwnerId).toBe('owner-a');
    for (const row of state.recordsByOwner['owner-a'] ?? []) expect(row.wrongCount).toBe(1);
    expect(await outboxEvents(page)).toHaveLength(0);
    // The whole plan is complete now: another refresh produces ZERO POSTs.
    await page.waitForTimeout(1_000);
    await page.reload();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(2); // nothing new
  });

  test('M4 frozen known-A EMPTY plan → refresh under cookie B → new wrong q2 stays frozen A, parked, zero B', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p4-m4', [
      rightChoice('q-m4a', 'M4 right one?'),
      shortAnswer('q-m4b', 'M4 two? Explain.'),
    ]);
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({ status: 502, body: 'unavailable' });
    });
    await page.goto('/classroom/p4-m4');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    await page.getByRole('button', { name: /Right/i }).first().click();
    await page.getByRole('textbox').first().fill('ans');
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('Quiz Report')).toBeVisible({ timeout: 15_000 });
    // The modern plan committed with ZERO items and FROZEN owner A.
    const plan = await latestCapturePlan(page);
    expect((plan as { originOwner?: string })?.originOwner).toBe('owner-a');
    expect(((plan as { items?: unknown[] })?.items ?? []).length).toBe(0);
    await page.waitForTimeout(1_000);
    expect(state.posts).toHaveLength(0); // nothing to capture yet

    // Refresh under cookie B; the regrade decides q2 wrong: it enqueues
    // under the FROZEN A and parks under B — never a B record or POST.
    state.echoOwner = 'owner-b';
    await page.reload();
    await expect(page.getByText('ungraded')).toBeVisible({ timeout: 15_000 }); // usable review
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
        async () => (await outboxEvents(page)).some((row) => String(row.eventId).includes('q-m4b')),
        { timeout: 20_000 },
      )
      .toBe(true);
    await page.waitForTimeout(1_500);
    expect((await outboxEvents(page)).filter((row) => row.owner === 'owner-b')).toHaveLength(0);
    expect((await outboxEvents(page)).every((row) => row.owner === 'owner-a')).toBe(true);
    expect(state.posts).toHaveLength(0); // parked under B: zero POSTs
    expect(state.recordsByOwner['owner-b']).toBeUndefined();
  });

  test('M5 real progress-write aborts stay honestly retryable; the durable receipt later confirms with NO new POST', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p4-m5', [wrongChoice('q-m5', 'M5 one?', 'No', 'Yes')]);
    await page.goto('/classroom/p4-m5');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // EVERY progress-database write really aborts: notes and confirms stay
    // recoverable; the queue itself is untouched.
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number, db: string) => void }).__armIdbAbort(
        0,
        'MAIC-capture-progress',
      );
    });
    await answerAllWrongAndSubmit(page, 1);
    // The record is durable and REALLY uploaded (queue drains) — but the
    // ledger must NOT claim uploaded while the durable confirm cannot land.
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await outboxEvents(page)).length, { timeout: 15_000 }).toBe(0);
    await page.waitForTimeout(1_500);
    expect((await progressRows(page)).every((row) => row.state === 'pending')).toBe(true);
    expect(page.getByText(pillText.uploaded)).toHaveCount(0); // honest: not confirmed

    // Repair: progress writes work again; an online flush replays the
    // durable receipt and confirms WITHOUT a new transport POST.
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await progressRows(page)).some((row) => row.state === 'confirmed'), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(state.posts).toHaveLength(1); // still exactly one transport POST
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
  });

  test('M6 LEGACY no-plan review → modern upgrade keeps the immutable legacy exemption (q1 never re-captured)', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p4-m6', [
      wrongChoice('q-m6a', 'M6 one?', 'No', 'Yes'),
      shortAnswer('q-m6b', 'M6 two? Explain.'),
    ]);
    await page.goto('/classroom/p4-m6');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // Nothing may enqueue while the modern first pass creates the attempt.
    await page.evaluate(() => {
      (window as unknown as { __armIdbAbort: (n: number) => void }).__armIdbAbort(0);
    });
    await page.getByRole('button', { name: /No/i }).first().click();
    await page.getByRole('textbox').first().fill('ans');
    await page.getByRole('button', { name: 'Submit Answers' }).click();
    await expect(page.getByText('Quiz Report')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(pillText.localFailed)).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      (window as unknown as { __disarmIdbAbort: () => void }).__disarmIdbAbort();
    });
    // Convert the just-created attempt into a REAL LEGACY history in place:
    // same session id + the page's real learnerKey, completed review WITHOUT
    // any capturePlan — q1 decided wrong (historical), q2 still undecided.
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('maic-runtime');
        open.onsuccess = () => {
          const db = open.result;
          const sessions = db.transaction('sessions', 'readonly').objectStore('sessions');
          const getAll = sessions.getAll();
          getAll.onsuccess = () => {
            const rows = (getAll.result ?? []) as Array<{
              id: string;
              kind: string;
              learnerKey: string;
              stageId: string;
              status: string;
              createdAt: string;
              updatedAt: string;
              runtimeDslVersion?: unknown;
            }>;
            const target = rows.find(
              (row) => row.kind === 'quizAttempt' && row.stageId === 'p4-m6',
            );
            if (!target) {
              db.close();
              reject(new Error('attempt session not found'));
              return;
            }
            const legacy = {
              ...target,
              status: 'completed',
            };
            const tx = db.transaction(['sessions', 'records'], 'readwrite');
            const now = new Date().toISOString();
            tx.objectStore('sessions').put(legacy);
            const records = tx.objectStore('records');
            const clear = records.delete(IDBKeyRange.bound([target.id], [`${target.id}\uffff`]));
            void clear;
            records.put({
              sessionId: target.id,
              seq: 0,
              id: 'legacy-review-p4m6',
              sceneId: 'scene-quiz',
              createdAt: now,
              payload: {
                payloadVersion: 1,
                phase: 'reviewed',
                answers: { 'q-m6a': 'B', 'q-m6b': 'ans' },
                results: [
                  { questionId: 'q-m6a', correct: false, status: 'incorrect', earned: 0 },
                  { questionId: 'q-m6b', correct: null, status: 'ungraded', earned: 0 },
                ],
              },
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          getAll.onerror = () => reject(getAll.error);
        };
        open.onerror = () => reject(open.error);
      });
    });
    // Hydrate the legacy review: its wrong q1 stays historically captured
    // (zero-re-capture), and the undecided q2 keeps Retry grading usable.
    await page.goto('/classroom/p4-m6');
    await expect(page.getByText('ungraded')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect((await outboxEvents(page)).length).toBe(0); // legacy: nothing enqueued
    expect(state.posts).toHaveLength(0);

    // The modern upgrade: regrade decides q2 wrong. The plan freezes the
    // legacy exemption [q1] and captures ONLY q2.
    await page.route('**/api/quiz-grade', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 0, comment: 'No.' }),
      });
    });
    await page.getByRole('button', { name: 'Retry grading' }).click();
    await expect.poll(async () => state.posts.length, { timeout: 20_000 }).toBe(1);
    expect(String(state.posts[0]!.eventId)).toContain('q-m6b'); // q2 ONLY
    const plan = await latestCapturePlan(page);
    expect((plan as { legacyExemptQuestions?: string[] })?.legacyExemptQuestions).toEqual([
      'q-m6a',
    ]);
    // A refresh of the upgraded plan recaptures NOTHING historical.
    await page.reload();
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(1); // q1 was never re-captured
    expect(state.recordsByOwner['owner-a']).toHaveLength(1);
    expect(state.recordsByOwner['owner-a']![0]!.questionId).toBe('q-m6b');
    for (const row of state.recordsByOwner['owner-a'] ?? []) expect(row.wrongCount).toBe(1);
  });

  test('M7 pre-identity SAVING boundary: q1.s enqueue open held → the pill claims NOTHING (no durable identity yet)', async ({
    page,
  }) => {
    const state = await mockMistakes(page, []);
    await seedClassroom(page, 'p4-m7', [wrongChoice('q-sv1', 'Saving one?', 'No', 'Yes')]);
    await page.goto('/classroom/p4-m7');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // After arming: outbox open #1 is the precheck EVIDENCE read; open #2 is
    // the ENQUEUE itself — held BEFORE its transaction commits, so q1 has a
    // registered 'saving' target but NO durable own identity yet.
    await page.evaluate(() => {
      (
        window as unknown as { __holdNextIdbOpen: (n: string, nth?: number) => void }
      ).__holdNextIdbOpen('MAIC-mistake-outbox', 2);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect.poll(() => idbHoldCaptured(page)).toBe(true);
    await page.waitForTimeout(1_500); // the operation has fully settled into saving
    // GENUINE pre-identity boundary: the whole-set pill claims NOTHING at
    // all (neither uploaded nor "saved offline" — no durable evidence for
    // the undecided target exists yet).
    await expect(page.getByText(pillText.uploaded)).toHaveCount(0);
    await expect(page.getByText(pillText.queued)).toHaveCount(0);
    expect((await outboxEvents(page)).length).toBe(0); // nothing durable yet
    // Release: the enqueue commits, the plan completes normally.
    await page.evaluate(() => {
      (window as unknown as { __releaseHeldIdbOpen: (m: string) => string }).__releaseHeldIdbOpen(
        'ok',
      );
    });
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
  });

  test('RACE-BOUND classroom unknown-source: bind commits → readAll held → second page uploads/deletes → empty report + OWN committedBinds → real consumer migrates progress/authority via the mapping and receipt', async ({
    context,
    page,
  }) => {
    // The P4-required BOUND-source form of the classroom race (the direct
    // known-A receipt race is retained separately above): an UNKNOWN-origin
    // live-episode plan enqueues its record UNBOUND; its own flush PROBES A,
    // commits the unbound→A BIND (journal + move + mapping) and then parks
    // at its readAll; a second real page in the SAME context uploads and
    // deletes the bound destination; the released original returns
    // uploaded=[] WITH its committed mapping, and the real classroom
    // consumer migrates progress through the full mapping and settles via
    // the exact receipt — authority ends at A.
    const state = await mockMistakesOnContext(context, []);
    state.echoOwner = ''; // unknown origin at freeze time
    await seedClassroom(page, 'p4-race-bound', [wrongChoice('q-rb1', 'Bound one?', 'No', 'Yes')]);
    await page.goto('/classroom/p4-race-bound');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // Identity A appears before Submit (the flush probe must confirm A for
    // the live-episode bind); the PLAN still froze originOwner=''.
    state.echoOwner = 'owner-a';
    // After arming, the UNKNOWN flow's outbox opens: #1 precheck evidence,
    // #2-#3 resolveAttemptOwner's binding-journal reads, #4 the enqueue,
    // #5 the flush's BIND transaction, #6 the flush's readAll — hold #6
    // (parked AFTER the bind committed, BEFORE the read).
    await page.evaluate(() => {
      (
        window as unknown as { __holdNextIdbOpen: (n: string, nth?: number) => void }
      ).__holdNextIdbOpen('MAIC-mistake-outbox', 6);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect.poll(() => idbHoldCaptured(page)).toBe(true); // readAll parked

    // The committed preconditions (P3 test 6's boundary, raw): unknown
    // frozen header + the committed unknown→A binding journal — while the
    // progress/authority migration has NOT committed (the flush is parked).
    const planFrozen = await latestCapturePlan(page);
    expect((planFrozen as { originOwner?: string })?.originOwner).toBe('');
    const bindingsAtBarrier = await bindingRows(page);
    expect(bindingsAtBarrier.length).toBeGreaterThanOrEqual(1);
    expect(bindingsAtBarrier[0]!.reason).toBe('active-bind');
    expect((await progressRows(page)).every((row) => row.state !== 'confirmed')).toBe(true); // progress migration not yet committed
    const authorityAtBarrier = await authorityRows(page);
    expect(authorityAtBarrier).toHaveLength(0); // authority not yet committed

    // Second real page (same context, shared IndexedDB) uploads + deletes.
    const page2 = await context.newPage();
    await installPageHooks(page2);
    await page2.goto('/', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => (await outboxEvents(page)).length, { timeout: 20_000 }).toBe(0);
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);

    // Release: the original returns the EMPTY report and its OWN mapping;
    // the real consumer settles once via the exact receipt.
    await page.evaluate(() => {
      (window as unknown as { __releaseHeldIdbOpen: (m: string) => string }).__releaseHeldIdbOpen(
        'ok',
      );
    });
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        async () =>
          (await progressRows(page)).some(
            (row) =>
              row.state === 'confirmed' &&
              (row.actual as Record<string, unknown> | undefined)?.owner === 'owner-a',
          ),
        { timeout: 15_000 },
      )
      .toBe(true); // migrated through the committed mapping
    await expect
      .poll(
        async () => (await authorityRows(page)).some((row) => row.effectiveOwner === 'owner-a'),
        { timeout: 15_000 },
      )
      .toBe(true); // full progress/authority migration committed
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(1); // exactly one transport POST overall
    expect((await outboxEvents(page)).length).toBe(0);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
    await page2.close();
  });

  test('RACE classroom empty-report: page1 read held → second page (same context) uploads+deletes → page1 settles once via the exact receipt', async ({
    context,
    page,
  }) => {
    // The mock must intercept BOTH pages: a page-level route never sees the
    // second page's requests. Register the same handler on the context.
    const state = await mockMistakesOnContext(context, []);
    await seedClassroom(page, 'p4-race', [wrongChoice('q-race', 'Race one?', 'No', 'Yes')]);
    await page.goto('/classroom/p4-race');
    await page.getByRole('button', { name: 'Start Quiz' }).click();
    // Hold the THIRD outbox open after arming: #1 is the executor's
    // precheck EVIDENCE read, #2 is its ENQUEUE, #3 is its flush's readAll
    // (no bind step — the record enqueues bound under known owner A).
    await page.evaluate(() => {
      (
        window as unknown as { __holdNextIdbOpen: (n: string, nth?: number) => void }
      ).__holdNextIdbOpen('MAIC-mistake-outbox', 3);
    });
    await answerAllWrongAndSubmit(page, 1);
    await expect.poll(() => idbHoldCaptured(page)).toBe(true); // readAll parked

    // A SECOND PAGE in the SAME browser context (shared IndexedDB): the
    // home page's mount flush uploads and deletes the exact record.
    const page2 = await context.newPage();
    await installPageHooks(page2);
    await page2.goto('/', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => (await outboxEvents(page)).length, { timeout: 20_000 }).toBe(0); // uploaded + deleted by the background consumer
    await expect.poll(async () => state.posts.length, { timeout: 15_000 }).toBe(1);

    // Release the original read: it returns the EMPTY report (uploaded=[])
    // and its classroom consumer settles the ledger ONCE through the exact
    // durable receipt — no second POST, no re-enqueue.
    await page.evaluate(() => {
      (window as unknown as { __releaseHeldIdbOpen: (m: string) => string }).__releaseHeldIdbOpen(
        'ok',
      );
    });
    await expect(page.getByText(pillText.uploaded)).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        async () =>
          (await progressRows(page)).some(
            (row) =>
              row.state === 'confirmed' &&
              String((row.planIdentity as Record<string, unknown>)?.questionId) === 'q-race',
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.waitForTimeout(1_500);
    expect(state.posts).toHaveLength(1); // exactly one transport POST overall
    expect((await outboxEvents(page)).length).toBe(0);
    expect(state.recordsByOwner['owner-a']![0]!.wrongCount).toBe(1);
    await page2.close();
  });
});
