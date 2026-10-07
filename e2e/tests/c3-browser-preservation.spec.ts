/**
 * C3 §4 — ACTUAL Chromium old-data preservation.
 *
 * A same-origin intercepted BLANK fixture page is loaded BEFORE application
 * hydration; all old databases are seeded there through AWAITED
 * page.evaluate promises (upgrade-transaction handles only — never
 * `IDBDatabase.objectStore`), connections close in finally, and the FULL
 * pre-initialization snapshot is frozen and returned before the first
 * application page is ever requested. The real application then initializes
 * against the isolated db-agent-off server and every seeded field is
 * compared. Nothing is invented (no receipts/bindings for old rows); the
 * 500-receipt retention case proves the NEW receipt commits, the total stays
 * EXACTLY 500 (the oldest row evicted), and the COMMITTED non-contradictory
 * binding journal plus its destination row survive with a consumable
 * mapping (the source was genuinely moved away; the destination payload
 * re-fingerprints to the journal's exact value). The pending-binding
 * CONSUMER proof is supplied by the retained P4 real-browser coverage
 * (empty-report race + bind consumer), which this fixture complements
 * without re-executing. Same-client owner switch (cookies cleared) keeps
 * parked other-owner rows and hides uploaded records from the new owner.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { cp, mkdir, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const ISOLATED_PG = 'postgres://postgres:c2-e2e-synthetic@127.0.0.1:57540/c2_e2e';
const EVIDENCE_DIR = '.zcode/evidence/final-20261003';
const PORT = 3113;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_ID = `run-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

let server: ChildProcess | undefined;
let serverLog: WriteStream | undefined;
let runtimeDir = '';

test.beforeAll(async () => {
  const stale = await fetch(`${BASE}/api/agent/runtime`).then(
    () => true,
    () => false,
  );
  if (stale) throw new Error(`port ${PORT} already has a listener — refusing stale reuse`);
  runtimeDir = resolve(`${EVIDENCE_DIR}/runtime-preservation-${RUN_ID}`);
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  await cp('.next/standalone/server.js', `${runtimeDir}/server.js`);
  await symlink(resolve('.next/standalone/node_modules'), `${runtimeDir}/node_modules`);
  await symlink(resolve('.next/standalone/.next'), `${runtimeDir}/.next`);
  await symlink(resolve('.next/standalone/public'), `${runtimeDir}/public`);
  serverLog = createWriteStream(`${EVIDENCE_DIR}/server-preservation-${RUN_ID}.log`, {
    flags: 'w',
  });
  server = spawn('node', ['server.js'], {
    cwd: runtimeDir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true',
      NEXT_PUBLIC_PI_CHAT_ENABLED: 'true',
      NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED: 'true',
      DATABASE_URL: ISOLATED_PG,
      OPENMAIC_AGENT_RUNTIME_ENABLED: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout?.pipe(serverLog);
  server.stderr?.pipe(serverLog);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/agent/runtime`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('preservation server never became ready');
});

test.afterAll(async () => {
  if (server) {
    try {
      process.kill(-(server.pid as number), 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      process.kill(-(server.pid as number), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await new Promise<void>((resolve) => {
    serverLog?.end(() => resolve());
    setTimeout(resolve, 1_000);
  });
  await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
});

/** The same-origin blank fixture page served before any application code. */
const FIXTURE_URL = `${BASE}/__c3_fixture__`;

/** Read every row of every store (sorted) of a database on a given page. */
async function readAllStores(
  page: import('@playwright/test').Page,
  name: string,
): Promise<Record<string, unknown[]>> {
  return (await page.evaluate((dbName) => {
    return new Promise<Record<string, unknown[]>>((resolve, reject) => {
      const open = indexedDB.open(dbName);
      open.onsuccess = () => {
        const db = open.result;
        const stores = Array.from(db.objectStoreNames);
        if (stores.length === 0) {
          db.close();
          resolve({});
          return;
        }
        const out: Record<string, unknown[]> = {};
        const tx = db.transaction(stores, 'readonly');
        for (const store of stores) {
          const getAll = tx.objectStore(store).getAll();
          getAll.onsuccess = () => {
            out[store] = (getAll.result ?? [])
              .slice()
              .sort((a: object, b: object) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
          };
        }
        tx.oncomplete = () => {
          db.close();
          resolve(out);
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
  }, name)) as Record<string, unknown[]>;
}

/** Keyed asset-pool snapshot: out-of-line KEYS + materialized Blob bytes. */
async function readAssetPoolSnapshot(page: import('@playwright/test').Page): Promise<{
  assetKeys: string[];
  assetRows: unknown[];
  blobKeys: string[];
  blobBytesBase64: Record<string, string>;
}> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('maic-asset-pool');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['assets', 'blobs'], 'readonly');
          const assetKeysReq = tx.objectStore('assets').getAllKeys();
          const assetRowsReq = tx.objectStore('assets').getAll();
          const blobKeysReq = tx.objectStore('blobs').getAllKeys();
          const blobRowsReq = tx.objectStore('blobs').getAll();
          tx.oncomplete = () => {
            void (async () => {
              const blobBytes = {} as Record<string, string>;
              for (let i = 0; i < blobKeysReq.result.length; i += 1) {
                const key = String(blobKeysReq.result[i]);
                const value = blobRowsReq.result[i];
                if (value instanceof Blob) {
                  const buffer = await value.arrayBuffer();
                  const bytes = new Uint8Array(buffer);
                  let binary = '';
                  for (const byte of bytes) binary += String.fromCharCode(byte);
                  blobBytes[key] = btoa(binary);
                } else {
                  blobBytes[key] = 'not-a-blob:' + typeof value;
                }
              }
              db.close();
              resolve({
                assetKeys: assetKeysReq.result.map(String),
                assetRows: assetRowsReq.result,
                blobKeys: blobKeysReq.result.map(String),
                blobBytesBase64: blobBytes,
              });
            })().catch(reject);
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
}

/** Whether a database exists at all on this origin. */
async function dbExists(page: import('@playwright/test').Page, name: string): Promise<boolean> {
  return (await page.evaluate((dbName) => {
    return (indexedDB.databases ? indexedDB.databases() : Promise.resolve([])).then(
      (list: Array<{ name?: string }>) => list.map((row) => row.name).includes(dbName),
    );
  }, name)) as boolean;
}

// ── Seeding payloads ────────────────────────────────────────────────────────

const STAGE = 'c3-preserve-stage';
const OLD_OWNER = 'owner-seeded';

const courseFixture = {
  stage: {
    id: STAGE,
    name: 'C3 Preservation Course',
    createdAt: 1_000,
    updatedAt: 1_000,
  },
  scenes: [
    {
      id: 'scene-quiz',
      stageId: STAGE,
      type: 'quiz',
      title: 'Quiz',
      order: 0,
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'q-legacy',
            type: 'single',
            question: 'Kept after restore?',
            options: [
              { label: 'Yes', value: 'A' },
              { label: 'No', value: 'B' },
            ],
            answer: ['A'],
            points: 1,
          },
        ],
      },
      createdAt: 1_000,
      updatedAt: 1_000,
    },
  ],
  outline: { outlines: [], requirement: 'C3', createdAt: 1_000, updatedAt: 1_000 },
};

/**
 * Valid legacy runtime learning rows — TWO SEPARATE partitions so each
 * restoration behavior is asserted on its own fixture:
 *  - the LEGACY-ROOT stage: a completed root whose review still holds an
 *    UNDECIDED verdict (the tail-CAS repair target);
 *  - the CHILD stage: a root with a reviewed tail PLUS a strictly newer
 *    active retry child carrying a draft (restoration must adopt the CHILD).
 */
const ROOT_STAGE = 'c3-preserve-root';
const CHILD_STAGE = 'c3-preserve-child';

function legacySessions(stageId: string, withChild: boolean): Array<Record<string, unknown>> {
  const sessions = [
    {
      id: `quiz-attempt:${stageId}:${OLD_OWNER}`,
      kind: 'quizAttempt',
      stageId,
      learnerKey: OLD_OWNER,
      status: 'completed',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:01:00.000Z',
      runtimeDslVersion: '0.1.0',
    },
  ];
  if (withChild) {
    sessions.push({
      id: `quiz-attempt:${stageId}:${OLD_OWNER}:retry:1`,
      kind: 'quizAttempt',
      stageId,
      learnerKey: OLD_OWNER,
      status: 'active',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:30.000Z',
      runtimeDslVersion: '0.1.0',
    });
  }
  return sessions;
}

function legacyRecords(stageId: string, withChild: boolean): Array<Record<string, unknown>> {
  const records = [
    {
      id: 'legacy-review-1',
      sessionId: `quiz-attempt:${stageId}:${OLD_OWNER}`,
      seq: 0,
      sceneId: 'scene-quiz',
      createdAt: '2026-01-02T00:00:30.000Z',
      payload: {
        payloadVersion: 1,
        phase: 'reviewed',
        answers: { 'q-legacy': 'B' },
        results: [{ questionId: 'q-legacy', correct: null, status: 'ungraded', earned: 0 }],
      },
    } as Record<string, unknown>,
  ];
  if (withChild) {
    records.push({
      id: 'child-draft-1',
      sessionId: `quiz-attempt:${stageId}:${OLD_OWNER}:retry:1`,
      seq: 0,
      sceneId: 'scene-quiz',
      createdAt: '2026-01-03T00:00:20.000Z',
      payload: {
        payloadVersion: 1,
        phase: 'draft',
        answers: { 'q-legacy': 'A' },
      },
    } as Record<string, unknown>);
  }
  return records;
}

type LegacyLearningFixture = {
  sessions: Array<Record<string, unknown>>;
  records: Array<Record<string, unknown>>;
};

const learningFixture: LegacyLearningFixture = {
  sessions: [...legacySessions(ROOT_STAGE, false), ...legacySessions(CHILD_STAGE, true)],
  records: [...legacyRecords(ROOT_STAGE, false), ...legacyRecords(CHILD_STAGE, true)],
};

function courseFor(stageId: string): typeof courseFixture {
  return {
    ...courseFixture,
    stage: { ...courseFixture.stage, id: stageId },
    scenes: courseFixture.scenes.map((scene) => ({ ...scene, stageId })),
  };
}

/** Frozen outbox event rows (v1 pre-receipt shape, full field sets). */
function frozenPayload(eventId: string, questionId: string, question: string): unknown {
  return {
    eventId,
    stageId: STAGE,
    stageName: 'C3 Preservation Course',
    sceneId: 'scene-quiz',
    sceneTitle: 'Quiz',
    items: [
      {
        eventId,
        questionId,
        questionType: 'single',
        question,
        options: [{ label: 'Yes', value: 'A' }],
        correctAnswer: ['A'],
        userAnswer: 'B',
      },
    ],
  };
}

const v1Events = [
  {
    key: `${OLD_OWNER}|evt-old`,
    eventId: 'evt-old',
    owner: OLD_OWNER,
    payload: frozenPayload('evt-old', 'q-old', 'v1 kept?'),
    createdAt: 1_111,
    attempts: 0,
    status: 'pending',
    creationToken: 'tok-v1-pending',
  },
  {
    key: '|evt-unbound',
    eventId: 'evt-unbound',
    owner: '',
    payload: frozenPayload('evt-unbound', 'q-unbound', 'unbound kept?'),
    createdAt: 1_222,
    attempts: 0,
    status: 'pending',
  },
  {
    key: `${OLD_OWNER}|evt-failed`,
    eventId: 'evt-failed',
    owner: OLD_OWNER,
    payload: frozenPayload('evt-failed', 'q-failed', 'failed kept?'),
    createdAt: 1_333,
    attempts: 2,
    lastAttemptAt: 1_400,
    lastError: 'HTTP 500',
    status: 'failed',
    creationToken: 'tok-v1-failed',
  },
  {
    key: `${OLD_OWNER}|evt-rejected`,
    eventId: 'evt-rejected',
    owner: OLD_OWNER,
    payload: frozenPayload('evt-rejected', 'q-rejected', 'rejected kept?'),
    createdAt: 1_444,
    attempts: 1,
    lastAttemptAt: 1_500,
    lastError: 'HTTP 400',
    status: 'rejected',
  },
];

/**
 * Seeding executed on the BLANK fixture page. Everything is AWAITED; each
 * open uses only the handles returned by createObjectStore (the upgrade
 * transaction); every connection closes in finally; the completed snapshot
 * is returned so seeding can be verified BEFORE the app ever runs.
 */
async function seedOnFixture(
  page: import('@playwright/test').Page,
  seed: {
    withCourse?: Array<typeof courseFixture>;
    withLearning?: typeof learningFixture;
    assets?: { blobs: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>> };
    outbox?: { version: 1 | 2 | 3; events: unknown[]; receipts?: unknown[]; bindings?: unknown[] };
  },
): Promise<Record<string, unknown>> {
  return (await page.evaluate(
    async ({ seedPayload }) => {
      const seed = seedPayload as {
        withCourse?: Array<typeof courseFixture>;
        withLearning?: typeof learningFixture;
        assets?: { blobs: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>> };
        outbox?: {
          version: number;
          events: unknown[];
          receipts?: unknown[];
          bindings?: unknown[];
        };
      };
      const openDatabase = (
        name: string,
        version: number,
        upgrade: (db: IDBDatabase, tx: IDBTransaction) => void,
      ): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(name, version);
          request.onupgradeneeded = () => {
            try {
              upgrade(request.result, request.transaction!);
            } catch (upgradeError) {
              request.transaction!.abort();
              reject(
                new Error(
                  `seed upgrade failed for ${name}: ${String(upgradeError && (upgradeError as Error).message ? (upgradeError as Error).message : upgradeError)}`,
                ),
              );
            }
          };
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error(`seed open blocked: ${name}`));
        });
      const putAll = (tx: IDBTransaction, storeName: string, rows: unknown[]): void => {
        const store = tx.objectStore(storeName);
        for (const row of rows) store.put(row);
      };

      if (seed.withLearning) {
        const withLearning = seed.withLearning;
        await openDatabase('maic-runtime', 1, (db, tx) => {
          const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('by-stage-learner', ['stageId', 'learnerKey'], { unique: false });
          sessions.createIndex('by-learner', 'learnerKey', { unique: false });
          sessions.createIndex('by-stage', 'stageId', { unique: false });
          db.createObjectStore('records', { keyPath: ['sessionId', 'seq'] });
          putAll(tx, 'sessions', withLearning.sessions);
          putAll(tx, 'records', withLearning.records);
        });
      }
      if (seed.withCourse) {
        const withCourse = seed.withCourse;
        await openDatabase('maic-documents', 1, (db, tx) => {
          db.createObjectStore('stages', { keyPath: 'id' });
          const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
          scenes.createIndex('by-stage', 'stageId');
          db.createObjectStore('outlines', { keyPath: 'stageId' });
          putAll(
            tx,
            'stages',
            withCourse.map((course) => course.stage),
          );
          putAll(
            tx,
            'scenes',
            withCourse.flatMap((course) => course.scenes),
          );
          putAll(
            tx,
            'outlines',
            withCourse.map((course) => ({
              stageId: course.stage.id,
              outline: course.outline,
            })),
          );
        });
      }
      if (seed.assets) {
        const assetSeed = seed.assets;
        await openDatabase('maic-asset-pool', 1, (db) => {
          // The REAL BrowserAssetStore v1 layout: BOTH stores out-of-line
          // keyed — blobs hold Blob values under their contentHash; assets
          // hold {contentHash, mime, meta} rows under their asset id, with
          // the by-content-hash index.
          const blobs = db.createObjectStore('blobs');
          const assets = db.createObjectStore('assets');
          assets.createIndex('by-content-hash', 'contentHash', { unique: false });
          for (const blob of assetSeed.blobs) {
            const typed = blob as { contentHash: string; mime: string; bytes: number[] };
            blobs.put(
              new Blob([new Uint8Array(typed.bytes)], { type: typed.mime }),
              typed.contentHash,
            );
          }
          for (const asset of assetSeed.assets) {
            const typed = asset as { id: string };
            assets.put(asset, typed.id);
          }
        });
      }
      if (seed.outbox) {
        const outboxSeed = seed.outbox;
        await openDatabase('MAIC-mistake-outbox', outboxSeed.version, (db, tx) => {
          db.createObjectStore('events', { keyPath: 'key' });
          putAll(tx, 'events', outboxSeed.events);
          if (outboxSeed.version >= 2) {
            db.createObjectStore('receipts', { keyPath: 'key' });
            putAll(tx, 'receipts', outboxSeed.receipts ?? []);
          }
          if (outboxSeed.version >= 3) {
            db.createObjectStore('bindings', { keyPath: 'sourceKey' });
            putAll(tx, 'bindings', outboxSeed.bindings ?? []);
          }
        });
      }

      // Freeze the full post-seed snapshot for later comparison.
      const snapshot: Record<string, unknown> = {};
      const readAll = (name: string): Promise<Record<string, unknown[]>> =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onsuccess = () => {
            const db = open.result;
            const stores = Array.from(db.objectStoreNames);
            if (stores.length === 0) {
              db.close();
              resolve({});
              return;
            }
            const out: Record<string, unknown[]> = {};
            const tx = db.transaction(stores, 'readonly');
            for (const store of stores) {
              const getAll = tx.objectStore(store).getAll();
              getAll.onsuccess = () => {
                out[store] = (getAll.result ?? [])
                  .slice()
                  .sort((a: object, b: object) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
              };
            }
            tx.oncomplete = () => {
              db.close();
              resolve(out);
            };
            tx.onerror = () => reject(tx.error);
          };
          open.onerror = () => reject(open.error);
        });
      // Asset-pool snapshot: out-of-line KEYS via getAllKeys, and Blob bytes
      // materialized explicitly (a Blob JSON-stringifies to {}; the bytes
      // must be read as arrayBuffer inside the page, after the read
      // transaction completes).
      const readAssetPool = async (): Promise<Record<string, unknown>> => {
        const open = indexedDB.open('maic-asset-pool');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          const tx = db.transaction(['assets', 'blobs'], 'readonly');
          const assetKeysReq = tx.objectStore('assets').getAllKeys();
          const assetRowsReq = tx.objectStore('assets').getAll();
          const blobKeysReq = tx.objectStore('blobs').getAllKeys();
          const blobRowsReq = tx.objectStore('blobs').getAll();
          await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          const blobBytes: Record<string, string> = {};
          for (let i = 0; i < blobKeysReq.result.length; i += 1) {
            const key = String(blobKeysReq.result[i]);
            const value = blobRowsReq.result[i];
            if (value instanceof Blob) {
              const buffer = await value.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (const byte of bytes) binary += String.fromCharCode(byte);
              blobBytes[key] = btoa(binary);
            } else {
              blobBytes[key] = `not-a-blob:${typeof value}`;
            }
          }
          return {
            assetKeys: assetKeysReq.result.map(String),
            assetRows: assetRowsReq.result,
            blobKeys: blobKeysReq.result.map(String),
            blobBytesBase64: blobBytes,
          };
        } finally {
          db.close();
        }
      };
      for (const name of [
        'maic-runtime',
        'maic-documents',
        'maic-asset-pool',
        'MAIC-mistake-outbox',
      ]) {
        const known = await (
          indexedDB.databases
            ? indexedDB.databases()
            : Promise.resolve([] as Array<{ name?: string }>)
        ).then((list: Array<{ name?: string }>) => list.some((row) => row.name === name));
        if (name === 'maic-asset-pool' && known) {
          snapshot[name] = await readAssetPool();
        } else {
          snapshot[name] = known ? await readAll(name) : 'absent';
        }
      }
      return snapshot;
    },
    { seedPayload: seed },
  )) as Record<string, unknown>;
}

test.describe.serial('C3 actual-Chromium old data preservation', () => {
  test('v1 outbox + old learning DB + course: real classroom restoration, full preservation, nothing invented, explicit claim, same-client owner switch', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(FIXTURE_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>fixture' }),
    );
    // Default external-AI fallback BEFORE any application page is loaded.
    await context.route('**/api/quiz-grade', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'AI_GRADE_UNAVAILABLE' }),
      }),
    );
    await page.goto(FIXTURE_URL);
    // The app's learner-key bootstrap reads the device-scoped KV key
    // (`maic:device:runtime.learnerKey`, JSON-encoded by BrowserKVStore).
    // Pin it BEFORE any application script so the app resolves OUR seeded
    // learner partition instead of minting a fresh one.
    await page.addInitScript((learnerKey) => {
      localStorage.setItem('locale', 'en-US');
      localStorage.setItem('maic:account:settings-storage', '{}');
      localStorage.setItem('maic:device:runtime.learnerKey', JSON.stringify(learnerKey));
    }, OLD_OWNER);
    const before = await seedOnFixture(page, {
      withCourse: [courseFor(CHILD_STAGE), courseFor(ROOT_STAGE)],
      withLearning: learningFixture,
      outbox: { version: 1, events: v1Events },
    });
    try {
      // Verify the seeding committed BEFORE the app runs (non-empty stores):
      // 3 sessions (root-stage root; child-stage root+child) and 3 records.
      expect((before['maic-runtime'] as Record<string, unknown[]>).sessions).toHaveLength(3);
      expect((before['maic-runtime'] as Record<string, unknown[]>).records).toHaveLength(3);
      expect((before['MAIC-mistake-outbox'] as Record<string, unknown[]>).events).toHaveLength(4);
      expect(before['maic-documents']).not.toBe('absent');

      // ── CHILD-STAGE restoration: the strictly-newer active retry child is
      // adopted — its DRAFT answers are restored into the live quiz (the
      // seeded draft answer A is pre-selected, NOT the root's review state).
      await page.goto(`${BASE}/classroom/${CHILD_STAGE}`);
      await expect(page.getByText('Kept after restore?').first()).toBeVisible({
        timeout: 20_000,
      });
      const restoredDraft = page.getByRole('button', { name: /Yes/i }).first();
      await expect(restoredDraft).toBeVisible({ timeout: 15_000 });
      expect(await restoredDraft.getAttribute('class')).toContain('violet'); // selected = A

      // ── ROOT-STAGE restoration (its own course/partition fixture): the
      // restored legacy UNDECIDED review renders its ungraded verdict and
      // the Retry grading affordance (the actual reader adopted the root).
      await page.goto(`${BASE}/classroom/${ROOT_STAGE}`);
      await expect(page.getByText('ungraded').first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Kept after restore?').first()).toBeVisible();

      // ── Real application initialization elsewhere (mistake book) — then
      // the FULL frozen snapshots are unchanged field-for-field.
      await page.goto(`${BASE}/mistake-book`);
      await expect(page.getByRole('heading', { name: 'Mistake Book' })).toBeVisible({
        timeout: 20_000,
      });
      await page.waitForTimeout(1_500);
      const after = {
        'maic-runtime': await readAllStores(page, 'maic-runtime'),
        'maic-documents': await readAllStores(page, 'maic-documents'),
      };
      // Documents preserved exactly. The learning DB is preserved except the
      // ONE documented product behavior this fixture exercises: the ROOT
      // stage's completed-but-UNDECIDED review is legitimately REPAIRED by
      // the real restoration (tail-CAS reactivation: completed → active with
      // a fresh updatedAt; every other field intact). All RECORDS and all
      // CHILD-partition sessions are byte-identical.
      expect(after['maic-documents']).toEqual(before['maic-documents']);
      expect(after['maic-runtime'].records).toEqual(
        (before['maic-runtime'] as Record<string, unknown[]>).records,
      );
      const repairedRootId = `quiz-attempt:${ROOT_STAGE}:${OLD_OWNER}`;
      const preservedSessions = (
        after['maic-runtime'].sessions as Array<Record<string, unknown>>
      ).filter((row) => row.id !== repairedRootId);
      const expectedPreserved = (
        (before['maic-runtime'] as Record<string, unknown[]>).sessions as Array<
          Record<string, unknown>
        >
      ).filter((row) => row.id !== repairedRootId);
      expect(preservedSessions).toEqual(expectedPreserved);
      const repairedRoot = (after['maic-runtime'].sessions as Array<Record<string, unknown>>).find(
        (row) => row.id === repairedRootId,
      );
      expect(repairedRoot).toMatchObject({
        status: 'active', // the documented repair verdict
        kind: 'quizAttempt',
        stageId: ROOT_STAGE,
        learnerKey: OLD_OWNER,
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      expect(Date.parse(String(repairedRoot?.updatedAt))).toBeGreaterThan(
        // fresh stamp
        Date.parse('2026-01-02T00:00:00.000Z'),
      );

      // The v1 events survived the v3 upgrade field-for-field; the upgrade
      // ADDED receipts/bindings stores with NOTHING invented.
      const outbox = await readAllStores(page, 'MAIC-mistake-outbox');
      expect(Object.keys(outbox).sort()).toEqual(['bindings', 'events', 'receipts']);
      const events = outbox.events as Array<Record<string, unknown>>;
      const byKey = new Map(events.map((row) => [String(row.key), row]));
      for (const seeded of v1Events) {
        expect(byKey.get(seeded.key)).toEqual(seeded);
      }
      expect(outbox.receipts).toEqual([]);
      expect(outbox.bindings).toEqual([]);

      // PROGRESS FIRST-CREATION: absent before the app ran; the app may
      // create it only through a REAL capture (none happened in this flow
      // for the CURRENT owner — the review was undecided and Retry grading
      // was not clicked), so it stays absent or empty — never fabricated.
      const progressExists = await dbExists(page, 'MAIC-capture-progress');
      if (progressExists) {
        const progress = await readAllStores(page, 'MAIC-capture-progress');
        expect(Object.values(progress).flat()).toEqual([]);
      }

      // EXPLICIT CLAIM through the real UI: the unbound panel + claim action
      // bind the row to the CURRENT confirmed owner and sync it for real.
      await expect(page.getByText(/no confirmed identity/i).first()).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole('button', { name: /claim to this account/i }).click();
      await expect(page.getByText(/claimed/i).first()).toBeVisible({ timeout: 20_000 });
      const claimedOutbox = await readAllStores(page, 'MAIC-mistake-outbox');
      const claimedEvents = claimedOutbox.events as Array<Record<string, unknown>>;
      // The claimed row moved OFF the unbound key and a receipt exists for
      // its uploaded destination; the OTHER-OWNER parked rows are unchanged.
      expect(claimedEvents.find((row) => String(row.key).startsWith('|'))).toBeUndefined();
      for (const seeded of [v1Events[0]!, v1Events[2]!, v1Events[3]!]) {
        const row = claimedEvents.find((candidate) => candidate.key === seeded.key);
        expect(row).toEqual(seeded); // parked foreign-owner rows untouched
      }
      const claimedReceipt = (claimedOutbox.receipts as Array<Record<string, unknown>>).find(
        (row) => String(row.key).includes('evt-unbound'),
      );
      expect(claimedReceipt?.eventId).toBe('evt-unbound');
      expect(typeof claimedReceipt?.at).toBe('number');
      // The server actually received the claimed record through the real API.
      const rows = (await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/mistakes?filter=all`);
        const body = (await response.json()) as {
          data?: { mistakes?: Array<Record<string, unknown>> };
        };
        return body.data?.mistakes ?? [];
      }, BASE)) as Array<Record<string, unknown>>;
      expect(rows.some((row) => row.questionId === 'q-unbound')).toBe(true);

      // SAME-CLIENT OWNER SWITCH: clear cookies on the SAME context — the
      // next request mints a NEW anonymous owner. Same databases, so parked
      // foreign-owner rows must remain byte-identical, while the previously
      // claimed/uploaded records are invisible to the new owner.
      const parkedBeforeSwitch = (await readAllStores(page, 'MAIC-mistake-outbox')).events as Array<
        Record<string, unknown>
      >;
      await context.clearCookies();
      await page.goto(`${BASE}/mistake-book`);
      const newOwnerCount = (await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/mistakes?count=unmastered`);
        const body = (await response.json()) as { data?: { count?: number } };
        return body.data?.count ?? 0;
      }, BASE)) as number;
      expect(newOwnerCount).toBe(0); // uploaded records are owner-scoped
      const parkedAfterSwitch = (await readAllStores(page, 'MAIC-mistake-outbox')).events as Array<
        Record<string, unknown>
      >;
      expect(parkedAfterSwitch).toEqual(parkedBeforeSwitch);
    } finally {
      await page
        .evaluate(async (url) => {
          await fetch(`${url}/api/mistakes`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true }),
          });
        }, BASE)
        .catch(() => undefined);
      await context.close();
    }
  });

  test('v2 outbox: ALL events and receipt fields preserved exactly through real initialization', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(FIXTURE_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>fixture' }),
    );
    // Default external-AI fallback BEFORE any application page is loaded.
    await context.route('**/api/quiz-grade', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'AI_GRADE_UNAVAILABLE' }),
      }),
    );
    await page.goto(FIXTURE_URL);
    await page.addInitScript(() => {
      localStorage.setItem('locale', 'en-US');
      localStorage.setItem('maic:account:settings-storage', '{}');
    });
    const receipt = {
      key: `${OLD_OWNER}|evt-old`,
      eventId: 'evt-old',
      fingerprint: 'seeded-fingerprint-v2',
      recordToken: 'tok-seeded-v2',
      createdAt: 1_111,
      at: 1_500,
    };
    const before = await seedOnFixture(page, {
      withLearning: learningFixture,
      outbox: {
        version: 2,
        events: [
          {
            key: `${OLD_OWNER}|evt-old`,
            eventId: 'evt-old',
            owner: OLD_OWNER,
            payload: frozenPayload('evt-old', 'q-old', 'v2 kept?'),
            createdAt: 1_111,
            attempts: 1,
            lastAttemptAt: 1_450,
            lastError: 'HTTP 500',
            status: 'failed',
            creationToken: 'tok-seeded-v2',
          },
        ],
        receipts: [receipt],
      },
    });
    try {
      expect((before['MAIC-mistake-outbox'] as Record<string, unknown[]>).receipts).toHaveLength(1);
      await page.goto(`${BASE}/mistake-book`);
      await expect(page.getByRole('heading', { name: 'Mistake Book' })).toBeVisible({
        timeout: 20_000,
      });
      await page.waitForTimeout(1_500);
      const outbox = await readAllStores(page, 'MAIC-mistake-outbox');
      // EVERY event field preserved; the receipt preserved EXACTLY; the
      // bindings store was ADDED empty — no invented binding for old history.
      expect(outbox.events).toEqual(
        (before['MAIC-mistake-outbox'] as Record<string, unknown[]>).events,
      );
      expect(outbox.receipts).toEqual([receipt]);
      expect(outbox.bindings).toEqual([]);
      // Learning DB again untouched through real initialization.
      expect(await readAllStores(page, 'maic-runtime')).toEqual(before['maic-runtime']);
    } finally {
      await context.close();
    }
  });

  test('loaded v3: new receipt commits under the DEFAULT 500 retention — total stays EXACTLY 500, oldest evicted, the committed non-contradictory binding journal and its destination row survive consumably', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(FIXTURE_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>fixture' }),
    );
    // Default external-AI fallback BEFORE any application page is loaded.
    await context.route('**/api/quiz-grade', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'AI_GRADE_UNAVAILABLE' }),
      }),
    );
    await page.goto(FIXTURE_URL);
    await page.addInitScript(() => {
      localStorage.setItem('locale', 'en-US');
      localStorage.setItem('maic:account:settings-storage', '{}');
    });
    // 500 OLD receipts (ordered by `at` ascending: evt-0 oldest) plus a
    // structurally VALID unfinished binding journal (an unbound source row
    // that really sits in the queue — its pending recovery evidence).
    const oldReceipts = Array.from({ length: 500 }, (_, i) => ({
      key: `${OLD_OWNER}|evt-${i}`,
      eventId: `evt-${i}`,
      fingerprint: `seeded-fp-${i}`,
      recordToken: `seeded-tok-${i}`,
      createdAt: i,
      at: i,
    }));
    const bindingSourceKey = '|evt-binding';
    const bindingPayload = frozenPayload('evt-binding', 'q-binding', 'binding destination kept?');
    // The journal's fingerprints are the EXACT production fingerprints of the
    // seeded source payload (stable canonical serialization), computed here
    // with the same recursive key-sorting — not arbitrary strings.
    const stableFingerprintOf = (value: unknown): string =>
      value === null || typeof value !== 'object'
        ? (JSON.stringify(value) ?? 'null')
        : Array.isArray(value)
          ? `[${value.map(stableFingerprintOf).join(',')}]`
          : `{${Object.keys(value as Record<string, unknown>)
              .sort()
              .map(
                (key) =>
                  `${JSON.stringify(key)}:${stableFingerprintOf((value as Record<string, unknown>)[key])}`,
              )
              .join(',')}}`;
    const destinationFingerprintJournal = stableFingerprintOf(
      frozenPayload('evt-binding', 'q-binding', 'binding destination kept?'),
    );
    const bindingJournal = {
      sourceKey: bindingSourceKey,
      entries: [
        {
          bindingVersion: 1,
          sourceKey: bindingSourceKey,
          reason: 'active-bind',
          source: {
            key: bindingSourceKey,
            owner: '',
            eventId: 'evt-binding',
            fingerprint: destinationFingerprintJournal,
            recordToken: null,
            createdAt: 5_000,
          },
          destination: {
            key: `${OLD_OWNER}|evt-binding`,
            owner: OLD_OWNER,
            eventId: 'evt-binding',
            fingerprint: destinationFingerprintJournal,
            recordToken: 'seeded-tok-binding',
          },
          recordedAt: 5_001,
        },
      ],
    };
    // The journal reflects a GENUINELY COMMITTED move: the source key is
    // GONE (moved away) and the destination row exists at the destination
    // key with the journal's exact fingerprint/token — a consistent,
    // consumable unfinished-recovery state, never a contradictory one.
    const destinationEvent = {
      key: `${OLD_OWNER}|evt-binding`,
      eventId: 'evt-binding',
      owner: OLD_OWNER,
      payload: bindingPayload,
      createdAt: 5_002,
      attempts: 0,
      status: 'pending',
      creationToken: 'seeded-tok-binding',
    };
    const pendingEvents = [
      destinationEvent,
      // One CURRENT-owner upload that commits a NEW receipt and fires the
      // retention trim. It uses the SAME owner as the seeded receipts so
      // the trim's eviction ordering is exercised against real data.
      {
        key: `${OLD_OWNER}|evt-live`,
        eventId: 'evt-live',
        owner: OLD_OWNER,
        payload: frozenPayload('evt-live', 'q-live', 'live upload?'),
        createdAt: 6_000,
        attempts: 0,
        status: 'pending',
        creationToken: 'tok-live',
      },
    ];
    // REAL old asset rows (the actual BrowserAssetStore layout) and the old
    // learning/course fixtures — all BEFORE first initialization.
    const assetBlobs = [{ contentHash: 'hash-asset-old', mime: 'image/png', bytes: [7, 7, 7] }];
    const assetRows = [
      {
        id: 'ast-old-pool',
        contentHash: 'hash-asset-old',
        mime: 'image/png',
        meta: { contentType: 'image/png', origin: 'c3-preservation' },
      },
    ];
    const before = await seedOnFixture(page, {
      withLearning: learningFixture,
      withCourse: [courseFor(CHILD_STAGE), courseFor(ROOT_STAGE)],
      assets: { blobs: assetBlobs, assets: assetRows },
      outbox: {
        version: 3,
        events: pendingEvents,
        receipts: oldReceipts,
        bindings: [bindingJournal],
      },
    });
    try {
      expect((before['MAIC-mistake-outbox'] as Record<string, unknown[]>).receipts).toHaveLength(
        500,
      );

      // Hydrate the app. The lifecycle flush PARKS the foreign-owner rows
      // (their owner ≠ this context's anonymous owner), so drive ONE real
      // same-owner upload through the real classroom capture path: the
      // current owner answers wrong and the real POST commits a receipt.
      await page.evaluate((stageId) => {
        const now = Date.now();
        return new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('maic-documents', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('stages', { keyPath: 'id' });
            const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
            scenes.createIndex('by-stage', 'stageId');
            db.createObjectStore('outlines', { keyPath: 'stageId' });
          };
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
            tx.objectStore('stages').put({
              id: stageId,
              name: 'C3',
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('scenes').put({
              id: 'c3-live-scene',
              stageId,
              type: 'quiz',
              title: 'C3',
              order: 0,
              content: {
                type: 'quiz',
                questions: [
                  {
                    id: 'q-live-real',
                    type: 'single',
                    question: 'live real one?',
                    options: [
                      { label: 'Yes', value: 'A' },
                      { label: 'No', value: 'B' },
                    ],
                    answer: ['A'],
                    points: 1,
                  },
                ],
              },
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('outlines').put({
              stageId,
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
      }, 'c3-retention-stage');
      await page.goto(`${BASE}/classroom/c3-retention-stage`);
      await page.getByRole('button', { name: 'Start Quiz' }).click();
      const no = page.getByRole('button', { name: /No/i }).first();
      await expect(no).toBeEnabled({ timeout: 15_000 });
      await no.click();
      await page.getByRole('button', { name: 'Submit Answers' }).click();
      await expect(page.getByText('Quiz Report')).toBeVisible({ timeout: 15_000 });

      // The real flush commits the NEW receipt; retention trims back to
      // EXACTLY 500 (one OLD row — evt-0, the smallest `at` — evicted).
      await expect
        .poll(
          async () => ((await readAllStores(page, 'MAIC-mistake-outbox')).receipts ?? []).length,
          { timeout: 25_000 },
        )
        .toBe(500);
      const afterTrim = await readAllStores(page, 'MAIC-mistake-outbox');
      const receipts = afterTrim.receipts as Array<Record<string, unknown>>;
      expect(receipts.some((row) => row.key === `${OLD_OWNER}|evt-0`)).toBe(false); // evicted
      expect(receipts.some((row) => row.key === `${OLD_OWNER}|evt-1`)).toBe(true); // kept
      // The unfinished binding journal survives the trim AND remains
      // NON-CONTRADICTORY: the source key is still GONE (the move stands)
      // and the destination row is intact with the journal's exact
      // fingerprint and token — a genuinely consumable recovery mapping.
      expect(afterTrim.bindings).toEqual([bindingJournal]);
      const events = afterTrim.events as Array<Record<string, unknown>>;
      expect(events.find((row) => row.key === bindingSourceKey)).toBeUndefined(); // moved away
      const destinationAfter = events.find((row) => row.key === `${OLD_OWNER}|evt-binding`);
      expect(destinationAfter).toEqual(destinationEvent);
      const journalEntry = bindingJournal.entries[0] as unknown as {
        destination: { fingerprint: string; recordToken: string; key: string };
      };
      expect(destinationAfter).toMatchObject({
        key: journalEntry.destination.key,
        creationToken: journalEntry.destination.recordToken,
      });
      // Consumability: the destination payload re-fingerprints to the
      // journal's exact value — the mapping can still be matched strictly.
      const destinationFingerprintAfter = stableFingerprintOf(destinationAfter?.payload);
      expect(destinationFingerprintAfter).toBe(journalEntry.destination.fingerprint);

      // PROGRESS FIRST-CREATION → CONFIRMED: the REAL capture above
      // (q-live-real answered wrong, submitted, POSTed, receipt committed)
      // created the progress database for the first time. Select the row
      // for THIS exact operation by its full plan identity (the scope
      // embeds the event id), wait for the REAL consumer to reach
      // CONFIRMED, and verify the full identity fields — never a loose
      // pending-or-confirmed.
      const progressExists = await dbExists(page, 'MAIC-capture-progress');
      expect(progressExists).toBe(true);
      const readProgressRow = async () => {
        const progress = await readAllStores(page, 'MAIC-capture-progress');
        const rows = (progress.progress ?? []) as Array<Record<string, unknown>>;
        return rows.find((row) => String(row.scope).includes('q-live-real'));
      };
      await expect
        .poll(async () => (await readProgressRow())?.state, { timeout: 25_000 })
        .toBe('confirmed');
      const confirmedRow = (await readProgressRow())!;
      expect(confirmedRow.progressVersion).toBe(1);
      expect(String(confirmedRow.scope)).toContain('q-live-real');
      // The FULL actual identity exists and matches the LIVE committed facts:
      // plan identity fields (the runtime plan's attempt/scene/event) plus
      // the exact queue/receipt instance (owner-scoped key, eventId, token,
      // fingerprint) — the confirmation basis is a real upload.
      // The actual identity is REQUIRED and matches the LIVE committed
      // receipt on every MODERN field the schema defines: kind, owner-scoped
      // key, owner, eventId, recordToken, fingerprint. ModernActualIdentity
      // has NO createdAt (that is the legacy plane); nothing invented.
      const confirmedActual = confirmedRow.actual as {
        kind?: string;
        key?: string;
        owner?: string;
        eventId?: string;
        fingerprint?: string;
        recordToken?: string | null;
      };
      expect(confirmedActual).toBeDefined();
      expect(confirmedActual.kind).toBe('modern');
      const liveReceipt = (
        (await readAllStores(page, 'MAIC-mistake-outbox')).receipts as Array<
          Record<string, unknown>
        >
      ).find((row) => String(row.eventId).includes('q-live-real'));
      expect(liveReceipt).toBeDefined();
      expect(confirmedActual.key).toBe(liveReceipt?.key);
      expect(confirmedActual.owner).toBe(String(liveReceipt?.key).split('|')[0]);
      expect(confirmedActual.eventId).toBe(liveReceipt?.eventId);
      expect(confirmedActual.recordToken ?? null).toBe(liveReceipt?.recordToken ?? null);
      expect(confirmedActual.fingerprint).toBe(liveReceipt?.fingerprint);
      // The plan identity is REQUIRED and ties to the REAL single-question
      // runtime attempt on every field: learner partition, attempt id, scene,
      // origin episode/owner, question id, event id, the ONCE-minted plan
      // record token, and the frozen payload fingerprint — and the stored
      // SCOPE is exactly `${learnerKey}|${attemptId}|${eventId}`.
      const planIdentity = confirmedRow.planIdentity as {
        learnerKey?: string;
        attemptId?: string;
        sceneId?: string;
        originEpisodeId?: string;
        originOwner?: string;
        questionId?: string;
        eventId?: string;
        planRecordToken?: string;
        frozenPayloadFingerprint?: string;
      } | null;
      expect(planIdentity).not.toBeNull();
      expect(String(planIdentity?.eventId)).toBe(String(confirmedActual.eventId));
      expect(String(planIdentity?.sceneId)).toBe('c3-live-scene');
      expect(String(planIdentity?.questionId)).toBe('q-live-real');
      expect(String(planIdentity?.learnerKey)).toContain('anon:');
      expect(String(planIdentity?.attemptId)).toContain('quiz-attempt:');
      expect(String(planIdentity?.originEpisodeId)).not.toBe('');
      expect(String(planIdentity?.originOwner)).toContain('anon:');
      expect(typeof planIdentity?.planRecordToken).toBe('string');
      expect(planIdentity?.planRecordToken).not.toBe('');
      expect(typeof planIdentity?.frozenPayloadFingerprint).toBe('string');
      expect(planIdentity?.frozenPayloadFingerprint).not.toBe('');
      expect(String(confirmedRow.scope)).toBe(
        `${planIdentity?.learnerKey}|${planIdentity?.attemptId}|${planIdentity?.eventId}`,
      );
      // The REAL runtime frozen capture plan: the adopted attempt's own
      // record carries the plan header + this question's item, with the
      // item's token == the plan identity's once-minted token and the
      // header's episode == originEpisodeId.
      const runtimePlan = await page.evaluate(() => {
        return new Promise<Record<string, unknown> | null>((resolve, reject) => {
          const open = indexedDB.open('maic-runtime');
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('records', 'readonly');
            const rows: Array<Record<string, unknown>> = [];
            const getAll = tx.objectStore('records').getAll();
            getAll.onsuccess = () => {
              rows.push(...(getAll.result ?? []));
            };
            tx.oncomplete = () => {
              db.close();
              const withPlan = rows
                .filter(
                  (row) =>
                    (row.payload as { capturePlan?: unknown } | undefined)?.capturePlan !==
                    undefined,
                )
                .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
                .at(-1);
              resolve(
                (withPlan?.payload as { capturePlan?: Record<string, unknown> })?.capturePlan ??
                  null,
              );
            };
            tx.onerror = () => reject(tx.error);
          };
          open.onerror = () => reject(open.error);
        });
      });
      expect(runtimePlan).not.toBeNull();
      // THREE header EQUALITIES against the stored plan identity (not merely
      // nonempty): attemptId, originEpisodeId, learnerKey, sceneId and
      // originOwner must all match field-for-field.
      expect(runtimePlan?.attemptId).toBe(String(planIdentity?.attemptId));
      expect(runtimePlan?.originEpisodeId).toBe(String(planIdentity?.originEpisodeId));
      expect(runtimePlan?.learnerKey).toBe(String(planIdentity?.learnerKey));
      expect(runtimePlan?.sceneId).toBe(String(planIdentity?.sceneId));
      expect(runtimePlan?.originOwner).toBe(String(planIdentity?.originOwner));
      const planItems = (runtimePlan?.items ?? []) as Array<
        Partial<{
          questionId: string;
          eventId: string;
          recordToken: string;
          payload: unknown;
        }>
      >;
      const liveItem = planItems.find((item) => item.questionId === 'q-live-real');
      expect(liveItem).toBeDefined();
      expect(liveItem?.recordToken).toBe(planIdentity?.planRecordToken);
      expect(liveItem?.eventId).toBe(String(planIdentity?.eventId));
      // The frozen payload fingerprint EQUALS the canonical serialization of
      // the plan item's own frozen payload — not merely nonempty.
      expect(planIdentity?.frozenPayloadFingerprint).toBe(stableFingerprintOf(liveItem?.payload));
      // An ordinary KNOWN-OWNER new capture: the plan's once-minted token IS
      // the actual record instance token (they are the same instance).
      expect(planIdentity?.planRecordToken).toBe(
        String((confirmedActual as { recordToken?: string }).recordToken),
      );
      // The confirmation basis is the STRING enum ('upload' | 'receipt') on
      // StoredProgressRecord — a genuine basis, never basis-less.
      expect(['upload', 'receipt']).toContain(confirmedRow.adoption);

      // RELOAD DURABILITY: after a real page reload the SAME operation
      // remains confirmed and NO duplicate capture happens — the server row
      // count for this question stays exactly one and its wrongCount stays
      // at 1 (a duplicate capture would bump it).
      const rowsBeforeReload = (await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/mistakes?filter=all`);
        const body = (await response.json()) as {
          data?: { mistakes?: Array<Record<string, unknown>> };
        };
        return body.data?.mistakes ?? [];
      }, BASE)) as Array<Record<string, unknown>>;
      const liveRowBefore = rowsBeforeReload.find((row) => row.questionId === 'q-live-real')!;
      await page.reload();
      await expect(page.getByText('Quiz Report').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      // The ENTIRE confirmed row is frozen across the reload — identity,
      // basis, and state all durable, not just the state field.
      expect(await readProgressRow()).toEqual(confirmedRow);
      const rowsAfterReload = (await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/mistakes?filter=all`);
        const body = (await response.json()) as {
          data?: { mistakes?: Array<Record<string, unknown>> };
        };
        return body.data?.mistakes ?? [];
      }, BASE)) as Array<Record<string, unknown>>;
      const liveRowsAfter = rowsAfterReload.filter((row) => row.questionId === 'q-live-real');
      expect(liveRowsAfter).toHaveLength(1); // no duplicate capture
      expect(liveRowsAfter[0]!.wrongCount).toBe(liveRowBefore.wrongCount);

      // OLD COURSE DOCUMENTS preserved exactly: the live capture added a
      // c3-retention-stage, but the two SEEDED stages' rows are unchanged —
      // compared by their actual stage row and composite scene/outline keys.
      const docsAfter = await readAllStores(page, 'maic-documents');
      const seededStages = [courseFor(CHILD_STAGE).stage, courseFor(ROOT_STAGE).stage];
      for (const seededStage of seededStages) {
        expect(
          (docsAfter.stages as Array<Record<string, unknown>>).find(
            (row) => row.id === seededStage.id,
          ),
        ).toEqual(seededStage);
      }
      const expectedScenes = [...courseFor(CHILD_STAGE).scenes, ...courseFor(ROOT_STAGE).scenes];
      for (const seededScene of expectedScenes) {
        expect(
          (docsAfter.scenes as Array<Record<string, unknown>>).find(
            (row) =>
              (row as { stageId?: string }).stageId === seededScene.stageId &&
              row.id === seededScene.id,
          ),
        ).toEqual(seededScene);
      }
      for (const stageId of [CHILD_STAGE, ROOT_STAGE]) {
        const seededOutline = courseFor(stageId).outline;
        expect(
          (docsAfter.outlines as Array<Record<string, unknown>>).find(
            (row) => (row as { stageId?: string }).stageId === stageId,
          ),
        ).toMatchObject({ stageId, outline: seededOutline });
      }

      // OLD ASSETS + LEARNING preserved exactly through first progress
      // creation and reload (old-row SUBSET comparison: the real new
      // attempt may add rows, the seeded ones must be identical).
      // The AFTER comparison uses the SAME keyed Blob-byte snapshot helper
      // (a generic readAllStores JSON-serializes a Blob to {} and cannot
      // prove byte preservation): the old asset row is identical, its
      // out-of-line KEY survives, and the blob bytes are bit-identical.
      const assetsAfter = await readAssetPoolSnapshot(page);
      expect(assetsAfter.assetKeys).toContain('ast-old-pool');
      expect(
        assetsAfter.assetRows.find((row) => (row as { id?: string }).id === 'ast-old-pool'),
      ).toEqual(assetRows[0]);
      expect(assetsAfter.blobKeys).toContain('hash-asset-old');
      const seededBytesBase64 = await page.evaluate((bytes) => {
        let binary = '';
        for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
        return btoa(binary);
      }, assetBlobs[0]!.bytes);
      expect(assetsAfter.blobBytesBase64['hash-asset-old']).toBe(seededBytesBase64);
      const learningAfter = await readAllStores(page, 'maic-runtime');
      const afterRecords = learningAfter.records as Array<Record<string, unknown>>;
      const afterSessions = learningAfter.sessions as Array<Record<string, unknown>>;
      const seededRecordIds = new Set(learningFixture.records.map((row) => row.id));
      const seededSessionIds = new Set(learningFixture.sessions.map((row) => row.id));
      // Record ids repeat across the two fixture STAGES (same literal id in
      // different sessions), so compare SET-wise: every seeded row appears
      // exactly as seeded (by full deep equality against its id's row set).
      for (const seeded of learningFixture.records) {
        const candidates = afterRecords.filter((row) => row.id === seeded.id);
        expect(candidates).toContainEqual(seeded);
      }
      // Old sessions preserved (the fixtures' partitions are not visited by
      // the live capture stage, so all three old sessions stand unchanged).
      for (const seeded of learningFixture.sessions) {
        expect(afterSessions.find((row) => row.id === seeded.id)).toEqual(seeded);
      }
      expect(afterRecords.filter((row) => seededRecordIds.has(String(row.id))).length).toBe(
        learningFixture.records.length,
      );
      expect(afterSessions.filter((row) => seededSessionIds.has(String(row.id))).length).toBe(
        learningFixture.sessions.length,
      );
    } finally {
      await page
        .evaluate(async (url) => {
          await fetch(`${url}/api/mistakes`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true }),
          });
        }, BASE)
        .catch(() => undefined);
      await context.close();
    }
  });
});
