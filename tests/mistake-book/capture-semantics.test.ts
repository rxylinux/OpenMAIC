/**
 * C final-review tests: per-submission capture semantics (six states),
 * length-safe event ids, >100 chunking, echo-strict identity, atomic claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { encodeEventId, questionEventId } from '@/lib/mistake-book/client';

async function freshModules() {
  vi.resetModules();
  const outbox = await import('@/lib/mistake-book/outbox');
  const client = await import('@/lib/mistake-book/client');
  return { outbox, client };
}

function payload(eventIds: string[]) {
  return {
    stageId: 's1',
    stageName: '课',
    sceneId: 'sc1',
    eventId: eventIds[0],
    items: eventIds.map((eventId) => ({
      eventId,
      questionId: eventId,
      questionType: 'single' as const,
      question: 'q',
      userAnswer: 'A',
    })),
  };
}

const ok = (owner = 'owner-a', extra: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'x-owner-id': owner, ...extra }),
  json: async () => ({ success: true, data: { count: 0, mistakes: [] } }),
});

describe('event id encoding (length-safe, delimiter-unambiguous)', () => {
  it('parts containing separators cannot collide', () => {
    const a = encodeEventId(['a#b', 'c']);
    const b = encodeEventId(['a', 'b#c']);
    expect(a).not.toBe(b);
    expect(questionEventId('att~x', 'q~y')).not.toBe(questionEventId('att', 'x~q~y'));
  });

  it('legal long ids stay within the API budget and stay distinct', () => {
    const long = 'x'.repeat(120);
    const ids = new Set(
      Array.from({ length: 200 }, (_, i) => encodeEventId([long, long, `q${i}`])),
    );
    expect(ids.size).toBe(200); // distinct under the 64-bit fingerprint
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(256);
  });
});

describe('capture submission semantics (six states)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('first online capture bootstraps identity via the bounded probe and uploads', async () => {
    const { outbox, client } = await freshModules();
    expect(outbox.currentConfirmedOwner()).toBe(''); // no seeded identity
    // probe (count echo) → enqueue → flush probe → POST, all echo owner-a
    mocks.fetchMock
      .mockResolvedValueOnce(ok()) // bootstrap probe
      .mockResolvedValueOnce(ok()) // flush probe
      .mockResolvedValueOnce(ok());
    const result = await client.captureMistakesFromQuiz(payload(['e1']));
    expect(result).toMatchObject({ status: 'uploaded', uploaded: ['e1'] });
    expect(outbox.currentConfirmedOwner()).toBe('owner-a');
    const post = mocks.fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as {
      expectedOwnerId: string;
    };
    expect(body.expectedOwnerId).toBe('owner-a'); // identity carried, server-guarded
  });

  it('ALL local enqueues failing → local-failed (never a fake success)', async () => {
    const { client } = await freshModules();
    mocks.fetchMock.mockResolvedValue(ok());
    const brokenIdb = {
      open: () => {
        throw new Error('quota exceeded');
      },
    };
    vi.stubGlobal('indexedDB', brokenIdb);
    const result = await client.captureMistakesFromQuiz(payload(['e2']));
    expect(result.status).toBe('local-failed');
    expect(result.uploaded).toEqual([]);
  });

  it('an OLD parked event uploading must NOT read as this submission uploaded', async () => {
    const { outbox, client } = await freshModules();
    // Seed an old event under owner-a (enqueue while A is confirmed).
    mocks.fetchMock.mockResolvedValue(ok('owner-b')); // later probes confirm B
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload(['evt-old']));
    // Identity switches to B (cookie change) BEFORE this capture: its event
    // enqueues bound to B, the flush probe confirms B, B's event uploads —
    // and A's old event parks. This call's verdict reflects ONLY its own
    // event set; the old event's fate belongs to the queue status.
    outbox.observeOwner('owner-b');
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-b')) // flush probe
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-owner-id': 'owner-b' }),
        json: async () => ({ success: true, data: { captured: 1 } }),
      } as Response);
    const result = await client.captureMistakesFromQuiz(payload(['e3']));
    expect(result.status).toBe('uploaded');
    expect(result.uploaded).toEqual(['e3']); // exactly this submission's set
    const status = await outbox.outboxStatus();
    expect(status.parked).toBe(1); // A's old event still parked, recoverable
  });

  it('identity switch mid-capture → parked (this submission not uploaded, recoverable)', async () => {
    const { client } = await freshModules();
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-a')) // bootstrap confirms A
      .mockResolvedValueOnce(ok('owner-a')) // flush probe confirms A
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        headers: new Headers({ 'x-owner-id': 'owner-b' }),
        json: async () => ({ errorCode: 'OWNER_MISMATCH' }),
      } as Response);
    const result = await client.captureMistakesFromQuiz(payload(['e4']));
    expect(result.status).toBe('parked');
    expect(result.uploaded).toEqual([]);
  });

  it('no echo on the probe → identity NOT confirmed; events enqueue unbound→unbound verdict', async () => {
    const { outbox, client } = await freshModules();
    mocks.fetchMock
      .mockResolvedValueOnce(
        {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ success: true, data: { count: 0 } }),
        } as Response, // no x-owner-id
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ success: true, data: { mistakes: [] } }),
      } as Response);
    const result = await client.captureMistakesFromQuiz(payload(['e5']));
    // Persist-first: the event is DURABLY unbound (claimable later) — an
    // honest unbound, not a network-unknown (nothing was lost).
    expect(['unbound', 'network-unknown']).toContain(result.status);
    const status = await outbox.outboxStatus();
    expect(status.unbound).toBe(1); // durable unbound, not lost
    expect(outbox.currentConfirmedOwner()).toBe(''); // cache NOT polluted
  });

  it('unconfigured deployment → unconfigured (never "stored")', async () => {
    const { client } = await freshModules();
    mocks.fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
    } as Response);
    const result = await client.captureMistakesFromQuiz(payload(['e6']));
    expect(result.status).toBe('unconfigured');
  });

  it('>100 questions chunk into confirmable batches (no silent loss)', async ({}) => {
    const { client } = await freshModules();
    const eventIds = Array.from({ length: 250 }, (_, i) => `q${i}`);
    const postBodies: Array<string> = [];
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        postBodies.push(String(init!.body));
        return ok();
      }
      return ok();
    });
    const result = await client.captureMistakesFromQuiz(payload(eventIds));
    expect(result.status).toBe('uploaded');
    // EVERY question is its own durable event (delivery review #2): all 250
    // upload; a later review adding/reordering questions can never be
    // swallowed by an earlier event's key.
    expect(result.uploaded).toHaveLength(250);
    expect(postBodies.length).toBe(250); // one POST per durable event
    for (const body of postBodies) {
      expect(JSON.parse(body).items.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('atomic claim with target-conflict detection', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset().mockResolvedValue(ok()); // healthy echo default
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('claim NEVER overwrites an existing frozen target that holds DIFFERENT content', async () => {
    const { outbox } = await freshModules();
    // Bound record under owner-a with answer "A" …
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent({
      ...payload(['evt-clash']),
      items: [
        {
          eventId: 'evt-clash',
          questionId: 'evt-clash',
          questionType: 'single',
          question: 'q',
          userAnswer: 'A',
        },
      ],
    });
    // … and an unbound twin with the same eventId but DIFFERENT content.
    vi.resetModules();
    const fresh = await import('@/lib/mistake-book/outbox');
    await fresh.enqueueCaptureEvent({
      ...payload(['evt-clash']),
      items: [
        {
          eventId: 'evt-clash',
          questionId: 'evt-clash',
          questionType: 'single',
          question: 'q',
          userAnswer: 'B',
        },
      ],
    });

    const report = await fresh.claimUnboundEvents();
    expect(report.conflicts).toContain('evt-clash'); // different content → conflict
    expect(report.claimed).toEqual([]);
    // The frozen bound target survives untouched with ITS content.
    const read = await fresh.__readAllForTests();
    const events = read.ok ? read.events : [];
    const bound = events.find((event) => event.key === 'owner-a|evt-clash');
    expect(bound?.payload.items[0]?.userAnswer).toBe('A');
    const unbound = events.find((event) => event.key === '|evt-clash');
    expect(unbound).toBeDefined(); // both kept for explicit handling
  });
});

describe('creation-token binding (delivery addendum)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset().mockResolvedValue(ok('owner-b', { 'x-count': '1' }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an OLD unknown offline event is NOT auto-adopted by a later same-id online capture', async () => {
    // Offline session A: event persists unbound (no owner ever confirmed).
    vi.resetModules();
    const offlineModule = await import('@/lib/mistake-book/outbox');
    mocks.fetchMock.mockResolvedValue(
      { ok: false, status: 503, headers: new Headers() } as Response, // unconfigured world
    );
    const offlineEnqueue = await offlineModule.enqueueCaptureEvent(payload(['evt-dup']));
    expect(offlineEnqueue.kind).toBe('persisted');

    // Online session B (new cookie owner-b) rebuilds the SAME submission:
    // identical content → the REAL old record is REUSED (its handle), never
    // re-persisted, never auto-bound — the old unknown record stays unbound
    // under "|evt-dup" and B's verdict is an explicit unbound (C1 gate #5:
    // 旧unknown仍明确unbound), with ZERO POSTs shipped.
    vi.resetModules();
    const { client, outbox } = await freshModules();
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-b')) // bootstrap probe
      .mockResolvedValueOnce(ok('owner-b')); // flush probe
    const result = await client.captureMistakesFromQuiz(payload(['evt-dup']));
    expect(result.status).toBe('unbound');
    expect(result.uploaded).toEqual([]);

    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0); // nothing was silently attributed to B

    // The old unknown record is still unbound and unadopted.
    const status = await outbox.outboxStatus();
    expect(status.unbound).toBeGreaterThanOrEqual(1);
    const read = await (await import('@/lib/mistake-book/outbox')).__readAllForTests();
    const unbound = read.ok ? read.events.filter((e) => e.owner === '') : [];
    expect(unbound.some((e) => e.eventId === 'evt-dup')).toBe(true);
    // B never materialized a record of its own for this id.
    expect(
      read.ok ? read.events.some((e) => e.owner === 'owner-b' && e.eventId === 'evt-dup') : false,
    ).toBe(false);
  });
});

describe('C1 gates — reuse, local-conflict, handle-correlated verdicts', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('500→200 same-event retransmit PASSES: first attempt 500-queued, second attempt uploads', async () => {
    const { outbox, client } = await freshModules();
    // Identity confirmed while the card list loaded (the mistake-book page
    // observes the owner echo on GET) — the card retry captures bound.
    outbox.observeOwner('owner-a');
    // First capture: identity probe 500 → zero POSTs, event stays queued.
    mocks.fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
    } as Response);
    const first = await client.captureMistakesFromQuiz(payload(['e-rt']));
    expect(['network-unknown', 'parked']).toContain(first.status);
    expect(first.uploaded).toEqual([]);

    // The formal B-card flow: the SAME event retried after recovery — must
    // NOT be reported as a blanket conflict (C1 gate #3).
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-a')) // bootstrap probe
      .mockResolvedValueOnce(ok('owner-a')) // flush probe
      .mockResolvedValueOnce(ok('owner-a')); // POST
    const second = await client.captureMistakesFromQuiz(payload(['e-rt']));
    expect(second).toMatchObject({ status: 'uploaded', uploaded: ['e-rt'] });
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1); // exactly one durable event shipped once
  });

  it('a DIFFERENT payload under the same event id → conflict, and the frozen original is kept', async () => {
    const { outbox, client } = await freshModules();
    outbox.observeOwner('owner-a');
    const original = payload(['e-lc']);
    await outbox.enqueueCaptureEvent(original); // frozen first

    const mutated: typeof original = {
      ...original,
      items: [{ ...original.items[0]!, userAnswer: 'DIFFERENT' }],
    };
    const result = await client.captureMistakesFromQuiz(mutated);
    expect(result.status).toBe('conflict');
    expect(result.uploaded).toEqual([]);
    // The mutation was never persisted and nothing shipped for it.
    expect(
      mocks.fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);

    // The frozen ORIGINAL is still queued and ships verbatim on the next flush.
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-a')) // flush probe
      .mockResolvedValueOnce(ok('owner-a')); // POST
    const report = await outbox.flushOutbox();
    expect(report.uploaded.map((entry) => entry.eventId)).toEqual(['e-lc']);
    const post = mocks.fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as {
      items: Array<{ userAnswer: string }>;
    };
    expect(body.items[0]!.userAnswer).toBe('A');
  });

  it("FORMAL COUNTEREXAMPLE (C1 gate #5): another session's same-id upload must NOT read as uploaded", async () => {
    const { outbox, client } = await freshModules();
    // A's OLD event e1 already queued under owner-a …
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload(['e1']));
    // … the module cache now says B, so THIS capture persists B's own record
    // under "owner-b|e1" (persist-first, before any live probe).
    outbox.observeOwner('owner-b');
    // The live probe confirms A (the cookie switched back): the flush ships
    // A's old e1 and parks B's — only eventId-based correlation would call
    // this submission "uploaded"; the handle correlation must not.
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-a')) // bootstrap probe (confirms A)
      .mockResolvedValueOnce(ok('owner-a')) // flush probe (confirms A)
      .mockResolvedValueOnce(ok('owner-a')) // POST — A's old e1 uploads
      .mockResolvedValue(ok('owner-a')); // later status probes
    const result = await client.captureMistakesFromQuiz(payload(['e1']));
    expect(result.status).not.toBe('uploaded');
    expect(result.status).toBe('parked');
    expect(result.uploaded).toEqual([]); // B's record did NOT commit
    const status = await outbox.outboxStatus();
    expect(status.parked).toBe(1); // B's record stays parked, recoverable
  });

  it('mixed submission: one fresh upload + one local-conflict → conflict verdict with the honest partial upload', async () => {
    const { outbox, client } = await freshModules();
    outbox.observeOwner('owner-a');
    // q-conflict already frozen with different content.
    const frozen = payload(['q-conflict']);
    await outbox.enqueueCaptureEvent({
      ...frozen,
      items: [{ ...frozen.items[0]!, userAnswer: 'OLD' }],
    });

    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-a')) // bootstrap probe
      .mockResolvedValueOnce(ok('owner-a')) // flush probe
      .mockResolvedValueOnce(ok('owner-a')) // POST — frozen originals ship
      .mockResolvedValueOnce(ok('owner-a'));
    const result = await client.captureMistakesFromQuiz(payload(['q-fresh', 'q-conflict']));
    expect(result.status).toBe('conflict'); // the colliding question is permanent
    expect(result.uploaded).toEqual(['q-fresh']); // honest partial: only the fresh record committed
    const status = await outbox.outboxStatus();
    expect(status.pending + status.failed).toBe(0); // frozen original uploaded & dequeued
  });

  it('a quarantined (server-rejected) record reused by content → conflict verdict, never retried', async () => {
    const { outbox, client } = await freshModules();
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload(['e-rej']));
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-a')) // flush probe (direct flush, no client probe)
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        headers: new Headers({ 'x-owner-id': 'owner-a' }),
        json: async () => ({ errorCode: 'EVENT_PAYLOAD_CONFLICT' }),
      } as Response);
    await outbox.flushOutbox(); // quarantines the record

    // Same content re-captured: reuse must surface the record's verdict.
    mocks.fetchMock.mockResolvedValue(ok('owner-a')); // probes only — nothing left to POST
    const result = await client.captureMistakesFromQuiz(payload(['e-rej']));
    expect(result.status).toBe('conflict');
    expect(result.uploaded).toEqual([]);
  });

  it('PHASED capture-gap: review durable with phase-1 enqueue failed → re-capture on the SAME identity recovers exactly once', async () => {
    const { outbox, client } = await freshModules();
    outbox.observeOwner('owner-a');
    // Phase 1 (localOnly) with the SECOND enqueue aborted: q1 durable, q2 not.
    // Emulate by aborting one outbox put via a one-shot wrapper.
    const base = new IDBFactory();
    vi.stubGlobal('indexedDB', base);
    const realOpen = base.open.bind(base);
    let putCount = 0;
    let abortAfter = -1; // abort the put whose 1-based index equals this
    vi.stubGlobal('indexedDB', {
      open: (...args: unknown[]) => {
        const request = realOpen(...(args as [string, number?]));
        request.addEventListener('success', () => {
          const db = request.result as IDBDatabase;
          const realTransaction = db.transaction.bind(db);
          (db as unknown as Record<string, unknown>)['transaction'] = (
            stores: string | string[],
            mode?: IDBTransactionMode,
          ) => {
            const tx = realTransaction(stores, mode);
            if (mode === 'readwrite') {
              const realObjectStore = tx.objectStore.bind(tx);
              (tx as unknown as Record<string, unknown>)['objectStore'] = (name: string) => {
                const store = realObjectStore(name);
                if (name === 'events') {
                  const realPut = store.put.bind(store);
                  (store as unknown as Record<string, unknown>)['put'] = (...a: unknown[]) => {
                    const r = (realPut as (...x: unknown[]) => IDBRequest)(...a);
                    putCount += 1;
                    if (abortAfter !== -1 && putCount === abortAfter) {
                      r.addEventListener('success', () => tx.abort(), { once: true });
                    }
                    return r;
                  };
                }
                return store;
              };
            }
            return tx;
          };
        });
        return request;
      },
    } as unknown as IDBFactory);
    const phased = await freshModules();
    phased.outbox.observeOwner('owner-a');
    const events = phased.client.captureMistakesFromQuiz;
    // Two wrong questions: the SECOND enqueue aborts.
    let secondEnqueueAborted = false;
    const origImport = events;
    void origImport;
    // Simulate the phase-1 gap directly: enqueue q1, let q2 abort via wrapper.
    const payloadQ1 = {
      ...payload(['evt-gap-1']),
      items: [
        {
          eventId: 'evt-gap-1',
          questionId: 'evt-gap-1',
          questionType: 'single' as const,
          question: 'q',
          userAnswer: 'A',
        },
      ],
    };
    const payloadQ2 = {
      ...payload(['evt-gap-2']),
      items: [
        {
          eventId: 'evt-gap-2',
          questionId: 'evt-gap-2',
          questionType: 'single' as const,
          question: 'q',
          userAnswer: 'A',
        },
      ],
    };
    const o1 = await phased.outbox.enqueueCaptureEvent(payloadQ1 as never);
    expect(o1.kind).toBe('persisted'); // put #1 committed
    abortAfter = putCount + 1; // the NEXT put (q2's enqueue) aborts late
    const o2 = await phased.outbox.enqueueCaptureEvent(payloadQ2 as never);
    expect(o2.kind).toBe('local-write-failed'); // q2's enqueue aborted
    secondEnqueueAborted = o2.kind === 'local-write-failed';
    expect(secondEnqueueAborted).toBe(true);
    abortAfter = -1;

    // The recovery (hydration path) re-runs the SAME payload for q2 only:
    // same event id/content → exactly one record, one POST, one count.
    mocks.fetchMock.mockResolvedValue(ok('owner-a'));
    const recovery = await phased.client.captureMistakesFromQuiz(payloadQ2 as never);
    expect(recovery.status).toBe('uploaded');
    // Both questions ended durably committed: evidence exists for each id
    // (records uploaded → receipts), and exactly ONE POST per question.
    const outbox2 = phased.outbox;
    for (const id of ['evt-gap-1', 'evt-gap-2']) {
      // Strict structured evidence (P3): a committed receipt row still
      // exists for the event under SOME owner — check by direct suffix scan
      // of the bounded receipt store keys (test-side, strict: key ends with
      // the event id).
      const read = await outbox2.__readAllForTests?.();
      expect(read?.ok ?? false).toBe(true);
      const receiptScan = await new Promise<boolean>((resolve, reject) => {
        // Versionless open: the schema is at v3 (bindings store) since P3-r1;
        // pinning an old version would itself throw VersionError.
        const open = indexedDB.open('MAIC-mistake-outbox');
        open.onsuccess = () => {
          const db = open.result;
          try {
            const tx = db.transaction('receipts', 'readonly');
            const request = tx.objectStore('receipts').getAllKeys();
            request.onsuccess = () => {
              const keys = (request.result ?? []) as IDBValidKey[];
              resolve(keys.some((key) => String(key).endsWith('|' + id)));
            };
            tx.oncomplete = () => db.close();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          } catch (error) {
            reject(error);
          }
        };
        open.onerror = () => reject(open.error);
      });
      expect(receiptScan).toBe(true);
    }
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(2); // one per question, single business count each
    const bodies = posts.map((post) => (post[1] as RequestInit).body as string);
    expect(bodies.some((body) => body.includes('evt-gap-1'))).toBe(true);
    expect(bodies.some((body) => body.includes('evt-gap-2'))).toBe(true);
    void client;
  });

  it('LEGACY v1 token-less reuse: real 200 confirms via the createdAt receipt; a DIFFERENT instance never borrows it', async () => {
    const { outbox, client } = await freshModules();
    outbox.observeOwner('owner-a');
    // Seed a legacy v1 BOUND record (no creationToken) at owner-a|evt-v1.
    const legacyCreatedAt = Date.now() - 120_000;
    await outbox.__seedLegacyRecordForTests?.({
      key: 'owner-a|evt-legacy-v1',
      eventId: 'evt-legacy-v1',
      owner: 'owner-a',
      createdAt: legacyCreatedAt,
      payload: payload(['evt-legacy-v1']) as never,
    });
    // Same-content capture reuses the legacy record; its POST succeeds.
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return ok('owner-a') as Response;
      }
      return ok('owner-a') as Response;
    });
    const result = await client.captureMistakesFromQuiz(payload(['evt-legacy-v1']));
    expect(result.status).toBe('uploaded'); // HTTP + receipt(createdAt) confirmed
    expect(result.questions[0]!.recordToken).toBeUndefined(); // recognition only
    expect(result.questions[0]!.recordCreatedAt).toBe(legacyCreatedAt);

    // A DIFFERENT legacy instance (new createdAt) at the same key cannot
    // borrow the earlier receipt: fail-closed identity.
    const { outbox: o2 } = await freshModules();
    o2.observeOwner('owner-a');
    await o2.__seedLegacyRecordForTests?.({
      key: 'owner-a|evt-legacy-v2',
      eventId: 'evt-legacy-v2',
      owner: 'owner-a',
      createdAt: legacyCreatedAt + 5_000,
      payload: payload(['evt-legacy-v2']) as never,
    });
    const wrong = await o2.readReceipts([
      {
        key: 'owner-a|evt-legacy-v2',
        fingerprint: (await import('@/lib/mistake-book/outbox')).fingerprintOf(
          payload(['evt-legacy-v2']) as never,
        ),
        recordToken: null,
        createdAt: legacyCreatedAt, // the EARLIER instance's createdAt
      },
    ]);
    expect(wrong.ok ? wrong.matched.length : -1).toBe(0); // different instance: no borrow
  });

  it('FLUSH-ENTRY identity barrier: held A-200 released after a newer B re-enqueued — B is NOT misreported uploaded', async () => {
    // Round 0: module cache confirms owner-a; the first capture's POST hangs.
    const first = await freshModules();
    first.outbox.observeOwner('owner-a');
    let releaseA: (() => void) | null = null;
    let aHeld = false;
    let aReached: (() => void) | null = null;
    const aReachedPromise = new Promise<void>((resolve) => {
      aReached = resolve;
    });
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        if (!aHeld) {
          aHeld = true;
          aReached!();
          await new Promise<void>((resolve) => {
            releaseA = resolve;
          });
        }
        return ok('owner-a') as Response;
      }
      return ok('owner-a') as Response;
    });
    const captureA = first.client.captureMistakesFromQuiz(payload(['evt-fe']));
    await aReachedPromise; // A is durably enqueued and its POST is held

    // While A hangs, an independent module commits and deletes A…
    vi.resetModules();
    const second = await freshModules();
    second.outbox.observeOwner('owner-a');
    const flushB = await second.outbox.flushOutbox();
    expect(flushB.uploaded.map((entry) => entry.eventId)).toEqual(['evt-fe']);
    // …and a NEW token B re-enqueues at the freed key (same content).
    const captureBSetup = await second.outbox.enqueueCaptureEvent(payload(['evt-fe']));
    expect(captureBSetup.kind).toBe('persisted');

    // Release A's 200: A's instance legitimately confirmed.
    releaseA!();
    const resultA = await captureA;
    expect(resultA.status).toBe('uploaded'); // A's own instance honestly confirmed

    // B's own delivery FAILS (500): only a key-only consumer could then
    // borrow A's verdict/receipt — full identity must keep B honestly queued.
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ 'x-owner-id': 'owner-a' }),
        } as Response;
      }
      return ok('owner-a') as Response;
    });
    const roundB = await second.client.captureMistakesFromQuiz(payload(['evt-fe']));
    expect(roundB.uploaded).toEqual([]); // B never borrowed A's 200
    expect(roundB.status).toBe('network-unknown'); // durable, unconfirmed
    expect(roundB.questions[0]!.state).toBe('queued'); // honest durable state
  });

  it('TOKEN plane counter: an old receipt cannot confirm a NEW same-content record instance even while queued (POST 500)', async () => {
    // Round 1 under owner-a commits record instance 1 (receipt written).
    const first = await freshModules();
    first.outbox.observeOwner('owner-a');
    mocks.fetchMock.mockResolvedValue(ok('owner-a'));
    const round1 = await first.client.captureMistakesFromQuiz(payload(['evt-token']));
    expect(round1.status).toBe('uploaded');

    // Round 2: same owner, same content — a NEW record instance enqueues
    // (fresh creation token) and its POST fails 500. Even though it is
    // 'queued' (identity-consistent, the old filter would allow it), the
    // receipt belongs to a DIFFERENT instance: no confirmation.
    vi.resetModules();
    const second = await freshModules();
    second.outbox.observeOwner('owner-a');
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ 'x-owner-id': 'owner-a' }),
        } as Response;
      }
      return ok('owner-a') as Response;
    });
    const round2 = await second.client.captureMistakesFromQuiz(payload(['evt-token']));
    expect(round2.status).toBe('network-unknown'); // durable, NOT uploaded
    expect(round2.uploaded).toEqual([]);
    expect(round2.questions[0]!.state).toBe('queued'); // honest durable state
  });

  it('PROBE-UNKNOWN counter: with the identity unconfirmable, receipts are not even consulted', async () => {
    const first = await freshModules();
    first.outbox.observeOwner('owner-a');
    mocks.fetchMock.mockResolvedValue(ok('owner-a'));
    await first.client.captureMistakesFromQuiz(payload(['evt-probe']));
    // Same content again with the probe DOWN: enqueue reuses nothing (the
    // record was deleted), persists a new instance, and the flush returns an
    // EMPTY report (probe offline) — no receipt consultation may turn that
    // into uploaded.
    vi.resetModules();
    const second = await freshModules();
    second.outbox.observeOwner('owner-a');
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return ok('owner-a') as Response;
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) } as Response; // no echo
    });
    const round2 = await second.client.captureMistakesFromQuiz(payload(['evt-probe']));
    expect(round2.status).toBe('network-unknown'); // probe unknown, honest
    expect(round2.uploaded).toEqual([]);
    expect(round2.questions[0]!.state).toBe('queued');
  });

  it('STALE-RECEIPT counter (closing gate #2): an OLD same-key receipt must not confirm a NEW record parked by an identity switch', async () => {
    // Round 1: cache A + server A — the capture commits, its receipt is
    // written and the record deleted.
    const first = await freshModules();
    first.outbox.observeOwner('owner-a');
    let echo = 'owner-a';
    const seen = new Map<string, string>();
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        const body = JSON.parse(String(init!.body)) as {
          expectedOwnerId?: string;
          eventId?: string;
          items: Array<Record<string, unknown>>;
        };
        const eventId = body.eventId ?? '';
        const frozen = JSON.stringify(body.items);
        const key = `${echo}|${eventId}`;
        if (body.expectedOwnerId !== echo) {
          return {
            ok: false,
            status: 409,
            headers: new Headers({ 'x-owner-id': echo }),
            json: async () => ({ errorCode: 'OWNER_MISMATCH' }),
          } as Response;
        }
        if (seen.get(key) === frozen) {
          return ok(echo) as Response; // server dedupe: replay no-op
        }
        seen.set(key, frozen);
        return ok(echo) as Response;
      }
      return ok(echo) as Response;
    });
    const round1 = await first.client.captureMistakesFromQuiz(payload(['evt-stale']));
    expect(round1.status).toBe('uploaded');

    // Round 2: the cookie flipped — the SERVER now answers as owner-b while
    // the module cache still says owner-a. The same content re-captures: a
    // NEW record enqueues under owner-a, and the live flush must PARK it
    // (owner-a !== confirmed owner-b). The round-1 receipt at the very same
    // key with the very same content must NOT flip this new record to
    // uploaded — that would borrow the OLD record's success across the
    // identity switch.
    echo = 'owner-b';
    const second = await freshModules();
    second.outbox.observeOwner('owner-a'); // stale cache, deliberately
    const round2 = await second.client.captureMistakesFromQuiz(payload(['evt-stale']));
    expect(round2.status).toBe('parked'); // identity-guarded, NOT uploaded
    expect(round2.uploaded).toEqual([]);
    expect(round2.questions[0]!.state).toBe('parked');
    // The NEW record is still durably queued for when owner-a returns.
    const queued = await second.outbox.__readAllForTests();
    expect(queued.ok ? queued.events.some((e) => e.key === 'owner-a|evt-stale') : false).toBe(true);

    // Identity back to A: the record uploads as a server-side no-op replay —
    // one business count total across both rounds.
    echo = 'owner-a';
    const third = await second.outbox.flushOutbox();
    expect(third.uploaded.map((entry) => entry.eventId)).toEqual(['evt-stale']);
  });

  it('PER-QUESTION outcomes: one uploaded + one 500 keeps both truths; pendingKeys track only the unfinished handle', async () => {
    const { outbox, client } = await freshModules();
    outbox.observeOwner('owner-a');
    // q-half1 uploads; q-half2's POST answers 500 (transient — stays queued).
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        const body = JSON.parse(String(init!.body)) as { eventId: string };
        return body.eventId.includes('q-half1')
          ? (ok('owner-a') as Response)
          : ({
              ok: false,
              status: 500,
              headers: new Headers({ 'x-owner-id': 'owner-a' }),
            } as Response);
      }
      return ok('owner-a');
    });
    const result = await client.captureMistakesFromQuiz(payload(['q-half1', 'q-half2']));
    // Overall: a partial commit is NOT "uploaded"…
    expect(result.status).toBe('parked');
    expect(result.uploaded).toEqual(['q-half1']);
    // …and the per-question truth keeps BOTH states with real handles.
    expect(result.questions).toHaveLength(2);
    const uploaded = result.questions.find((q) => q.questionId === 'q-half1')!;
    const queued = result.questions.find((q) => q.questionId === 'q-half2')!;
    expect(uploaded.state).toBe('uploaded');
    expect(queued.state).toBe('queued');
    expect(uploaded.handle).toMatch(/owner-a\|/);
    expect(queued.handle).toMatch(/owner-a\|/);
    // Only the unfinished handle is pending — a lifecycle flush must confirm
    // exactly it before anyone calls the submission uploaded.
    expect(result.pendingKeys).toEqual([queued.handle]);
  });

  it("bind refused by a DIFFERENT-content target → conflict verdict; the old record's upload is not this submission's", async () => {
    // An owner-a record with answer "OLD" is already frozen under evt-bc.
    const first = await freshModules();
    first.outbox.observeOwner('owner-a');
    await first.outbox.enqueueCaptureEvent({
      ...payload(['evt-bc']),
      items: [
        {
          eventId: 'evt-bc',
          questionId: 'evt-bc',
          questionType: 'single',
          question: 'q',
          userAnswer: 'OLD',
        },
      ],
    });

    // THIS submission (answer "A") runs before any identity is confirmed in
    // its module → persists unbound; the live probe then confirms owner-a,
    // but the bind is refused by the different-content target — an explicit
    // conflict, never a silent unbound, and never the old record's success.
    const second = await freshModules();
    mocks.fetchMock
      .mockResolvedValueOnce(ok('owner-a')) // bootstrap probe
      .mockResolvedValueOnce(ok('owner-a')) // flush probe
      .mockResolvedValueOnce(ok('owner-a')); // POST — the OLD record uploads
    const result = await second.client.captureMistakesFromQuiz(payload(['evt-bc']));
    expect(result.status).toBe('conflict');
    expect(result.uploaded).toEqual([]); // the OLD record's upload is NOT mine
    const status = await second.outbox.outboxStatus();
    expect(status.unbound).toBe(1); // this submission's record stays unbound
  });
});
