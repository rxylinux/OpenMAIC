/**
 * C3 §5 — the four-mode PAGE matrix.
 *
 * classic (no DATABASE_URL) / DB-on + Agent Runtime OFF / Agent Runtime ON /
 * deleted-course-but-wrong-records-kept. Each server is a REAL `next start`
 * of the one production build (NEXT_PUBLIC flags baked once), spawned with an
 * EXPLICIT minimal environment (a whitelist, not inherited user env: Next
 * reloads .env files, so only PATH/HOME-class variables plus our own values
 * are passed — user keys never reach these processes). The mode is PROVEN
 * per server through the real runtime probe before any page case; external
 * AI is default-mocked in every context BEFORE any goto; per-server
 * stdout/stderr stream continuously to stable log files; cleanup kills the
 * whole spawned process group and verifies the ports are free. All flows are
 * real same-origin app interactions through production UI/API/backend paths.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { cp, mkdir, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const ISOLATED_PG = 'postgres://postgres:c2-e2e-synthetic@127.0.0.1:57540/c2_e2e';
const EVIDENCE_DIR = '.zcode/evidence/final-20261003';
const BUILD_FLAGS = {
  NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true',
  NEXT_PUBLIC_PI_CHAT_ENABLED: 'true',
  NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED: 'true',
};

interface ModeServer {
  name: string;
  port: number;
  process?: ChildProcess;
  logStream?: WriteStream;
  baseUrl: string;
}

const servers: ModeServer[] = [
  { name: 'classic', port: 3110, baseUrl: 'http://127.0.0.1:3110' },
  { name: 'db-agent-off', port: 3111, baseUrl: 'http://127.0.0.1:3111' },
  { name: 'agent-on', port: 3112, baseUrl: 'http://127.0.0.1:3112' },
];

function serverMode(name: string): ModeServer {
  const server = servers.find((candidate) => candidate.name === name);
  if (!server) throw new Error(`unknown mode ${name}`);
  return server;
}

/**
 * Launch the production server from a DISPOSABLE RUNTIME DIRECTORY that
 * contains no .env files at all. The build's standalone layout ships a
 * traced `.env` next to its server.js, and server.js runs
 * `process.chdir(__dirname)` — launching it in place would load that file.
 * The runtime dir therefore holds a PHYSICAL COPY of server.js (so
 * __dirname is the clean dir) plus links to the frozen build's node_modules,
 * .next (server + linked static) and public — and nothing else. The explicit
 * minimal environment below is then the COMPLETE server configuration. A
 * pre-start port probe refuses to reuse any stale listener; per-server logs
 * are uniquely numbered per run; cleanup kills the whole process group and
 * removes the disposable directory.
 */
// A GLOBALLY UNIQUE run label per Playwright process: server logs and
// runtime dirs never overwrite across runs.
const RUN_LABEL = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
let runtimeRunId = 0;
const runtimeDirs: string[] = [];

async function buildRuntimeDir(server: ModeServer): Promise<string> {
  runtimeRunId += 1;
  const dir = resolve(`${EVIDENCE_DIR}/runtime-${server.name}-${RUN_LABEL}-${runtimeRunId}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // Physical copy: __dirname must resolve INSIDE the clean directory.
  await cp('.next/standalone/server.js', `${dir}/server.js`);
  // Links to the frozen build artifacts (never .env):
  await symlink(resolve('.next/standalone/node_modules'), `${dir}/node_modules`);
  await symlink(resolve('.next/standalone/.next'), `${dir}/.next`);
  await symlink(resolve('.next/standalone/public'), `${dir}/public`);
  runtimeDirs.push(dir);
  return dir;
}

async function startServer(server: ModeServer): Promise<void> {
  if (server.process) return;
  // No stale process may serve this probe: the port must be dead first.
  const stale = await fetch(`${server.baseUrl}/api/agent/runtime`).then(
    () => true,
    () => false,
  );
  if (stale) throw new Error(`port ${server.port} already has a listener — refusing stale reuse`);
  const dir = await buildRuntimeDir(server);
  const stream = createWriteStream(
    `${EVIDENCE_DIR}/server-${server.name}-${RUN_LABEL}-run${runtimeRunId}.log`,
    {
      flags: 'w',
    },
  );
  server.logStream = stream;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    NODE_ENV: 'production',
    PORT: String(server.port),
    HOSTNAME: '127.0.0.1',
    ...BUILD_FLAGS,
    DATABASE_URL: server.name === 'classic' ? '' : ISOLATED_PG,
    OPENMAIC_AGENT_RUNTIME_ENABLED: server.name === 'agent-on' ? '1' : '',
  };
  const child = spawn('node', ['server.js'], {
    cwd: dir, // __dirname === cwd === the clean runtime directory
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group: cleanup kills the WHOLE tree
  });
  server.process = child;
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${server.baseUrl}/api/agent/runtime`);
      if (response.ok) {
        const body = (await response.json()) as { enabled: boolean };
        if (typeof body.enabled === 'boolean') return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${server.name} server never became ready on ${server.port}`);
}

/** Kill the server's WHOLE process group and wait for its port to free. */
async function stopServer(server: ModeServer): Promise<void> {
  const child = server.process;
  if (!child) return;
  server.process = undefined;
  try {
    process.kill(-(child.pid as number), 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const stillAlive = await fetch(`${server.baseUrl}/api/agent/runtime`).then(
      () => true,
      () => false,
    );
    if (!stillAlive) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  try {
    process.kill(-(child.pid as number), 'SIGKILL');
  } catch {
    // group already gone
  }
  await new Promise<void>((resolve) => {
    server.logStream?.end(() => resolve());
    setTimeout(resolve, 1_000);
  });
}

/** A valid quiz-scene document body for PUT (DSL envelopes). */
function validQuizDocument(stageId: string, questionId: string, question: string): unknown {
  return {
    stage: { id: stageId, name: 'C3 Matrix Course', createdAt: 1_000, updatedAt: 1_000 },
    scenes: [
      {
        id: 'c3-scene-1',
        stageId,
        title: 'Scene',
        order: 0,
        type: 'quiz',
        content: {
          type: 'quiz',
          questions: [
            {
              id: questionId,
              type: 'single',
              question,
              options: [
                { label: 'Yes', value: 'A' },
                { label: 'No', value: 'B' },
              ],
              answer: ['A'],
              points: 1,
            },
          ],
        },
      },
    ],
    outline: { outlines: [], requirement: 'C3 Matrix', generationComplete: false },
  };
}

test.describe.serial('C3 four-mode page matrix', () => {
  test.beforeAll(async () => {
    for (const server of servers) await startServer(server);
  });
  test.afterAll(async () => {
    for (const server of [...servers].reverse()) await stopServer(server);
    for (const dir of runtimeDirs)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Fresh context: locale pinned, default external-AI fallback pre-goto. */
  async function freshPage(browser: { newContext(): Promise<BrowserContext> }): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('maic:account:settings-storage', '{}');
      localStorage.setItem('locale', 'en-US');
    });
    await context.route('**/api/quiz-grade', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'AI_GRADE_UNAVAILABLE' }),
      }),
    );
    return page;
  }

  test('mode probes: each server REALLY runs its declared mode', async () => {
    const classic = await (
      await fetch(`${serverMode('classic').baseUrl}/api/agent/runtime`)
    ).json();
    expect(classic).toEqual({ enabled: false, runtimeEnabled: false });
    const agentOff = await (
      await fetch(`${serverMode('db-agent-off').baseUrl}/api/agent/runtime`)
    ).json();
    expect(agentOff).toEqual({ enabled: false, runtimeEnabled: false });
    const agentOn = await (
      await fetch(`${serverMode('agent-on').baseUrl}/api/agent/runtime`)
    ).json();
    expect(agentOn).toEqual({ enabled: true, runtimeEnabled: true });

    const stagesOff = await fetch(`${serverMode('db-agent-off').baseUrl}/api/stages`);
    expect(stagesOff.status).toBe(404);
    const stagesOn = await fetch(`${serverMode('agent-on').baseUrl}/api/stages`);
    expect(stagesOn.status).toBe(200);
  });

  test('CLASSIC: mistakes API honestly 503 on every method; the page shows the notConfigured panel', async ({
    browser,
  }) => {
    const base = serverMode('classic').baseUrl;
    const statuses: number[] = [];
    statuses.push(await fetch(`${base}/api/mistakes`).then((r) => r.status));
    statuses.push(await fetch(`${base}/api/mistakes?count=unmastered`).then((r) => r.status));
    statuses.push(await fetch(`${base}/api/mistakes`, { method: 'POST' }).then((r) => r.status));
    statuses.push(await fetch(`${base}/api/mistakes`, { method: 'PATCH' }).then((r) => r.status));
    statuses.push(await fetch(`${base}/api/mistakes`, { method: 'DELETE' }).then((r) => r.status));
    expect(statuses).toEqual([503, 503, 503, 503, 503]);
    expect(
      await fetch(`${base}/api/mistakes`)
        .then((r) => r.json())
        .then((b: { error?: string }) => b.error),
    ).toContain('requires server persistence');

    const page = await freshPage(browser);
    try {
      await page.goto(`${base}/mistake-book`);
      await expect(page.getByText(/requires server persistence/i).first()).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await page.context().close();
    }
  });

  test('DB-ON/AGENT-OFF page flows: real offline outbox capture from the classroom, online replay, DOM classification/filter/count', async ({
    browser,
  }) => {
    const base = serverMode('db-agent-off').baseUrl;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('maic:account:settings-storage', '{}');
      localStorage.setItem('locale', 'en-US');
    });
    await context.route('**/api/quiz-grade', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'AI_GRADE_UNAVAILABLE' }),
      }),
    );
    try {
      // A REAL same-origin page first (owner cookie minted by the real API).
      await page.goto(`${base}/mistake-book`);
      await expect(page.getByRole('heading', { name: 'Mistake Book' })).toBeVisible();

      // The classroom document for this mode lives in the app's local
      // document store (runtime off: local documents, real capture path).
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
              name: 'C3 Offline',
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('scenes').put({
              id: 'c3-off-scene',
              stageId,
              type: 'quiz',
              title: 'C3',
              order: 0,
              content: {
                type: 'quiz',
                questions: [
                  {
                    id: 'q-off',
                    type: 'single',
                    question: 'Offline keeps the record?',
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
      }, 'c3-offline-stage');

      // Take the capture transport OFFLINE for THIS context (the page's own
      // outbox enqueue/retry path is what runs).
      await context.route('**/api/mistakes', (route) =>
        route.request().method() === 'POST' ? route.abort('failed') : route.fallback(),
      );
      await page.goto(`${base}/classroom/c3-offline-stage`);
      await page.getByRole('button', { name: 'Start Quiz' }).click();
      await page.getByRole('button', { name: /No/i }).first().click();
      await page.getByRole('button', { name: 'Submit Answers' }).click();
      await expect(page.getByText('Quiz Report')).toBeVisible({ timeout: 15_000 });
      // The REAL outbox holds the frozen event (offline = queued, not sent).
      const queued = await page.evaluate(
        () =>
          new Promise<unknown[]>((resolve, reject) => {
            const open = indexedDB.open('MAIC-mistake-outbox');
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains('events')) {
                db.close();
                resolve([]);
                return;
              }
              const tx = db.transaction('events', 'readonly');
              const getAll = tx.objectStore('events').getAll();
              getAll.onsuccess = () => {
                resolve(getAll.result ?? []);
                db.close();
              };
              tx.onerror = () => reject(tx.error);
            };
            open.onerror = () => reject(open.error);
          }),
      );
      expect(queued).toHaveLength(1);
      expect((queued[0] as { eventId?: string }).eventId).toContain('q-off');

      // BACK ONLINE: unroute, reload — the REAL outbox replays through the
      // REAL API (server dedupes by event id), and the server row appears.
      await context.unroute('**/api/mistakes');
      await page.goto(`${base}/mistake-book`);
      await expect(page.getByText('Offline keeps the record?').first()).toBeVisible({
        timeout: 20_000,
      });
      const afterReplay = await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/mistakes?filter=all`);
        const body = (await response.json()) as {
          data?: { mistakes?: Array<Record<string, unknown>> };
        };
        return body.data?.mistakes ?? [];
      }, base);
      const row = afterReplay.find((candidate) => candidate.questionId === 'q-off');
      expect(row).toMatchObject({ wrongCount: 1, stageId: 'c3-offline-stage' });

      // STRICT post-replay local facts: the queue is EMPTY (uploaded and
      // deleted) and the receipts store carries the exact committed receipt
      // for this instance (key + fingerprint + at) — inspected directly.
      const localFacts = await page.evaluate(
        () =>
          new Promise<{ events: unknown[]; receipts: unknown[] }>((resolve, reject) => {
            const open = indexedDB.open('MAIC-mistake-outbox');
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction(['events', 'receipts'], 'readonly');
              const events = tx.objectStore('events').getAll();
              const receipts = tx.objectStore('receipts').getAll();
              tx.oncomplete = () => {
                resolve({ events: events.result ?? [], receipts: receipts.result ?? [] });
                db.close();
              };
              tx.onerror = () => reject(tx.error);
            };
            open.onerror = () => reject(open.error);
          }),
      );
      expect(localFacts.events).toEqual([]); // uploaded + deleted
      // The receipt must match the EXACT queued instance field-for-field:
      // key, eventId, creation token (instance plane), original createdAt
      // for token-less rows, and the finite upload-commit `at` stamp. The
      // content fingerprint is verified by feeding the SAME frozen payload
      // through the production fingerprint function in the page.
      const queuedInstance = queued[0] as {
        key: string;
        eventId: string;
        payload: unknown;
        creationToken?: string;
        createdAt: number;
      };
      // The production fingerprint is stableStringify (canonical key-sorted
      // JSON of the frozen payload) — recomputed here with the same
      // recursive key sorting and compared in FULL: same-length-but-different
      // content cannot pass.
      const queuedFingerprint = await page.evaluate((payload) => {
        const stable = (value: unknown): string => {
          if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
          if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
          const record = value as Record<string, unknown>;
          return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
            .join(',')}}`;
        };
        return stable(payload);
      }, queuedInstance.payload);
      const receipt = localFacts.receipts[0] as {
        key?: string;
        eventId?: string;
        fingerprint?: string;
        recordToken?: string | null;
        createdAt?: number;
        at?: number;
      };
      expect(receipt.key).toBe(queuedInstance.key);
      expect(receipt.eventId).toBe(queuedInstance.eventId);
      expect(receipt.fingerprint).toBe(queuedFingerprint); // FULL canonical equality
      expect(receipt.recordToken ?? null).toBe(queuedInstance.creationToken ?? null);
      if (queuedInstance.creationToken === undefined) {
        expect(receipt.createdAt).toBe(queuedInstance.createdAt);
      }
      expect(typeof receipt.at).toBe('number');
      expect(Number.isFinite(receipt.at)).toBe(true);

      // SAME-EVENT re-delivery through the real API: the identical frozen
      // payload (same eventId) is a strict server-side no-op — count, times,
      // and identity unchanged.
      const before = afterReplay.find((candidate) => candidate.questionId === 'q-off')!;
      const redeliver = await page.evaluate(
        async ({ url, payload: body }) => {
          const response = await fetch(`${url}/api/mistakes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          return response.status;
        },
        { url: base, payload: (queued[0] as { payload: unknown }).payload },
      );
      expect(redeliver).toBe(200);
      const afterRedelivery = await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/mistakes?filter=all`);
        const body = (await response.json()) as {
          data?: { mistakes?: Array<Record<string, unknown>> };
        };
        return body.data?.mistakes ?? [];
      }, base);
      const unchanged = afterRedelivery.find((candidate) => candidate.questionId === 'q-off')!;
      expect(unchanged.wrongCount).toBe(1); // idempotent: still exactly one
      expect(unchanged.firstWrongAt).toBe(before.firstWrongAt);
      expect(unchanged.lastWrongAt).toBe(before.lastWrongAt);

      // RE-ANSWER NEW IDENTITY: answer the same quiz again through the real
      // classroom — the capture carries a GENUINELY NEW attempt identity
      // (new event id), not a replay of the old one.
      const capturePosts: string[] = [];
      page.on('request', (request) => {
        if (
          request.url().includes('/api/mistakes') &&
          request.method() === 'POST' &&
          request.postData()
        ) {
          capturePosts.push(request.postData()!);
        }
      });
      await page.goto(`${base}/classroom/c3-offline-stage`);
      // The completed attempt re-answers through the real Retry control;
      // retry returns the quiz to its COVER, so the real Start Quiz entry
      // follows, and the options unlock once the answering state begins.
      await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
      await page.getByRole('button', { name: 'Start Quiz' }).click();
      const reanswerNo = page.getByRole('button', { name: /No/i }).first();
      await expect(reanswerNo).toBeEnabled({ timeout: 15_000 });
      await reanswerNo.click();
      await page.getByRole('button', { name: 'Submit Answers' }).click();
      await expect(page.getByText('Quiz Report')).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => capturePosts.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
      const newEventIds = capturePosts
        .map(
          (body) =>
            (JSON.parse(body) as { items?: Array<{ eventId?: string }> }).items?.[0]?.eventId ?? '',
        )
        .filter((eventId) => eventId.includes('q-off'));
      expect(newEventIds.length).toBeGreaterThanOrEqual(1);
      const firstEventId = (queued[0] as { eventId: string }).eventId;
      for (const eventId of newEventIds) {
        expect(eventId).not.toBe(firstEventId); // NEW attempt identity
      }
      // The new event genuinely landed ON THE SAME UNIQUE ROW: the count
      // endpoint counts unmastered ROWS (still exactly 1 for q-off), while
      // the row's own wrongCount advanced 1 → 2 from the new attempt.
      const afterReanswer = await page.evaluate(async (url) => {
        const [countResponse, listResponse] = await Promise.all([
          fetch(`${url}/api/mistakes?count=unmastered`),
          fetch(`${url}/api/mistakes?filter=all`),
        ]);
        const count = ((await countResponse.json()) as { data?: { count?: number } }).data?.count;
        const rows = (
          (await listResponse.json()) as {
            data?: { mistakes?: Array<Record<string, unknown>> };
          }
        ).data?.mistakes;
        const row = rows?.find((candidate) => candidate.questionId === 'q-off');
        return { count: count ?? 0, wrongCount: Number(row?.wrongCount ?? 0) };
      }, base);
      expect(afterReanswer.count).toBe(1); // unique ROW count is unchanged
      expect(afterReanswer.wrongCount).toBe(2); // the new attempt advanced it

      // OWNER ISOLATION: a fresh context is a DIFFERENT anonymous owner —
      // it sees none of this context's records.
      const otherContext = await browser.newContext();
      const otherPage = await otherContext.newPage();
      try {
        await otherPage.goto(`${base}/mistake-book`);
        const otherCount = await otherPage.evaluate(async (url) => {
          const response = await fetch(`${url}/api/mistakes?count=unmastered`);
          const body = (await response.json()) as { data?: { count?: number } };
          return body.data?.count ?? 0;
        }, base);
        expect(otherCount).toBe(0); // owner-scoped isolation, live
      } finally {
        await otherContext.close();
      }

      // Return to the mistake book for the classification flows.
      await page.goto(`${base}/mistake-book`);
      await expect(page.getByText('Offline keeps the record?').first()).toBeVisible({
        timeout: 15_000,
      });

      // DOM: manual subject+grade classification through the real dialog.
      // INPUT RETENTION exercises the app's REAL list-refresh boundary:
      // the filter UI re-runs the actual load (a real GET); with the GET
      // failing (500) the app shows its stale-list banner while the SAME
      // rows stay mounted — the open dialog's draft picks must survive.
      // Then the successful refresh keeps them too.
      await page.getByRole('button', { name: 'Classify', exact: true }).first().click();
      const dialog = page.locator('div.absolute.right-0.top-6');
      await expect(dialog).toBeVisible();
      await dialog.locator('select').first().selectOption({ label: 'Math' });
      await dialog.locator('select').nth(1).selectOption({ label: 'Grade 1 · Sem 1' });
      // CONTROLLED FAILURE boundary: filter click → real GET fails → banner.
      await context.route('**/api/mistakes*', (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ status: 500 });
        return route.fallback();
      });
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await expect(page.getByText(/Not the latest list/i).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('Offline keeps the record?').first()).toBeVisible(); // row stays
      await expect(dialog.locator('select').first()).toHaveValue('math');
      await expect(dialog.locator('select').nth(1)).toHaveValue('grade-1-up');
      // SUCCESSFUL refresh boundary: retryLoad reruns the real GET.
      await context.unroute('**/api/mistakes*');
      await page.getByRole('button', { name: /retry/i }).first().click();
      await expect(page.getByText('Offline keeps the record?').first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(dialog.locator('select').first()).toHaveValue('math');
      await expect(dialog.locator('select').nth(1)).toHaveValue('grade-1-up');

      // SAVE: the async PATCH must COMMIT — wait for the dialog to CLOSE
      // (the product closes it only when onClassify returned true) and for
      // the PATCH response to have landed.
      const classificationPatched = page.waitForResponse(
        (response) =>
          response.url().includes('/api/mistakes') && response.request().method() === 'PATCH',
      );
      await dialog.getByRole('button', { name: /^Save$|^…$/ }).click();
      await classificationPatched;
      await expect(dialog).not.toBeVisible({ timeout: 10_000 }); // committed

      // The REAL backend now owns the classification — a no-op or failed
      // save FAILS here.
      await expect
        .poll(
          async () =>
            page
              .evaluate(async (url) => {
                const response = await fetch(`${url}/api/mistakes?filter=all`);
                const body = (await response.json()) as {
                  data?: { mistakes?: Array<Record<string, unknown>> };
                };
                return body.data?.mistakes?.find((r) => r.questionId === 'q-off');
              }, base)
              .then((row) => row ?? {}),
          { timeout: 15_000 },
        )
        .toMatchObject({ subject: 'math', gradeSemester: 'grade-1-up' });
      // The list's real DOM renders the classified GROUP label (canonical
      // group headers, not hidden select options).
      await page.goto(`${base}/mistake-book`);
      const subjectHeading = page.getByRole('heading', { level: 2, name: /Math/ }).first();
      await expect(subjectHeading).toBeVisible({ timeout: 15_000 });
      const groupSection = subjectHeading.locator('xpath=ancestor::section[1]');
      await expect(
        groupSection.getByRole('heading', { level: 3, name: /Grade 1/ }).first(),
      ).toBeVisible();

      // DOM: the filter pills drive the real list state.
      await page.getByRole('button', { name: 'Unmastered', exact: true }).click();
      await expect(page.getByText('Offline keeps the record?').first()).toBeVisible();
      await page.getByRole('button', { name: 'Mastered', exact: true }).click();
      await expect(page.getByText('Offline keeps the record?').first()).not.toBeVisible({
        timeout: 10_000,
      });

      // DOM: the home badge count — scoped to the mistake-book ENTRY button
      // (aria-label "Mistake book"), not any number on the page.
      await page.goto(`${base}/`);
      const badge = page.getByRole('button', { name: 'Mistake book', exact: true });
      await expect(badge.getByText(/^\d+$/, { exact: true })).toHaveText('1', {
        timeout: 15_000,
      });
    } finally {
      await page
        .evaluate(async (url) => {
          await fetch(`${url}/api/mistakes`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true }),
          });
        }, base)
        .catch(() => undefined);
      await context.close();
    }
  });

  test('AGENT-ON: real course lifecycle — supported creation path, classroom capture with grading retry, delete keeps the wrong records', async ({
    browser,
  }) => {
    const base = serverMode('agent-on').baseUrl;
    const page = await freshPage(browser);
    let stageId = '';
    try {
      // A same-origin page first (owner cookie from the real server).
      await page.goto(`${base}/`);
      // REAL creation path: POST /api/stages (agent-gated), then PUT the full
      // document with a valid quiz scene (DSL envelope).
      stageId = await page.evaluate(async (url) => {
        const created = await fetch(`${url}/api/stages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'C3 Matrix Course' }),
        });
        if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
        const body = (await created.json()) as { stage?: { id?: string } };
        return body.stage?.id ?? '';
      }, base);
      expect(stageId).toBeTruthy();

      const saved = await page.evaluate(
        async ({ url, id, document }) => {
          const response = await fetch(`${url}/api/stages/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(document),
          });
          return response.status;
        },
        { url: base, id: stageId, document: validQuizDocument(stageId, 'q-del', '删除后保留?') },
      );
      expect(saved).toBe(200);

      // The classroom page serves from its local document store when present
      // (the same production path the retained matrix exercises); seed the
      // SAME stageId there so the classroom is real, while the course's
      // server-side lifecycle above and its deletion below stay on the real
      // agent-gated API against real PostgreSQL.
      await page.evaluate((id) => {
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
              id,
              name: 'C3 Matrix Course',
              createdAt: now,
              updatedAt: now,
            });
            tx.objectStore('scenes').put({
              id: 'c3-scene-1',
              stageId: id,
              type: 'quiz',
              title: 'Scene',
              order: 0,
              content: {
                type: 'quiz',
                questions: [
                  {
                    id: 'q-del',
                    type: 'single',
                    question: '删除后保留?',
                    options: [
                      { label: 'Yes', value: 'A' },
                      { label: 'No', value: 'B' },
                    ],
                    answer: ['A'],
                    points: 1,
                  },
                  {
                    id: 'q-grade',
                    type: 'short_answer',
                    question: 'Explain retention.',
                    commentPrompt: 'Explain',
                    hasAnswer: true,
                    points: 1,
                  },
                ],
              },
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
      }, stageId);

      // CLASSROOM: real wrong answer through the real quiz UI; grading is
      // unavailable under the default AI mock, then Retry grading recovers.
      await page.goto(`${base}/classroom/${stageId}`);
      await page.getByRole('button', { name: 'Start Quiz' }).click();
      await page.getByRole('button', { name: /No/i }).first().click();
      await page.getByRole('textbox').first().fill('because');
      await page.getByRole('button', { name: 'Submit Answers' }).click();
      await expect(page.getByText('Quiz Report')).toBeVisible({ timeout: 15_000 });
      // The short-answer verdict needs AI grading: unavailable under the
      // default mock, the question stays UNDECIDED and Retry grading shows.
      await expect(page.getByText('ungraded').first()).toBeVisible({ timeout: 20_000 });
      await page.route('**/api/quiz-grade', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ score: 0, comment: 'No.' }),
        }),
      );
      await page.getByRole('button', { name: 'Retry grading' }).click();
      await expect
        .poll(
          async () =>
            page
              .evaluate(async (url) => {
                const response = await fetch(`${url}/api/mistakes?count=unmastered`);
                const body = (await response.json()) as { data?: { count?: number } };
                return body.data?.count ?? 0;
              }, base)
              .catch(() => 0),
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(2); // the single AND the regraded short answer

      // DELETE THE COURSE through the real agent-gated route.
      const deleted = await page.evaluate(
        async ({ url, id }) => {
          const response = await fetch(`${url}/api/stages/${id}`, { method: 'DELETE' });
          return response.status;
        },
        { url: base, id: stageId },
      );
      expect(deleted).toBe(200);
      const stageAfter = await page.evaluate(
        async ({ url, id }) => {
          const response = await fetch(`${url}/api/stages/${id}`);
          return response.status;
        },
        { url: base, id: stageId },
      );
      expect(stageAfter).toBe(404);

      // The wrong record SURVIVES with its authority; the real page renders it.
      const kept = await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/mistakes?filter=all`);
        const body = (await response.json()) as {
          data?: { mistakes?: Array<Record<string, unknown>> };
        };
        return body.data?.mistakes ?? [];
      }, base);
      const row = kept.find((candidate) => candidate.questionId === 'q-del');
      expect(row).toMatchObject({ stageId, wrongCount: 1 });

      await page.goto(`${base}/mistake-book`);
      await expect(page.getByText('删除后保留?').first()).toBeVisible({ timeout: 15_000 });
    } finally {
      if (stageId) {
        await page
          .evaluate(
            async ({ url, id }) => {
              await fetch(`${url}/api/stages/${id}`, { method: 'DELETE' });
              await fetch(`${url}/api/mistakes`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ all: true }),
              });
            },
            { url: base, id: stageId },
          )
          .catch(() => undefined);
      }
      await page.context().close();
    }
  });
});
