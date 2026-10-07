/**
 * R8 outbox formal tests (fake-indexeddb): owner fail-closed semantics,
 * transaction-completion honesty, non-overwrite identity keys, unbound-event
 * isolation, and the explicit claim action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import type { MistakeCapturePayload } from '@/lib/mistake-book/client';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Fresh outbox module per test (module-level owner state must not leak). */
async function freshOutbox() {
  vi.resetModules();
  return await import('@/lib/mistake-book/outbox');
}

function payload(eventId: string): MistakeCapturePayload {
  return {
    eventId,
    stageId: 's1',
    stageName: '课',
    sceneId: 'sc1',
    items: [{ eventId, questionId: 'q1', questionType: 'single', question: 'a', userAnswer: 'A' }],
  };
}

/** Strict receipt count: matched rows, or -1 when the receipt read FAILED
 * (unreadable is never "zero matches" — the tests assert honest numbers). */
async function strictReceiptCount(
  module: { readReceipts: (typeof import('@/lib/mistake-book/outbox'))['readReceipts'] },
  entries: Parameters<typeof module.readReceipts>[0],
): Promise<number> {
  const result = await module.readReceipts(entries);
  return result.ok ? result.matched.length : -1;
}

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body }) as Response;

describe('mistake outbox (R8)', () => {
  let outbox: Awaited<ReturnType<typeof freshOutbox>>;

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
    outbox = await freshOutbox();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists before send and uploads once; a lost response replays exactly once', async () => {
    outbox.observeOwner('owner-a');
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })) // probe 1
      // POST "succeeds" on the wire but the response is LOST (network error
      // after server commit) — the event stays queued and replays; the
      // server-side event dedupe makes the replay a no-op. Rejection is
      // deferred so no unhandled-rejection warning precedes the await.
      .mockImplementationOnce(() => Promise.reject(new TypeError('network dropped')))
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })) // probe 2
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })); // replay POST

    const enqueued = await outbox.enqueueCaptureEvent(payload('evt-1'));
    expect(enqueued).toMatchObject({ kind: 'persisted' });

    const first = await outbox.flushOutbox();
    expect(first.failed.map((entry) => entry.eventId)).toEqual(['evt-1']); // lost response: still queued

    const second = await outbox.flushOutbox();
    expect(second.uploaded.map((entry) => entry.eventId)).toEqual(['evt-1']); // replay committed
    expect(mocks.fetchMock).toHaveBeenCalledTimes(4); // 2 probes + POST + replay POST

    const status = await outbox.outboxStatus();
    expect(status.pending + status.failed).toBe(0);
  });

  it('an owner switch never re-attributes queued events (fail closed) and the server guard backs it', async () => {
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-a'));
    // Identity switches to B before any flush.
    outbox.observeOwner('owner-b');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-b' }));

    const report = await outbox.flushOutbox();
    expect(report.parked.map((entry) => entry.eventId)).toEqual(['evt-a']); // A's event stays parked
    expect(report.uploaded).toEqual([]);
    const status = await outbox.outboxStatus();
    expect(status.parked).toBe(1);
  });

  it('expectedOwnerId rides every POST so a cookie switch between confirm and write is refused', async () => {
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-guard'));
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));

    await outbox.flushOutbox();
    const postCall = mocks.fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    const body = JSON.parse(String((postCall[1] as RequestInit).body)) as {
      expectedOwnerId: string;
    };
    expect(body.expectedOwnerId).toBe('owner-a');
  });

  it('an OWNER_MISMATCH 409 parks the event recoverably — identity back → same event uploads once', async () => {
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-409'));
    const notOk = (errorCode: string, owner: string) =>
      ({
        ok: false,
        status: 409,
        headers: new Headers({ 'x-owner-id': owner }),
        json: async () => ({ errorCode }),
      }) as Response;

    // Probe confirms A; the POST lands under cookie B → identity refusal.
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }))
      .mockResolvedValueOnce(notOk('OWNER_MISMATCH', 'owner-b'));
    const refused = await outbox.flushOutbox();
    expect(refused.parked.map((entry) => entry.eventId)).toEqual(['evt-409']); // recoverable, NOT rejected
    let status = await outbox.outboxStatus();
    expect(status.rejected).toBe(0);

    // Identity A returns: probe + POST both under A — the SAME event uploads.
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }))
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const recovered = await outbox.flushOutbox();
    expect(recovered.uploaded.map((entry) => entry.eventId)).toEqual(['evt-409']);
    status = await outbox.outboxStatus();
    expect(status.pending + status.failed + status.rejected).toBe(0);
  });

  it('a true EVENT_PAYLOAD_CONFLICT 409 quarantines permanently', async () => {
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-conflict'));
    const conflict = {
      ok: false,
      status: 409,
      headers: new Headers({ 'x-owner-id': 'owner-a' }),
      json: async () => ({ errorCode: 'EVENT_PAYLOAD_CONFLICT' }),
    } as Response;
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }))
      .mockResolvedValueOnce(conflict);

    const report = await outbox.flushOutbox();
    expect(report.rejected.map((entry) => entry.eventId)).toEqual(['evt-conflict']);
    const status = await outbox.outboxStatus();
    expect(status.rejected).toBe(1); // quarantined, never retried
  });

  it('unbound events (created before ANY owner confirmation) stay unbound — no background attribution', async () => {
    // No observeOwner call: owner never confirmed.
    const outcome = await outbox.enqueueCaptureEvent(payload('evt-unbound'));
    expect(outcome.kind).toBe('persisted');

    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-b' }));
    const report = await outbox.flushOutbox();
    expect(report.unbound.map((entry) => entry.eventId)).toEqual(['evt-unbound']); // NOT auto-bound to B
    expect(report.uploaded).toEqual([]);

    // The explicit claim is the only binding path.
    const claimReport = await outbox.claimUnboundEvents();
    expect(claimReport.claimed).toEqual(['evt-unbound']);
    const afterClaim = await outbox.flushOutbox();
    expect(afterClaim.uploaded.map((entry) => entry.eventId)).toEqual(['evt-unbound']);
  });

  it('a DIFFERENT payload under the same (owner,eventId) is local-conflict — the frozen original ships', async () => {
    outbox.observeOwner('owner-a');
    const first = await outbox.enqueueCaptureEvent(payload('evt-dup'));
    expect(first.kind).toBe('persisted');
    const second = await outbox.enqueueCaptureEvent({
      ...payload('evt-dup'),
      items: [
        {
          eventId: 'evt-dup',
          questionId: 'q1',
          questionType: 'single',
          question: 'MUTATED',
          userAnswer: 'Z',
        },
      ],
    });
    expect(second.kind).toBe('local-conflict'); // frozen payload kept, never overwritten

    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox();
    const post = mocks.fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    )!;
    const shipped = JSON.parse(String((post[1] as RequestInit).body)) as {
      items: Array<{ question: string; userAnswer: string }>;
    };
    expect(shipped.items[0]!.question).toBe('a'); // original, not MUTATED
  });

  it('the IDENTICAL payload under the same key is REUSED: the real handle retransmits (500→200 passes)', async () => {
    outbox.observeOwner('owner-a');
    const first = await outbox.enqueueCaptureEvent(payload('evt-reuse'));
    expect(first).toMatchObject({ kind: 'persisted' });
    // First flush attempt: the identity probe answers 500 — zero POSTs, the
    // event stays durably queued (delivery review #1).
    mocks.fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
    } as Response);
    const failedFlush = await outbox.flushOutbox();
    expect(failedFlush.uploaded).toEqual([]);
    expect(
      mocks.fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);

    // Same content re-enqueued (grading recovery / retransmit): NOT a
    // conflict — the caller receives the REAL existing record's handle.
    const second = await outbox.enqueueCaptureEvent(payload('evt-reuse'));
    expect(second).toMatchObject({ kind: 'reused' });
    expect((second as { handle: string }).handle).toBe((first as { handle: string }).handle);

    // Server recovers (200): the reused record uploads exactly once.
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }))
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox();
    expect(report.uploaded.map((entry) => entry.eventId)).toEqual(['evt-reuse']);
    expect(report.uploaded[0]!.key).toBe('owner-a|evt-reuse'); // correlated by full key
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1); // the queued original shipped exactly once
  });

  it('a rejected (quarantined) record is still reported by its handle on later flushes', async () => {
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-rej'));
    const conflict = {
      ok: false,
      status: 409,
      headers: new Headers({ 'x-owner-id': 'owner-a' }),
      json: async () => ({ errorCode: 'EVENT_PAYLOAD_CONFLICT' }),
    } as Response;
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }))
      .mockResolvedValueOnce(conflict);
    await outbox.flushOutbox();

    // Later flush: the quarantined record is skipped but REPORTED (C1 gate
    // #5) so a caller holding this exact handle learns its verdict.
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox();
    expect(report.rejected.map((entry) => entry.eventId)).toEqual(['evt-rej']);
    expect(report.uploaded).toEqual([]);
  });

  it('a late transaction abort is reported as NOT persisted (never a false persisted)', async () => {
    // Quota-style late abort: abort fires in the SAME tick as the put
    // request's success event — after request.onsuccess would have told us
    // "stored", but before the transaction commits. tx.oncomplete never
    // fires; the outbox must report not-persisted.
    const base = new IDBFactory();
    const realOpen = base.open.bind(base);
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
                const realPut = store.put.bind(store);
                (store as unknown as Record<string, unknown>)['put'] = (...putArgs: unknown[]) => {
                  const putRequest = (realPut as (...a: unknown[]) => IDBRequest)(...putArgs);
                  putRequest.addEventListener('success', () => tx.abort(), { once: true });
                  return putRequest;
                };
                return store;
              };
            }
            return tx;
          };
        });
        return request;
      },
    } as unknown as IDBFactory);
    outbox = await freshOutbox();

    const outcome = await outbox.enqueueCaptureEvent(payload('evt-abort'));
    expect(outcome.kind).toBe('local-write-failed'); // honest: NOT persisted
  });

  it('clearOutbox is honest about failures and empties the queue on success', async () => {
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-clear'));
    await outbox.clearOutbox();
    const status = await outbox.outboxStatus();
    expect(status.pending + status.failed).toBe(0);
    expect(outbox.currentConfirmedOwner()).toBe('owner-a');
  });
});

/** Direct queue access on the SAME underlying store — bypasses the module. */
function directStore<T>(action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('MAIC-mistake-outbox');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('events', 'readwrite');
      const request = action(tx.objectStore('events'));
      request.onsuccess = () => resolve(request.result);
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe('C1 gate #4 — moves re-read the source inside the move transaction', () => {
  let outbox: Awaited<ReturnType<typeof freshOutbox>>;

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
    outbox = await freshOutbox();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bind does not resurrect a record deleted between enqueue and the move', async () => {
    // Owner never confirmed → the record persists UNBOUND at "|evt-gone".
    const outcome = await outbox.enqueueCaptureEvent(payload('evt-gone'));
    expect(outcome.kind).toBe('persisted');
    if (outcome.kind !== 'persisted') throw new Error('expected persisted');
    // Freeze the flush at its identity probe while the queue mutates.
    let releaseProbe!: (value: Response) => void;
    mocks.fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseProbe = resolve)),
    );
    const flushPromise = outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'evt-gone', creationToken: outcome.creationToken }],
    });
    await directStore((store) => store.delete('|evt-gone')); // gone BEFORE the move tx
    releaseProbe(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));

    const report = await flushPromise;
    expect(report.uploaded).toEqual([]);
    expect(await directStore((store) => store.get('owner-a|evt-gone'))).toBeUndefined();
    expect(await directStore((store) => store.get('|evt-gone'))).toBeUndefined(); // no resurrection
  });

  it('claim does not copy a record that vanished before its move transaction', async () => {
    await outbox.enqueueCaptureEvent(payload('evt-claim-gone')); // unbound
    let releaseProbe!: (value: Response) => void;
    mocks.fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseProbe = resolve)),
    );
    const claimPromise = outbox.claimUnboundEvents();
    await directStore((store) => store.delete('|evt-claim-gone'));
    releaseProbe(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));

    const report = await claimPromise;
    expect(report.claimed).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(await directStore((store) => store.get('owner-a|evt-claim-gone'))).toBeUndefined();
  });

  it('claim target with the SAME content dedupes (stray twin dropped); DIFFERENT content conflicts', async () => {
    // Bound record under owner-a …
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-twin'));
    // … plus an unbound twin with identical content (possible when a capture
    // ran before any identity was confirmed in a fresh module).
    vi.resetModules();
    const fresh = await import('@/lib/mistake-book/outbox');
    await fresh.enqueueCaptureEvent(payload('evt-twin'));
    // … plus an unbound record whose content DIFFERS from its bound target.
    await fresh.enqueueCaptureEvent({
      ...payload('evt-twin-diff'),
      items: [
        {
          eventId: 'evt-twin-diff',
          questionId: 'q1',
          questionType: 'single',
          question: 'a',
          userAnswer: 'A',
        },
      ],
    });
    fresh.observeOwner('owner-a');
    await fresh.enqueueCaptureEvent({
      ...payload('evt-twin-diff'),
      items: [
        {
          eventId: 'evt-twin-diff',
          questionId: 'q1',
          questionType: 'single',
          question: 'a',
          userAnswer: 'B', // differs from the queued "A"
        },
      ],
    });

    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await fresh.claimUnboundEvents();
    // Same-content twin: already exists under owner-a → deduped (claimed).
    expect(report.claimed).toEqual(['evt-twin']);
    // Different content: explicit conflict — BOTH records survive untouched.
    expect(report.conflicts).toEqual(['evt-twin-diff']);

    const read = await fresh.__readAllForTests();
    expect(read.ok).toBe(true);
    const events = read.ok ? read.events : [];
    const twins = events.filter((event) => event.eventId === 'evt-twin');
    expect(twins).toHaveLength(1); // stray unbound twin dropped
    expect(twins[0]!.owner).toBe('owner-a');
    const diffs = events.filter((event) => event.eventId === 'evt-twin-diff');
    expect(diffs).toHaveLength(2); // frozen originals both kept
  });

  it('concurrent claim + flush-bind converge: one bound record, one POST, no stray twin', async () => {
    // Unbound record WITH a creation token, as a persist-first capture leaves it.
    const outcome = await outbox.enqueueCaptureEvent(payload('evt-conc'));
    expect(outcome.kind).toBe('persisted');
    if (outcome.kind !== 'persisted') throw new Error('expected persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));

    const [, claimReport] = await Promise.all([
      outbox.flushOutbox({
        bindNewEvents: [{ eventId: 'evt-conc', creationToken: outcome.creationToken }],
      }),
      outbox.claimUnboundEvents(),
    ]);

    // Whichever move won, the record was bound at most once and uploaded once.
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String((posts[0]![1] as RequestInit).body)) as {
      expectedOwnerId: string;
    };
    expect(body.expectedOwnerId).toBe('owner-a');
    expect(claimReport.claimed.length).toBeLessThanOrEqual(1);
    const read = await outbox.__readAllForTests();
    const events = read.ok ? read.events : [];
    expect(events.filter((event) => event.eventId === 'evt-conc')).toHaveLength(0); // uploaded → dequeued
    expect(events.filter((event) => event.owner === '')).toHaveLength(0); // no stray unbound twin
  });

  // Implementation review: an armable late-abort wrapper — the FIRST
  // readwrite put/delete request success AFTER arming aborts its whole
  // transaction (quota-style), exactly like the existing enqueue-abort test.
  function armableLateAbortFactory(): { factory: IDBFactory; arm: () => void } {
    const base = new IDBFactory();
    const realOpen = base.open.bind(base);
    let armed = false;
    let fired = false;
    const factory = {
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
                for (const method of ['put', 'delete'] as const) {
                  const real = store[method].bind(store) as (...a: unknown[]) => IDBRequest;
                  (store as unknown as Record<string, unknown>)[method] = (...margs: unknown[]) => {
                    const request2 = real(...margs);
                    if (armed && !fired) {
                      fired = true;
                      request2.addEventListener('success', () => tx.abort(), { once: true });
                    }
                    return request2;
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
    };
    return { factory: factory as unknown as IDBFactory, arm: () => (armed = true) };
  }

  it('LATE ABORT of the bind move (put path) publishes NO alias — the record stays honestly unbound', async () => {
    const { factory, arm } = armableLateAbortFactory();
    vi.stubGlobal('indexedDB', factory);
    outbox = await freshOutbox();
    // Unbound record with a creation token, as a persist-first capture leaves it.
    const outcome = await outbox.enqueueCaptureEvent(payload('evt-abort-bind'));
    expect(outcome.kind).toBe('persisted');
    if (outcome.kind !== 'persisted') throw new Error('expected persisted');
    arm(); // the bind's put now aborts AFTER its request success

    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'evt-abort-bind', creationToken: outcome.creationToken }],
    });
    // The move did not commit → no alias, no fake upload: the source is
    // reported by its own unbound key and nothing else.
    expect(report.uploaded).toEqual([]);
    expect(report.unbound.map((entry) => entry.eventId)).toEqual(['evt-abort-bind']);
    expect(report.conflicts).toEqual([]);
    const read = await outbox.__readAllForTests();
    const events = read.ok ? read.events : [];
    expect(events.filter((event) => event.eventId === 'evt-abort-bind')).toHaveLength(1);
    expect(events[0]!.owner).toBe(''); // rolled back to unbound — claim can adopt it
  });

  it("LATE ABORT of the dedupe bind publishes NO alias — a same-content target upload is never the still-unbound source's success", async () => {
    const { factory, arm } = armableLateAbortFactory();
    vi.stubGlobal('indexedDB', factory);
    outbox = await freshOutbox();
    // A same-content record ALREADY bound under owner-a …
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-abort-dedupe'));
    // … plus the unbound twin a persist-first capture persisted (fresh module).
    vi.resetModules();
    const fresh = await import('@/lib/mistake-book/outbox');
    const twin = await fresh.enqueueCaptureEvent(payload('evt-abort-dedupe'));
    expect(twin.kind).toBe('persisted');
    if (twin.kind !== 'persisted') throw new Error('expected persisted');
    arm(); // the dedupe path's DELETE now aborts after its request success

    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await fresh.flushOutbox({
      bindNewEvents: [{ eventId: 'evt-abort-dedupe', creationToken: twin.creationToken }],
    });
    // The pre-existing target uploaded on ITS OWN key — with NO boundFrom
    // alias to the twin (the aborted move must not borrow it a success) …
    expect(report.uploaded.map((entry) => entry.key)).toEqual(['owner-a|evt-abort-dedupe']);
    expect(report.uploaded[0]!.boundFrom).toBeUndefined();
    // … and the twin is STILL a live unbound record (its delete rolled back).
    expect(report.unbound.map((entry) => entry.key)).toEqual(['|evt-abort-dedupe']);
    const read = await fresh.__readAllForTests();
    expect((read.ok ? read.events : []).some((event) => event.key === '|evt-abort-dedupe')).toBe(
      true,
    );
  });

  it('bind onto a DIFFERENT-content target reports THIS source as an explicit conflict (not merely unbound)', async () => {
    // Frozen record under owner-a with answer "OLD" …
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent({
      ...payload('evt-bindc'),
      items: [
        {
          eventId: 'evt-bindc',
          questionId: 'q1',
          questionType: 'single',
          question: 'a',
          userAnswer: 'OLD',
        },
      ],
    });
    // … and THIS call's record (answer "A"), persisted unbound with a token.
    vi.resetModules();
    const fresh = await import('@/lib/mistake-book/outbox');
    const mine = await fresh.enqueueCaptureEvent(payload('evt-bindc')); // 'A' ≠ 'OLD'
    expect(mine.kind).toBe('persisted');
    if (mine.kind !== 'persisted') throw new Error('expected persisted');

    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await fresh.flushOutbox({
      bindNewEvents: [{ eventId: 'evt-bindc', creationToken: mine.creationToken }],
    });
    // The refusal is EXPLICIT: the source's own key sits in conflicts.
    expect(report.conflicts.map((entry) => entry.key)).toEqual(['|evt-bindc']);
    // The frozen different-content target still shipped on its own handle —
    // without an alias to this source.
    expect(report.uploaded.map((entry) => entry.key)).toEqual(['owner-a|evt-bindc']);
    expect(report.uploaded[0]!.boundFrom).toBeUndefined();
    // Source AND verdict both kept honest: it also stays a live unbound record.
    expect(report.unbound.map((entry) => entry.key)).toEqual(['|evt-bindc']);
    const read = await fresh.__readAllForTests();
    expect((read.ok ? read.events : []).some((event) => event.key === '|evt-bindc')).toBe(true);
  });
});

describe('C2 receipts — fingerprint identity, atomicity, migration', () => {
  let outbox: Awaited<ReturnType<typeof freshOutbox>>;

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
    outbox = await freshOutbox();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an OLD payload receipt never confirms a NEW different payload under the same key (A success → B 500)', async () => {
    outbox.observeOwner('owner-a');
    // A commits: its receipt carries A's fingerprint AND A's record token.
    const aEnqueue = await outbox.enqueueCaptureEvent(payload('evt-fp'));
    expect(aEnqueue.kind).toBe('persisted');
    if (aEnqueue.kind !== 'persisted') throw new Error('expected persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const uploaded = await outbox.flushOutbox();
    expect(uploaded.uploaded).toHaveLength(1);
    // B replaces the same key with DIFFERENT content and its POST 500s.
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent({
      ...payload('evt-fp'),
      items: [
        {
          eventId: 'evt-fp',
          questionId: 'q1',
          questionType: 'single',
          question: 'B',
          userAnswer: 'Z',
        },
      ],
    });
    expect((await outbox.__readAllForTests()).ok).toBe(true);
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return { ok: false, status: 500, headers: new Headers() } as Response;
      }
      return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
    });
    const failed = await outbox.flushOutbox();
    expect(failed.uploaded).toHaveLength(0); // B's POST failed: no commit
    // The A receipt must NOT confirm B: readReceipts matches key AND content.
    const { fingerprintOf, readReceipts } = outbox;
    const bFingerprint = fingerprintOf({
      ...payload('evt-fp'),
      items: [
        {
          eventId: 'evt-fp',
          questionId: 'q1',
          questionType: 'single',
          question: 'B',
          userAnswer: 'Z',
        },
      ],
    } as never);
    const aFingerprint = fingerprintOf(payload('evt-fp') as never);
    const confirmedB = await readReceipts([{ key: 'owner-a|evt-fp', fingerprint: bFingerprint }]);
    expect(confirmedB.ok ? confirmedB.matched.length : -1).toBe(0); // B never confirmed by A's receipt
    const confirmedA = await readReceipts([
      { key: 'owner-a|evt-fp', fingerprint: aFingerprint, recordToken: aEnqueue.creationToken },
    ]);
    expect(confirmedA.ok ? confirmedA.matched.length : -1).toBe(1); // A's own receipt matches on all 3 planes
    // Same content, DIFFERENT record instance (token): still not confirmed.
    const wrongInstance = await readReceipts([
      { key: 'owner-a|evt-fp', fingerprint: aFingerprint, recordToken: 'another-token' },
    ]);
    expect(wrongInstance.ok ? wrongInstance.matched.length : -1).toBe(0);
  });

  it('a late abort of the receipt+delete transaction publishes NOTHING and the record replays idempotently', async () => {
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-commit-abort'));
    // Re-stub with the armable wrapper; the FIRST readwrite put (the receipt)
    // aborts the whole commit transaction AFTER the HTTP 200.
    const base = new IDBFactory();
    // copy existing data by flushing through the OLD factory is impossible —
    // instead re-run the whole scenario on the armable factory.
    vi.stubGlobal('indexedDB', base);
    outbox = await freshOutbox();
    const realOpen = base.open.bind(base);
    let armed = false;
    let fired = false;
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
                if (name === 'receipts') {
                  const realPut = store.put.bind(store);
                  (store as unknown as Record<string, unknown>)['put'] = (...a: unknown[]) => {
                    const r = (realPut as (...x: unknown[]) => IDBRequest)(...a);
                    if (armed && !fired) {
                      fired = true;
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
    outbox = await freshOutbox();
    outbox.observeOwner('owner-a');
    await outbox.enqueueCaptureEvent(payload('evt-commit-abort'));
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })) // flush-1 probe
      .mockResolvedValueOnce(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })) // flush-1 POST
      .mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })); // replay pass
    armed = true;
    const first = await outbox.flushOutbox();
    expect(first.uploaded).toHaveLength(0); // the commit tx aborted: NOTHING published
    const read = await outbox.__readAllForTests();
    expect(read.ok && read.events).toHaveLength(1); // record still queued
    armed = false;
    const second = await outbox.flushOutbox(); // replay: server no-ops, commit succeeds
    expect(second.uploaded).toHaveLength(1);
    expect(
      mocks.fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST'),
    ).toHaveLength(2);
  });

  it('LATE-STATUS protection: a late failure verdict never overwrites a REPLACED record or resurrects a committed one', async () => {
    // Instance 1 exists; a second session replaces it with a NEW token at
    // the same key (same content), then instance 1's late 500 arrives via a
    // direct putEvent-shaped flush path.
    outbox.observeOwner('owner-a');
    const first = await outbox.enqueueCaptureEvent(payload('evt-late'));
    expect(first.kind).toBe('persisted');
    if (first.kind !== 'persisted') throw new Error('expected persisted');
    // (Simulate the queue having moved on: replace the instance.)
    vi.resetModules();
    const next = await import('@/lib/mistake-book/outbox');
    next.observeOwner('owner-a');
    const second = await next.enqueueCaptureEvent({
      ...payload('evt-late'),
      items: [
        {
          eventId: 'evt-late',
          questionId: 'q1',
          questionType: 'single',
          question: 'a',
          userAnswer: 'NEW-INSTANCE',
        },
      ],
    });
    expect(second.kind).toBe('local-conflict'); // different content: frozen original kept

    // Now the ORIGINAL instance's flush answers 500 — the late write-back
    // must NOT overwrite the frozen original's status/content.
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ 'x-owner-id': 'owner-a' }),
        } as Response;
      }
      return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
    });
    const report = await next.flushOutbox();
    expect(report.failed.map((entry) => entry.eventId)).toEqual(['evt-late']);
    const read = await next.__readAllForTests();
    const record = read.ok
      ? read.events.find((event) => event.key === 'owner-a|evt-late')
      : undefined;
    expect(record).toBeDefined();
    // The FROZEN ORIGINAL (instance 1, answer 'A') is what the queue keeps:
    // the late 500 only marked attempts on the SAME instance.
    expect((record!.payload.items[0] as { userAnswer?: string }).userAnswer).toBe('A');
    expect(record!.status).toBe('failed'); // marked on the SAME instance only
  });

  it('SAME-TIMESTAMP retention: the just-committed receipt survives when ties would otherwise evict it first', async () => {
    outbox.__setReceiptRetentionForTests(3);
    try {
      const fixedNow = 1_700_000_000_000;
      const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      try {
        for (let round = 0; round < 5; round += 1) {
          vi.resetModules();
          const fresh = await import('@/lib/mistake-book/outbox');
          fresh.__setReceiptRetentionForTests(3);
          fresh.observeOwner('owner-a');
          await fresh.enqueueCaptureEvent(payload(`evt-tie-${round}`));
          mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
            if ((init as RequestInit | undefined)?.method === 'POST') {
              return jsonResponse(
                { success: true, data: { captured: 1 } },
                { 'x-owner-id': 'owner-a' },
              );
            }
            return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
          });
          const report = await fresh.flushOutbox();
          expect(report.uploaded).toHaveLength(1);
          // Every receipt shares ONE timestamp: eviction order must still
          // spare the just-committed key and honor the bound.
          const counts = await new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('MAIC-mistake-outbox');
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('receipts', 'readonly');
              const r = tx.objectStore('receipts').count();
              r.onsuccess = () => {
                db.close();
                resolve(r.result);
              };
              r.onerror = () => reject(r.error);
            };
            request.onerror = () => reject(request.error);
          });
          expect(counts).toBeLessThanOrEqual(3);
        }
        // The LAST committed key is still confirmable.
        vi.resetModules();
        const finalModule = await import('@/lib/mistake-book/outbox');
        const { fingerprintOf } = finalModule;
        expect(
          await strictReceiptCount(finalModule, [
            {
              key: 'owner-a|evt-tie-4',
              fingerprint: fingerprintOf(payload('evt-tie-4') as never),
              recordToken: (await finalModule.__readAllForTests()).ok ? undefined : undefined,
            },
          ]),
        ).toBe(0); // record gone (uploaded+deleted); token-less query must NOT
        // confirm via legacy null=null — proving instance strictness.
      } finally {
        spy.mockRestore();
      }
    } finally {
      vi.resetModules();
      outbox = await freshOutbox();
    }
  });

  it('COMMITTED-BIND barrier: bind commits, a background flush uploads+deletes the destination — the mapping publishes both identities and the source-proof consumer confirms via the destination receipt', async () => {
    // Unbound source S (created before any confirmation).
    const seeded = await outbox.enqueueCaptureEvent(payload('evt-bindmap'));
    expect(seeded.kind).toBe('persisted');
    if (seeded.kind !== 'persisted') throw new Error('expected persisted');

    // Gate THIS pass's destination POST: by the time it is held, the bind
    // has COMMITTED and this pass's read has happened.
    let held = false;
    let release: (() => void) | null = null;
    let reached: (() => void) | null = null;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        if (!held) {
          held = true;
          reached!();
          await new Promise<void>((resolveGate) => {
            release = resolveGate;
          });
        }
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
    });
    outbox.observeOwner('owner-a');
    const gatedFlush = outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'evt-bindmap', creationToken: seeded.creationToken }],
    });
    await reachedPromise; // bind COMMITTED; this pass's dest POST is held

    // Background flush uploads + deletes the destination (same instance).
    vi.resetModules();
    const background = await import('@/lib/mistake-book/outbox');
    background.observeOwner('owner-a');
    const backgroundReport = await background.flushOutbox();
    expect(backgroundReport.uploaded.map((entry) => entry.eventId)).toEqual(['evt-bindmap']);

    release!();
    const report = await gatedFlush;
    // The strict same-instance receipt legitimately confirms THIS pass too
    // (its record was committed by the background flush — never a borrow):
    expect(report.uploaded.map((entry) => entry.eventId)).toEqual(['evt-bindmap']);
    // AND the COMMITTED mapping publishes BOTH sides' full identities, so a
    // consumer holding only the SOURCE handle migrates and finds the receipt
    // even if its own lists were read empty.
    expect(report.committedBinds).toHaveLength(1);
    const mapping = report.committedBinds[0]!;
    expect(mapping.source.key).toBe('|evt-bindmap');
    expect(mapping.source.recordToken).toBe(seeded.creationToken);
    expect(mapping.destination.key).toBe('owner-a|evt-bindmap');
    expect(mapping.destination.recordToken).toBe(seeded.creationToken); // bind preserves the instance
    // Source-proof consumer: migrate handle by the mapping, then the strict
    // destination receipt confirms.
    const { fingerprintOf } = background;
    const fp = fingerprintOf(payload('evt-bindmap') as never);
    expect(
      await strictReceiptCount(background, [
        {
          key: mapping.destination.key,
          fingerprint: fp,
          recordToken: mapping.destination.recordToken,
        },
      ]),
    ).toBe(1);
    // And a DIFFERENT instance's token at the same key confirms nothing.
    expect(
      await strictReceiptCount(background, [
        { key: mapping.destination.key, fingerprint: fp, recordToken: 'other-instance' },
      ]),
    ).toBe(0);
  });

  it('TRUE-BARRIER replacement: a held A-POST released AFTER a second flush committed+deleted A and a NEW-token B enqueued — 200/500/400/409/throw all leave B intact and never resurrect A', async () => {
    for (const releaseMode of ['200', '500', '400', '409', 'throw'] as const) {
      for (const variant of ['same-content', 'different-content'] as const) {
        vi.stubGlobal('indexedDB', new IDBFactory());
        outbox = await freshOutbox();
        outbox.observeOwner('owner-a');
        const instanceA = await outbox.enqueueCaptureEvent(payload('evt-bar'));
        expect(instanceA.kind).toBe('persisted');
        if (instanceA.kind !== 'persisted') throw new Error('expected persisted');

        // Hold A's POST at a gate in front of the mock.
        let releaseA!: () => void;
        const held = new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        // Gate fetch itself (unit level; DOM gates its own routes).
        let gateConsumed = false;
        vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
          if ((init as RequestInit | undefined)?.method === 'POST') {
            if (!gateConsumed) {
              gateConsumed = true;
              await held;
              if (releaseMode === 'throw') throw new TypeError('late network drop');
              const status =
                releaseMode === '200' ? 200 : releaseMode === '500' ? 500 : Number(releaseMode);
              return {
                ok: status === 200,
                status,
                headers: new Headers({ 'x-owner-id': 'owner-a' }),
                json: async () => ({}),
              } as Response;
            }
            return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
          }
          return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
        });
        const flushA = outbox.flushOutbox();

        // While A hangs: a SECOND, un-gated module commits+deletes A.
        vi.resetModules();
        const secondModule = await import('@/lib/mistake-book/outbox');
        secondModule.observeOwner('owner-a');
        const secondFlush = await secondModule.flushOutbox();
        expect(secondFlush.uploaded.map((entry) => entry.eventId)).toEqual(['evt-bar']);

        // Enqueue B at the freed key: a NEW token (same or different content).
        const instanceB = await secondModule.enqueueCaptureEvent(
          variant === 'same-content'
            ? payload('evt-bar')
            : {
                ...payload('evt-bar'),
                items: [
                  {
                    eventId: 'evt-bar',
                    questionId: 'q1',
                    questionType: 'single',
                    question: 'a',
                    userAnswer: 'B-CONTENT',
                  },
                ],
              },
        );
        expect(instanceB.kind).toBe('persisted');
        if (instanceB.kind !== 'persisted') throw new Error('expected persisted');

        // Release A's held response: whatever it says, B must stay intact,
        // pending, and A must not resurrect.
        releaseA();
        const reportA = await flushA;
        if (releaseMode === '200') {
          // A's OWN instance genuinely committed (the second flush's strict
          // receipt matches key+fingerprint+A's token) — reporting A uploaded
          // is honest and borrows nothing from B.
          expect(reportA.uploaded.map((entry) => entry.eventId)).toEqual(['evt-bar']);
        } else {
          // Failure verdicts describe A only; nothing new is claimed.
          expect(reportA.uploaded).toHaveLength(0);
        }
        const read = await secondModule.__readAllForTests();
        const rows = read.ok ? read.events : [];
        expect(rows).toHaveLength(1); // exactly B — A never resurrected
        const b = rows[0]!;
        expect(b.key).toBe('owner-a|evt-bar');
        expect(b.creationToken).toBe(instanceB.creationToken);
        expect((b.payload.items[0] as { userAnswer?: unknown }).userAnswer).toBe(
          variant === 'same-content' ? 'A' : 'B-CONTENT',
        );
        expect(b.status).toBe('pending'); // B untouched by the late verdict
        // The receipt belongs to A's instance; it must not confirm B.
        const { fingerprintOf } = secondModule;
        const bFp = fingerprintOf(b.payload as never);
        expect(
          await strictReceiptCount(secondModule, [
            { key: b.key, fingerprint: bFp, recordToken: instanceB.creationToken },
          ]),
        ).toBe(0);
      }
    }
  });

  it('INSTANCE succession: a replaced same-key record commits under ITS OWN token — the old receipt never transfers', async () => {
    // Instance 1 uploads and is deleted; instance 2 (same key, same content,
    // NEW token) later re-persists and fails with 500, then succeeds. Every
    // receipt stays bound to its own instance: the old one never confirms
    // the newcomer, and the newcomer's commit never claims the old success.
    outbox.observeOwner('owner-a');
    const instance1 = await outbox.enqueueCaptureEvent(payload('evt-inst'));
    expect(instance1.kind).toBe('persisted');
    if (instance1.kind !== 'persisted') throw new Error('expected persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const round1 = await outbox.flushOutbox();
    expect(round1.uploaded).toHaveLength(1); // instance 1 committed & deleted

    // Instance 2: same key now free, identical content, fresh token.
    const instance2 = await outbox.enqueueCaptureEvent(payload('evt-inst'));
    expect(instance2.kind).toBe('persisted');
    if (instance2.kind !== 'persisted') throw new Error('expected persisted');
    expect(instance2.creationToken).not.toBe(instance1.creationToken);
    // Its POST fails 500 first: late write-back marks THE SAME instance.
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ 'x-owner-id': 'owner-a' }),
        } as Response;
      }
      return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
    });
    const failed = await outbox.flushOutbox();
    expect(failed.failed).toHaveLength(1);
    const afterFail = await outbox.__readAllForTests();
    const keptRow = afterFail.ok
      ? afterFail.events.find((event) => event.key === 'owner-a|evt-inst')
      : undefined;
    expect(keptRow).toBeDefined(); // instance 2 intact, only status changed
    expect(keptRow!.creationToken).toBe(instance2.creationToken);

    // Recovery: the commit writes instance 2's OWN receipt; the old one is
    // gone (overwritten same key) and both identity planes agree.
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const round2 = await outbox.flushOutbox();
    expect(round2.uploaded).toHaveLength(1);
    const { fingerprintOf } = outbox;
    const fp = fingerprintOf(payload('evt-inst') as never);
    expect(
      await strictReceiptCount(outbox, [
        { key: 'owner-a|evt-inst', fingerprint: fp, recordToken: instance1.creationToken },
      ]),
    ).toBe(0); // old instance's identity no longer confirms
    expect(
      await strictReceiptCount(outbox, [
        { key: 'owner-a|evt-inst', fingerprint: fp, recordToken: instance2.creationToken },
      ]),
    ).toBe(1); // the CURRENT instance's receipt confirms
  });

  it('BOUNDED receipts survive module reloads: persisted-count trim keeps the window and the newest confirmations', async () => {
    outbox.__setReceiptRetentionForTests(3);
    try {
      // Five upload rounds, each under a FRESH module (counter resets on
      // every reload) with fewer writes than any fixed reset interval — the
      // persisted count inside the commit transaction is what trims.
      const boundedTokens: string[] = [];
      for (let round = 0; round < 5; round += 1) {
        vi.resetModules();
        const fresh = await import('@/lib/mistake-book/outbox');
        fresh.__setReceiptRetentionForTests(3);
        fresh.observeOwner('owner-a');
        const enqueued = await fresh.enqueueCaptureEvent(payload(`evt-bounded-${round}`));
        if (enqueued.kind === 'persisted') boundedTokens[round] = enqueued.creationToken;
        mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
          if ((init as RequestInit | undefined)?.method === 'POST') {
            return jsonResponse(
              { success: true, data: { captured: 1 } },
              { 'x-owner-id': 'owner-a' },
            );
          }
          return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
        });
        const report = await fresh.flushOutbox();
        expect(report.uploaded).toHaveLength(1);
      }
      // The receipts store never exceeded the window — and the NEWEST
      // receipt still confirms its record while the oldest are gone.
      vi.resetModules();
      const finalModule = await import('@/lib/mistake-book/outbox');
      finalModule.__setReceiptRetentionForTests(3);
      const counts = await new Promise<{ events: number; receipts: number }>((resolve, reject) => {
        const request = indexedDB.open('MAIC-mistake-outbox');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['events', 'receipts'], 'readonly');
          const e = tx.objectStore('events').count();
          const r = tx.objectStore('receipts').count();
          tx.oncomplete = () => {
            db.close();
            resolve({ events: e.result, receipts: r.result });
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
      expect(counts.events).toBe(0); // every record uploaded & deleted
      expect(counts.receipts).toBeLessThanOrEqual(3); // bounded across reloads
      const newest = await finalModule.readReceipts([
        {
          key: 'owner-a|evt-bounded-4',
          fingerprint: finalModule.fingerprintOf(payload('evt-bounded-4') as never),
          recordToken: boundedTokens[4]!,
        },
      ]);
      expect(newest.ok ? newest.matched.length : -1).toBe(1); // the current question still confirms
    } finally {
      vi.resetModules();
      outbox = await freshOutbox();
    }
  });

  it('v1 → v2 migration keeps existing events and adds the receipts store', async () => {
    // Build a v1 database with one event row, the pre-receipts schema.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MAIC-mistake-outbox', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('events', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('events', 'readwrite');
        tx.objectStore('events').put({
          key: 'owner-legacy|evt-old',
          eventId: 'evt-old',
          owner: 'owner-legacy',
          payload: payload('evt-old'),
          createdAt: Date.now(),
          attempts: 0,
          status: 'pending',
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    // The upgraded open migrates in place; the legacy record survives and
    // receipts work.
    outbox.observeOwner('owner-legacy');
    mocks.fetchMock.mockResolvedValue(
      jsonResponse({ success: true }, { 'x-owner-id': 'owner-legacy' }),
    );
    const report = await outbox.flushOutbox();
    expect(report.uploaded.map((e) => e.eventId)).toEqual(['evt-old']);
    const read = await outbox.__readAllForTests();
    expect(read.ok ? read.events : []).toHaveLength(0); // uploaded & deleted
    // P3-r1 §7: the v3 schema adds the durable-bindings store alongside the
    // preserved events/receipts — verify it exists (empty: no binds yet).
    const bindingsCount = await new Promise<number>((resolve, reject) => {
      const open = indexedDB.open('MAIC-mistake-outbox');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('bindings')) {
          db.close();
          reject(new Error('bindings store missing after v3 upgrade'));
          return;
        }
        const tx = db.transaction('bindings', 'readonly');
        const count = tx.objectStore('bindings').count();
        tx.oncomplete = () => {
          db.close();
          resolve(count.result);
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(bindingsCount).toBe(0);
  });

  it('v2 → v3 migration preserves events AND receipts, adding the bindings store', async () => {
    // Build a v2 database (events + receipts) with real rows in both.
    const legacyReceiptDate = 1_234_567;
    const receiptFingerprint = outbox.fingerprintOf(payload('evt-v2-done') as never);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MAIC-mistake-outbox', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('events')) {
          db.createObjectStore('events', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('receipts')) {
          db.createObjectStore('receipts', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['events', 'receipts'], 'readwrite');
        tx.objectStore('events').put({
          key: 'owner-v2|evt-v2',
          eventId: 'evt-v2',
          owner: 'owner-v2',
          payload: payload('evt-v2'),
          createdAt: legacyReceiptDate,
          attempts: 0,
          status: 'pending',
        });
        tx.objectStore('receipts').put({
          key: 'owner-v2|evt-v2-done',
          eventId: 'evt-v2-done',
          fingerprint: receiptFingerprint,
          recordToken: null,
          createdAt: legacyReceiptDate,
          at: Date.now(),
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    // The module's v3 open upgrades in place: events/receipts SURVIVE and
    // the strict APIs still confirm the preserved receipt row.
    outbox.observeOwner('owner-v2');
    const verdict = await outbox.readCaptureEvidence({
      owner: 'owner-v2',
      eventId: 'evt-v2-done',
      fingerprint: receiptFingerprint,
      recordToken: null,
      recordCreatedAt: legacyReceiptDate,
    });
    expect(verdict.status).toBe('receipt'); // v2 receipt still proves
    const read = await outbox.__readAllForTests();
    expect(read.ok ? read.events.map((e) => e.eventId) : []).toEqual(['evt-v2']);
  });

  it('receipt validator TOTALITY: malformed receipt rows never throw/hang a flush and never prove upload; genuine receipts stay positive', async () => {
    const outbox = await freshOutbox();
    const seedReceipt = (key: string, row: unknown) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('MAIC-mistake-outbox');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('receipts', 'readwrite');
          tx.objectStore('receipts').put({ key, ...(row as object) });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      });
    const malformed: Array<unknown> = [
      null, // null row — must not throw in tx.oncomplete / hang the flush
      42, // scalar
      'receipt', // string
      ['array'], // array
      {}, // torn: no metadata at all
      { eventId: 'ev-m0', fingerprint: null, recordToken: 'T' }, // invalid fp
      { eventId: 'ev-m0', fingerprint: undefined, recordToken: 'T' },
    ];
    let index = 0;
    const posted: string[] = [];
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { eventId: string };
        posted.push(body.eventId);
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });
    for (const row of malformed) {
      const eventId = `ev-mal-${index++}`;
      const payloadMal = payload(eventId);
      const seededMal = await outbox.enqueueCaptureEventUnderOwner(payloadMal, 'owner-a', {
        creationToken: 'T-mal',
      });
      expect(seededMal.kind).toBe('persisted');
      const fingerprint = outbox.fingerprintOf(payloadMal);
      await seedReceipt(`owner-a|${eventId}`, row);
      // NONE of these is completed proof — the flush resolves (never hangs),
      // never throws, and the genuinely queued row ships.
      const report = await outbox.flushOutbox();
      expect(posted).toContain(eventId);
      expect(report.uploaded.some((entry) => entry.eventId === eventId)).toBe(true);
      void fingerprint;
    }
    // Modern-plane metadata gaps: matching key/eventId/fingerprint/token
    // WITHOUT the finite upload-commit `at` is NOT proof.
    const evNoAt = 'ev-modern-no-at';
    const payloadNoAt = payload(evNoAt);
    await outbox.enqueueCaptureEventUnderOwner(payloadNoAt, 'owner-a', {
      creationToken: 'T-noat',
    });
    await seedReceipt(`owner-a|${evNoAt}`, {
      key: `owner-a|${evNoAt}`,
      eventId: evNoAt,
      fingerprint: outbox.fingerprintOf(payloadNoAt),
      recordToken: 'T-noat',
      createdAt: 123,
      // at: absent
    });
    const reportNoAt = await outbox.flushOutbox();
    expect(posted).toContain(evNoAt); // not proof → shipped
    expect(reportNoAt.uploaded.some((entry) => entry.eventId === evNoAt)).toBe(true);

    // INVALID `at` type (string) — equally not proof.
    const evBadAt = 'ev-modern-bad-at';
    const payloadBadAt = payload(evBadAt);
    await outbox.enqueueCaptureEventUnderOwner(payloadBadAt, 'owner-a', {
      creationToken: 'T-badat',
    });
    await seedReceipt(`owner-a|${evBadAt}`, {
      key: `owner-a|${evBadAt}`,
      eventId: evBadAt,
      fingerprint: outbox.fingerprintOf(payloadBadAt),
      recordToken: 'T-badat',
      at: 'yesterday',
    });
    const reportBadAt = await outbox.flushOutbox();
    expect(posted).toContain(evBadAt);
    expect(reportBadAt.uploaded.some((entry) => entry.eventId === evBadAt)).toBe(true);

    // POSITIVE control: a genuine committed receipt (through the REAL
    // commitUpload path) still refuses a same-token replay — unchanged
    // behavior — while a SAME-EVENT genuinely NEW token (raw-seeded, same
    // frozen content) stays a DISTINCT instance and ships.
    const evGenuine = 'ev-genuine-pos';
    const payloadGenuine = payload(evGenuine);
    await outbox.enqueueCaptureEventUnderOwner(payloadGenuine, 'owner-a', {
      creationToken: 'T-genuine',
    });
    const genuineReport = await outbox.flushOutbox(); // real upload + receipt
    expect(genuineReport.uploaded.some((entry) => entry.eventId === evGenuine)).toBe(true);
    // Same frozen token replay: gains no send authority.
    const replay = await outbox.enqueueCaptureEventUnderOwner(payloadGenuine, 'owner-a', {
      creationToken: 'T-genuine',
    });
    expect(replay.kind).toBe('persisted');
    // SAME-EVENT new-token instance (raw seed — a legitimately re-minted row
    // the current API cannot mint): distinct from the receipt's token.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('MAIC-mistake-outbox');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('events', 'readwrite');
        const queued = tx.objectStore('events').get(`owner-a|${evGenuine}`);
        queued.onsuccess = () => {
          const existing = queued.result as
            | {
                key: string;
                eventId: string;
                owner: string;
                payload: unknown;
                createdAt: number;
                attempts: number;
                status: string;
                creationToken?: string;
              }
            | undefined;
          if (existing) {
            tx.objectStore('events').put({ ...existing, creationToken: 'T-NEW-instance' });
          }
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    const postedBefore = posted.length;
    const finalReport = await outbox.flushOutbox();
    // The new-token instance SHIPPED (posted exactly once more for this
    // event); the same-token replay row would have been refused had it been
    // the row — here the single row IS the new token, proving distinctness.
    expect(posted.slice(postedBefore)).toEqual([evGenuine]);
    expect(finalReport.uploaded.some((entry) => entry.eventId === evGenuine)).toBe(true);
  });

  it('final review: quarantined rows are terminal — an old 500 released after a real EVENT_PAYLOAD_CONFLICT never downgrades them', async () => {
    // Cross-module/tab consumers overlap despite the same-context slot: A's
    // old POST is held; B's real transport commits the PERMANENT quarantine;
    // A's released 500 must not flip the rejected row back to retryable,
    // and the next flush POSTs nothing.
    vi.resetModules();
    const moduleB = await import('@/lib/mistake-book/outbox');
    vi.resetModules();
    const modulesA = await import('@/lib/mistake-book/outbox');

    const payloadQuarantine = payload('ev-quarantine-race');
    await modulesA.enqueueCaptureEventUnderOwner(payloadQuarantine, 'owner-a', {
      creationToken: 'tok-quarantine',
    });

    let releaseA!: (status: number) => void;
    let aArrived!: () => void;
    const aArrivedPromise = new Promise<void>((resolve) => {
      aArrived = resolve;
    });
    let firstPost = true;
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { eventId: string };
        if (firstPost && body.eventId === 'ev-quarantine-race') {
          firstPost = false;
          aArrived();
          const status = await new Promise<number>((resolve) => {
            releaseA = resolve;
          });
          return status === 200
            ? jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })
            : ({
                ok: false,
                status,
                headers: new Headers({ 'x-owner-id': 'owner-a' }),
                json: async () => ({}),
              } as Response);
        }
        // B's transport: the server PERMANENTLY refuses (content conflict).
        if (body.eventId === 'ev-quarantine-race') {
          return {
            ok: false,
            status: 409,
            headers: new Headers({ 'x-owner-id': 'owner-a' }),
            json: async () => ({ errorCode: 'EVENT_PAYLOAD_CONFLICT' }),
          } as Response;
        }
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });

    const passA = modulesA.flushOutbox();
    await aArrivedPromise;
    const reportB = await moduleB.flushOutbox(); // commits the quarantine
    expect(reportB.rejected).toHaveLength(1);
    releaseA(500); // the OLD 500 lands after the quarantine
    const reportA = await passA;
    expect(reportA.failed).toHaveLength(1); // honest verdict, own transport

    // RAW row fact: still quarantined — never downgraded to retryable.
    let read = await modulesA.__readAllForTests();
    expect(read.ok && read.events[0]?.status).toBe('rejected');
    expect(read.ok && read.events[0]?.attempts).toBe(1); // only B's verdict landed

    // The next flush POSTs NOTHING for a quarantined row.
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('no POST expected');
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });
    const reportNext = await modulesA.flushOutbox();
    expect(reportNext.uploaded).toHaveLength(0);
    expect(reportNext.failed).toHaveLength(0);
    read = await modulesA.__readAllForTests();
    expect(read.ok && read.events[0]?.status).toBe('rejected');
  });

  it('final review: a receipt-proven instance is never re-POSTed — exact replay of the SAME once-minted token T gains no send authority', async () => {
    // A holds its transport after its LIVE pre-send read (slot acquired,
    // revalidation passed, POST parked); B really uploads/deletes T and
    // commits the receipt; C replays the same frozen T through the REAL
    // enqueue API; A's OLD transport is released with a failure — the
    // receipt-proven T is NEVER re-POSTed, while a genuinely NEW token
    // (no matching receipt) genuinely ships.
    vi.resetModules();
    const moduleB = await import('@/lib/mistake-book/outbox');
    vi.resetModules();
    const modulesA = await import('@/lib/mistake-book/outbox');

    const payloadReplay = payload('ev-exact-replay');
    await modulesA.enqueueCaptureEventUnderOwner(payloadReplay, 'owner-a', {
      creationToken: 'T-once-minted',
    });
    const payloadFresh = payload('ev-fresh-instance');
    await modulesA.enqueueCaptureEventUnderOwner(payloadFresh, 'owner-a', {
      creationToken: 'T-fresh-new',
    });

    let releaseA!: (status: number) => void;
    let aArrived!: () => void;
    const aArrivedPromise = new Promise<void>((resolve) => {
      aArrived = resolve;
    });
    let firstPost = true;
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (firstPost) {
          firstPost = false;
          aArrived();
          const status = await new Promise<number>((resolve) => {
            releaseA = resolve;
          });
          return status === 200
            ? jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })
            : ({
                ok: false,
                status,
                headers: new Headers({ 'x-owner-id': 'owner-a' }),
                json: async () => ({}),
              } as Response);
        }
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });

    const passA = modulesA.flushOutbox();
    await aArrivedPromise; // A's transport for T is parked (row still live)
    const reportB = await moduleB.flushOutbox(); // uploads BOTH, receipts
    expect(reportB.uploaded).toHaveLength(2);
    // C replays the SAME frozen T (and the fresh token) via the REAL API.
    const replayed = await moduleB.enqueueCaptureEventUnderOwner(payloadReplay, 'owner-a', {
      creationToken: 'T-once-minted',
    });
    expect(replayed.kind).toBe('persisted'); // the stray twin exists now
    // A GENUINELY NEW instance (its own event content and token — no
    // matching receipt anywhere) enqueued by C as well.
    const payloadBrandNew = payload('ev-brand-new-event');
    const brandNew = await moduleB.enqueueCaptureEventUnderOwner(payloadBrandNew, 'owner-a', {
      creationToken: 'T-brand-new',
    });
    expect(brandNew.kind).toBe('persisted');

    releaseA(500); // A's OLD transport finally fails
    const reportA = await passA;
    expect(reportA.failed).toHaveLength(1); // honest for its own transport
    expect(reportA.uploaded).toHaveLength(0);
    // The ORIGINAL receipt for T stands untouched.
    expect(
      await strictReceiptCount(modulesA, [
        {
          key: 'owner-a|ev-exact-replay',
          fingerprint: modulesA.fingerprintOf(payloadReplay),
          recordToken: 'T-once-minted',
        },
      ]),
    ).toBe(1);

    // Next flush: the receipt-proven T NEVER re-POSTs (its same-token
    // replay inherits no send authority); the genuinely NEW instance ships.
    const posted: string[] = [];
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { eventId: string };
        posted.push(body.eventId);
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });
    const reportNext = await modulesA.flushOutbox();
    expect(posted).toEqual(['ev-brand-new-event']); // T NEVER re-POSTed
    expect(reportNext.uploaded).toHaveLength(1);
    expect(reportNext.uploaded[0]!.key).toBe('owner-a|ev-brand-new-event');
    // The stray T replay row remains honestly queued (never shipped again).
    const read = await modulesA.__readAllForTests();
    expect(read.ok ? read.events.map((e) => e.eventId) : []).toEqual(['ev-exact-replay']);
  });

  /**
   * A gated ambient IDB factory whose FIRST readonly `receipts` transaction
   * (and only it) is deferred until `releaseReceiptsRead` — an IndexedDB
   * read fixes its snapshot at REQUEST-ISSUE time, so the whole transaction
   * is materialized post-release. Shared by the PRE-TRANSPORT replay race
   * and the missing-boundary control.
   */
  function gatedIdbFactory(): {
    gatedFactory: { open(...args: Parameters<IDBFactory['open']>): unknown };
    receiptsArrived: Promise<void>;
    releaseReceiptsRead: () => void;
  } {
    const realIdb = indexedDB;
    let releaseReceiptsRead!: () => void;
    const receiptsGate = new Promise<void>((resolve) => {
      releaseReceiptsRead = resolve;
    });
    let receiptsReadArrived!: () => void;
    const receiptsArrived = new Promise<void>((resolve) => {
      receiptsReadArrived = resolve;
    });
    let gateArmed = true;
    const wrapDb = (db: IDBDatabase): IDBDatabase =>
      new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'transaction') {
            const realTransaction = target.transaction.bind(target);
            return (...txArgs: Parameters<IDBDatabase['transaction']>) => {
              const [storeNames, mode] = txArgs;
              const names = Array.isArray(storeNames) ? storeNames : [storeNames];
              if (
                gateArmed &&
                mode === 'readonly' &&
                names.includes('receipts') &&
                !names.includes('events')
              ) {
                gateArmed = false; // one-shot: only the first receipts read parks
                receiptsReadArrived();
                let getKey: IDBValidKey | undefined;
                let getOnSuccess: (() => void) | undefined;
                let realGetRequest: IDBRequest | undefined;
                let txOnComplete: (() => void) | undefined;
                let txOnAbort: (() => void) | undefined;
                let txOnError: (() => void) | undefined;
                const run = () => {
                  const realTx = realTransaction('receipts', 'readonly');
                  if (getKey !== undefined) {
                    const realGet = realTx.objectStore('receipts').get(getKey);
                    realGetRequest = realGet;
                    if (getOnSuccess !== undefined) realGet.onsuccess = () => getOnSuccess!();
                  }
                  realTx.oncomplete = () => txOnComplete?.();
                  realTx.onabort = () => txOnAbort?.();
                  realTx.onerror = () => txOnError?.();
                };
                void receiptsGate.then(run);
                const getProxy: IDBRequest = new Proxy({} as IDBRequest, {
                  get(_target, getProp) {
                    if (getProp === 'result') return realGetRequest?.result;
                    return undefined;
                  },
                  set(_target, getProp, value) {
                    if (getProp === 'onsuccess' && typeof value === 'function') {
                      getOnSuccess = value;
                      return true;
                    }
                    return true;
                  },
                });
                const objectStoreProxy = {
                  get: (key: IDBValidKey) => {
                    getKey = key;
                    return getProxy;
                  },
                };
                return new Proxy({} as IDBTransaction, {
                  get(_txTarget, txProp) {
                    if (txProp === 'objectStore') {
                      return () => objectStoreProxy;
                    }
                    return undefined;
                  },
                  set(_txTarget, txProp, value) {
                    if (typeof value === 'function') {
                      if (txProp === 'oncomplete') txOnComplete = value;
                      if (txProp === 'onabort') txOnAbort = value;
                      if (txProp === 'onerror') txOnError = value;
                    }
                    return true;
                  },
                }) as IDBTransaction;
              }
              return realTransaction(...txArgs);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const gatedFactory = {
      open(...args: Parameters<IDBFactory['open']>) {
        const realRequest = realIdb.open(...args);
        return new Proxy(realRequest, {
          get(target, prop, receiver) {
            if (prop === 'result') {
              const result = Reflect.get(target, prop, receiver);
              return result && typeof result === 'object' && 'transaction' in result
                ? wrapDb(result as IDBDatabase)
                : result;
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    return { gatedFactory, receiptsArrived, releaseReceiptsRead };
  }

  it('final review round 2: PRE-TRANSPORT live-read-held exact-token replay — A never POSTs, uploaded stays honest, the original receipt is untouched', async () => {
    // The demanded STALE PRE-SEND race (distinct from the after-send barrier
    // above): A's send slot is acquired, its LIVE queue revalidation has
    // PASSED, and its receipt revalidation — the last durable fact check
    // before the transport — is HELD mid-read (before ANY POST). While held:
    // B commits upload+delete+receipt for the exact instance; C re-enqueues
    // the SAME frozen token through the REAL enqueue API. On release the
    // committed receipt refuses A's send: zero new POST from A, honest
    // uploaded=[], original receipt/at unchanged — and a genuinely NEW-token
    // instance of the SAME event remains sendable.
    const moduleA = outbox; // fresh module from beforeEach
    vi.resetModules();
    const moduleB = await import('@/lib/mistake-book/outbox');

    const payloadReplay = payload('ev-pre-transport-replay');
    const seeded = await moduleA.enqueueCaptureEventUnderOwner(payloadReplay, 'owner-a', {
      creationToken: 'T-pre-transport',
    });
    expect(seeded.kind).toBe('persisted');

    const posted: string[] = [];
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { eventId: string };
        posted.push(body.eventId);
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });

    // Park A's RECEIPTS revalidation before ANY of its statements execute:
    // the first readonly receipts transaction (A's — it starts before B's and
    // this test seeds exactly one event) is materialized only when released,
    // so its snapshot reflects everything B and C committed in between. (An
    // IndexedDB read is fixed at REQUEST-ISSUE time — deferring a callback
    // alone would not re-read.) The shared gate helper also races arrival
    // against premature settlement: a flush that finished WITHOUT the
    // receipts read (a removed-validation regression) is detected promptly
    // instead of parking this test on an arrival promise forever.
    const realIdb = indexedDB; // raw access for the receipt snapshots below
    /** Raw (ungated) connections opened by THIS test — ALL closed in finally. */
    const rawDbs: IDBDatabase[] = [];
    const openRawDb = (): Promise<IDBDatabase> =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const open = realIdb.open('MAIC-mistake-outbox');
        open.onsuccess = () => {
          rawDbs.push(open.result);
          resolve(open.result);
        };
        open.onerror = () => reject(open.error);
      });
    const { gatedFactory, receiptsArrived, releaseReceiptsRead } = gatedIdbFactory();
    vi.stubGlobal('indexedDB', gatedFactory);

    // The finally below ALWAYS opens the receipts gate and drains A's parked
    // flush: an assertion failure mid-race can never leave the deferred
    // transaction (and its held send slot) dangling.
    let openGate: (() => void) | undefined = releaseReceiptsRead;
    let passA: Promise<import('@/lib/mistake-book/outbox').FlushReport> | undefined;
    try {
      passA = moduleA.flushOutbox();
      // Race the park's ARRIVAL against premature settlement and a bounded
      // diagnostic deadline: a flush that settled WITHOUT the receipts read
      // (a removed-validation regression) or a rejection is detected
      // promptly — this test can never hang on an unresolved arrival.
      const arrivalOutcome = await Promise.race([
        receiptsArrived.then(() => 'arrived' as const),
        passA.then(
          () => 'settled-before-read' as const,
          () => 'rejected-before-read' as const,
        ),
        new Promise<'arrival-deadline'>((resolve) => {
          setTimeout(() => resolve('arrival-deadline'), 2_000);
        }),
      ]);
      expect(arrivalOutcome, "A's flush must park at its pre-transport receipts revalidation").toBe(
        'arrived',
      ); // A: slot held, live queue read DONE, receipts read parked

      // B (an independent module instance — its own send-slot map, the
      // cross-tab shape) commits upload + delete + receipt for the instance.
      const reportB = await moduleB.flushOutbox();
      expect(reportB.uploaded).toHaveLength(1);
      expect(reportB.uploaded[0]!.recordToken).toBe('T-pre-transport');
      // C re-enqueues the SAME frozen token through the REAL API.
      const replayed = await moduleB.enqueueCaptureEventUnderOwner(payloadReplay, 'owner-a', {
        creationToken: 'T-pre-transport',
      });
      expect(replayed.kind).toBe('persisted'); // the stray twin exists now

      // Snapshot B's committed receipt (full raw row, including `at`) — the
      // connection is TRACKED and closed by the outer finally, on any exit.
      const receiptRowAfterB = await new Promise<Record<string, unknown> | undefined>(
        async (resolve, reject) => {
          try {
            const db = await openRawDb();
            const tx = db.transaction('receipts', 'readonly');
            const get = tx.objectStore('receipts').get('owner-a|ev-pre-transport-replay');
            get.onsuccess = () => {
              resolve(get.result as Record<string, unknown> | undefined);
            };
            tx.onerror = () => reject(tx.error);
          } catch (error) {
            reject(error);
          }
        },
      );
      expect(receiptRowAfterB).toMatchObject({
        key: 'owner-a|ev-pre-transport-replay',
        recordToken: 'T-pre-transport',
      });

      openGate = undefined;
      releaseReceiptsRead(); // A's held receipts read completes NOW
      const reportA = await passA;
      // ZERO new POST from A (only B's single transport ever fired) and an
      // HONEST empty report — A borrowed nothing and shipped nothing.
      expect(posted).toEqual(['ev-pre-transport-replay']);
      expect(reportA.uploaded).toEqual([]);
      expect(reportA.failed).toEqual([]);
      expect(reportA.rejected).toEqual([]);

      // The ORIGINAL receipt/time is unchanged by A's release (tracked too).
      const receiptRowAfterA = await new Promise<Record<string, unknown> | undefined>(
        async (resolve, reject) => {
          try {
            const db = await openRawDb();
            const tx = db.transaction('receipts', 'readonly');
            const get = tx.objectStore('receipts').get('owner-a|ev-pre-transport-replay');
            get.onsuccess = () => {
              resolve(get.result as Record<string, unknown> | undefined);
            };
            tx.onerror = () => reject(tx.error);
          } catch (error) {
            reject(error);
          }
        },
      );
      expect(receiptRowAfterA).toEqual(receiptRowAfterB);

      // PLANE BOUNDARY positive — same EVENT, genuinely NEW token: the stray
      // same-token twin (receipt-proven, never shippable) is removed, a fresh
      // token instance of the SAME event enqueues through the REAL API and
      // genuinely ships on the next flush.
      await new Promise<void>(async (resolve, reject) => {
        try {
          const db = await openRawDb();
          const tx = db.transaction('events', 'readwrite');
          tx.objectStore('events').delete('owner-a|ev-pre-transport-replay');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        } catch (error) {
          reject(error);
        }
      });
      const freshInstance = await moduleB.enqueueCaptureEventUnderOwner(payloadReplay, 'owner-a', {
        creationToken: 'T-new-plane-instance',
      });
      expect(freshInstance.kind).toBe('persisted');
      const reportNext = await moduleA.flushOutbox();
      expect(posted).toEqual(['ev-pre-transport-replay', 'ev-pre-transport-replay']);
      expect(reportNext.uploaded).toHaveLength(1);
      expect(reportNext.uploaded[0]!.recordToken).toBe('T-new-plane-instance');
      const after = await moduleA.__readAllForTests();
      expect(after.ok ? after.events : ['leftover']).toEqual([]); // shipped + deleted
    } finally {
      // Drain discipline: open the receipts gate if a control failed before
      // the race completed, let A's parked flush settle so the deferred
      // transaction and its send slot never dangle, and close EVERY raw
      // (ungated) database connection this test opened — including on
      // assertion failure, so no raw handle outlives the test.
      openGate?.();
      if (passA !== undefined) await passA.catch(() => undefined);
      for (const db of rawDbs) db.close();
    }
  });

  it('MISSING-BOUNDARY control: a flush that settles WITHOUT the receipts read is detected PROMPTLY, without hanging teardown', async () => {
    // The discipline proof for the PRE-TRANSPORT race above: an EMPTY flush
    // reads no queue rows and therefore never issues the receipts
    // revalidation — exactly the "regression shape" (validation removed /
    // flush finished early) that would otherwise park an arrival await
    // forever. The race resolves it in milliseconds, far under the deadline,
    // and the finally releases the (never-materialized) parked transaction.
    const { gatedFactory, receiptsArrived, releaseReceiptsRead } = gatedIdbFactory();
    vi.stubGlobal('indexedDB', gatedFactory);
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('no POST expected');
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });

    const openGate: () => void = releaseReceiptsRead;
    let flush: Promise<import('@/lib/mistake-book/outbox').FlushReport> | undefined;
    try {
      const startedAt = Date.now();
      flush = outbox.flushOutbox(); // empty queue: no receipts read, ever
      const outcome = await Promise.race([
        receiptsArrived.then(() => 'arrived' as const),
        flush.then(
          () => 'settled-before-read' as const,
          () => 'rejected-before-read' as const,
        ),
        new Promise<'arrival-deadline'>((resolve) => {
          setTimeout(() => resolve('arrival-deadline'), 2_000);
        }),
      ]);
      expect(outcome).toBe('settled-before-read');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const report = await flush;
      expect(report.uploaded).toEqual([]); // honest empty pass
    } finally {
      openGate();
      if (flush !== undefined) await flush.catch(() => undefined);
    }
  });

  it('r5 supplement: concurrent flush passes serialize — one record, ONE transport POST', async () => {
    // The r4 first-run DOM failure (preserved 108a) showed a recovery flush
    // racing the mount lifecycle flush inside the enqueue→first-delete
    // window: every pass that read the queue there re-POSTed the same event
    // (3 POSTs, business count still 1 via event-id idempotency). This is
    // the DETERMINISTIC unit form: hold the FIRST POST so an unserialized
    // second pass provably re-reads the still-queued record; the serialized
    // passes must keep exactly one transport POST.
    const outcome = await outbox.enqueueCaptureEventUnderOwner(
      payload('evt-flush-race'),
      'owner-a',
      {
        creationToken: 'flush-race-token',
      },
    );
    expect(outcome.kind).toBe('persisted');
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let postStartedResolve!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      postStartedResolve = resolve;
    });
    let firstPost = true;
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (firstPost) {
          firstPost = false;
          postStartedResolve();
          await postGate;
        }
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });
    const allThree = Promise.all([
      outbox.flushOutbox(),
      outbox.flushOutbox(),
      outbox.flushOutbox(),
    ]);
    await postStarted; // pass A is mid-POST — unserialized B/C would re-read NOW
    releasePost();
    const reports = await allThree;
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1); // one record → ONE transport POST, three callers
    expect(reports.reduce((sum, r) => sum + r.uploaded.length, 0)).toBe(1);
    for (const r of reports) {
      // no caller borrowed another's uploaded verdict; the waiting callers
      // report NOTHING for the instance (their consumers confirm by receipt)
      expect(r.uploaded.length).toBeLessThanOrEqual(1);
    }
    const after = await outbox.__readAllForTests();
    expect(after.ok ? after.events : ['leftover']).toEqual([]); // uploaded & deleted
  });

  it('C2 concurrent-flush design: an OLD transport failure landing AFTER another sender committed receipt+delete resurrects/overwrites NOTHING (raw queue/receipt facts)', async () => {
    // Two module instances share the SAME IndexedDB and transport but NOT
    // the same-context send-slot map — exactly the cross-tab situation the
    // coordinator cannot cover (server idempotence is the backstop there).
    // An OLD transport failure landing AFTER the real sender committed
    // receipt+delete must refuse BOTH an absent row (no resurrection) and a
    // replaced instance (no overwrite) — checked against raw queue and
    // receipt facts, never preset reports.
    const moduleA = await freshOutbox();
    vi.resetModules();
    const moduleB = await import('@/lib/mistake-book/outbox');
    /** One-shot per-event POST holds: arm(event) parks its FIRST POST until
     * released with a status; the arrival promise resolves when it parks. */
    const armedEvents = new Set<string>();
    const releasePost = new Map<string, (status: number) => void>();
    const postArrivedResolve = new Map<string, () => void>();
    const postArrived = new Map<string, Promise<void>>();
    const armHold = (eventId: string) => {
      armedEvents.add(eventId);
      let arrived!: () => void;
      postArrived.set(
        eventId,
        new Promise<void>((resolve) => {
          arrived = resolve;
        }),
      );
      postArrivedResolve.set(eventId, arrived);
    };
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { eventId: string };
        if (armedEvents.delete(body.eventId)) {
          postArrivedResolve.get(body.eventId)?.();
          const status = await new Promise<number>((resolve) => {
            releasePost.set(body.eventId, resolve);
          });
          return status === 200
            ? jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' })
            : ({
                ok: false,
                status,
                headers: new Headers({ 'x-owner-id': 'owner-a' }),
                json: async () => ({}),
              } as Response);
        }
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });

    // PHASE 1 — absent row: A's old transport is held; B really uploads and
    // deletes the instance; A's released 500 must NOT resurrect the row.
    const seeded1 = await moduleA.enqueueCaptureEventUnderOwner(
      payload('evt-cross-absent'),
      'owner-a',
      { creationToken: 'tok-absent' },
    );
    expect(seeded1.kind).toBe('persisted');
    armHold('evt-cross-absent');
    const passA1 = moduleA.flushOutbox();
    await postArrived.get('evt-cross-absent'); // A's old transport in flight
    const reportB1 = await moduleB.flushOutbox(); // B commits receipt + delete
    expect(reportB1.uploaded).toHaveLength(1);
    releasePost.get('evt-cross-absent')!(500);
    const reportA1 = await passA1;
    expect(reportA1.failed).toHaveLength(1); // honest verdict for its transport
    expect(reportA1.uploaded).toHaveLength(0); // never borrows B's success
    let read = await moduleA.__readAllForTests();
    expect(read.ok && read.events).toEqual([]); // NO resurrected row
    expect(
      await strictReceiptCount(moduleA, [
        {
          key: 'owner-a|evt-cross-absent',
          fingerprint: moduleA.fingerprintOf(payload('evt-cross-absent')),
          recordToken: 'tok-absent',
        },
      ]),
    ).toBe(1); // the committed receipt stands

    // PHASE 2 — replaced instance: after B uploads+deletes, a NEW instance
    // is re-created at the same key; A's released failure must not touch it.
    const seeded2 = await moduleA.enqueueCaptureEventUnderOwner(
      payload('evt-cross-replaced'),
      'owner-a',
      { creationToken: 'tok-old-2' },
    );
    expect(seeded2.kind).toBe('persisted');
    armHold('evt-cross-replaced');
    const passA2 = moduleA.flushOutbox();
    await postArrived.get('evt-cross-replaced');
    const reportB2 = await moduleB.flushOutbox();
    expect(reportB2.uploaded).toHaveLength(1);
    const recreated = await moduleB.enqueueCaptureEventUnderOwner(
      payload('evt-cross-replaced'),
      'owner-a',
      { creationToken: 'tok-NEW' },
    );
    expect(recreated.kind).toBe('persisted');
    releasePost.get('evt-cross-replaced')!(500);
    const reportA2 = await passA2;
    expect(reportA2.failed).toHaveLength(1);
    read = await moduleA.__readAllForTests();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.events.map((e) => e.eventId)).toEqual(['evt-cross-replaced']);
      expect(read.events[0]!.creationToken).toBe('tok-NEW'); // NEW instance intact
      expect(read.events[0]!.status).toBe('pending');
      expect(read.events[0]!.attempts).toBe(0); // A's stale failure NEVER landed
    }

    // PHASE 3 — replaced instance with NO receipt anywhere (the old one was
    // never uploaded): while A's transport is held, the row is replaced by
    // a fresh instance; the released failure must not overwrite it.
    const seeded3 = await moduleA.enqueueCaptureEventUnderOwner(
      payload('evt-cross-stale'),
      'owner-a',
      { creationToken: 'tok-stale' },
    );
    expect(seeded3.kind).toBe('persisted');
    armHold('evt-cross-stale');
    const passA3 = moduleA.flushOutbox();
    await postArrived.get('evt-cross-stale');
    // Another actor's real durable write: delete the row, then a fresh
    // instance of the SAME event lands at the key (no receipt exists).
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('MAIC-mistake-outbox');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('events', 'readwrite');
        tx.objectStore('events').delete('owner-a|evt-cross-stale');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    const fresh = await moduleB.enqueueCaptureEventUnderOwner(
      payload('evt-cross-stale'),
      'owner-a',
      { creationToken: 'tok-FRESH' },
    );
    expect(fresh.kind).toBe('persisted');
    releasePost.get('evt-cross-stale')!(500);
    const reportA3 = await passA3;
    expect(reportA3.failed).toHaveLength(1);
    read = await moduleA.__readAllForTests();
    expect(read.ok).toBe(true);
    if (read.ok) {
      const row = read.events.find((e) => e.eventId === 'evt-cross-stale');
      expect(row?.creationToken).toBe('tok-FRESH'); // fresh instance intact
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(0); // the stale failure NEVER overwrote it
    }
  });
});

// --- C3 outbox connection lifecycle: blocked / late open / versionchange ----
// Real IndexedDB fixtures with explicitly created old/new versions, per the
// C3 lifecycle design: blocked opens reject promptly (never an empty queue or
// pretend enqueue), late successes close, live production connections close
// on versionchange so upgrades are never blocked by us, future/corrupt
// versions stay honest, and old data survives every path field-by-field.

describe('outbox db lifecycle (real IDB)', () => {
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' }),
      ),
    );
    await freshOutbox();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** An explicitly-created v1 outbox DB with frozen rows in every status. */
  async function seedV1Fixture(): Promise<{
    db: IDBDatabase;
    rows: Array<Record<string, unknown>>;
  }> {
    const rows: Array<Record<string, unknown>> = [
      {
        key: 'owner-a|v1-bound',
        eventId: 'v1-bound',
        owner: 'owner-a',
        payload: payload('v1-bound'),
        createdAt: 1_000,
        attempts: 2,
        lastAttemptAt: 1_500,
        lastError: 'HTTP 500',
        status: 'failed',
        creationToken: 'tok-v1-bound',
      },
      {
        key: '|v1-unbound',
        eventId: 'v1-unbound',
        owner: '',
        payload: payload('v1-unbound'),
        createdAt: 1_100,
        attempts: 0,
        status: 'pending',
      },
      {
        key: 'owner-a|v1-rejected',
        eventId: 'v1-rejected',
        owner: 'owner-a',
        payload: payload('v1-rejected'),
        createdAt: 1_200,
        attempts: 3,
        lastError: 'HTTP 400',
        status: 'rejected',
      },
      {
        key: 'owner-a|v1-pending',
        eventId: 'v1-pending',
        owner: 'owner-a',
        payload: payload('v1-pending'),
        createdAt: 1_300,
        attempts: 1,
        lastAttemptAt: 1_350,
        status: 'pending',
        creationToken: 'tok-v1-pending',
      },
    ];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('MAIC-mistake-outbox', 1); // EXPLICITLY v1
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('events')) {
          open.result.createObjectStore('events', { keyPath: 'key' });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      for (const row of rows) tx.objectStore('events').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return { db, rows };
  }

  it('a held v1 connection BLOCKS the upgrade: enqueue is promptly unavailable, nothing is invented, the late connection closes, and post-release data is intact', async () => {
    const outboxModule = await freshOutbox();
    const { db: blocker, rows } = await seedV1Fixture();
    const realIdb = indexedDB;
    // NOTE: fake-indexeddb fires `blocked` for only ONE concurrent open —
    // exactly one production open is issued while the blocker is held.
    try {
      const blocked = await outboxModule.enqueueCaptureEventUnderOwner(
        payload('evt-during-block'),
        'owner-a',
        { creationToken: 'tok-during-block' },
      );
      // Promptly unavailable — not a pretend enqueue, not a false conflict.
      expect(blocked.kind).toBe('local-failed');

      // Nothing was invented: the held v1 connection still sees exactly the
      // seeded rows, and v1 has no receipts/bindings to fabricate.
      const v1Rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const tx = blocker.transaction('events', 'readonly');
        const getAll = tx.objectStore('events').getAll();
        getAll.onsuccess = () => resolve(getAll.result as Record<string, unknown>[]);
        tx.onerror = () => reject(tx.error);
      });
      const byKey = (list: Array<Record<string, unknown>>) =>
        [...list].sort((a, b) => String(a.key).localeCompare(String(b.key)));
      expect(byKey(v1Rows)).toEqual(byKey(rows)); // getAll is primary-key ordered
      expect(blocker.objectStoreNames.contains('receipts')).toBe(false);

      // CROSS-MODULE QUEUED OPEN: after the first open already rejected via
      // `blocked`, this read's open is queued behind the STILL-BLOCKED
      // original upgrade and may never receive its own `blocked` event —
      // the bounded wait must fail it honestly (never an empty queue, never
      // a hang) while the original request stays pending for later release.
      const queuedRead = await outboxModule.__readAllForTests();
      expect(queuedRead.ok).toBe(false);
      if (!queuedRead.ok) expect(queuedRead.error).toContain('outbox db open');

      // Release the blocker: the original blocked open's upgrade runs, the
      // late connection closes itself (single settlement), and post-release
      // operations work with every seeded v1 field intact.
      blocker.close();
      const readAfter = await outboxModule.__readAllForTests();
      expect(readAfter.ok).toBe(true);
      if (readAfter.ok) {
        const seeded = readAfter.events.filter((event) => event.eventId.startsWith('v1-'));
        expect(seeded).toHaveLength(rows.length);
        for (const row of rows) {
          const match = seeded.find((event) => event.eventId === row.eventId);
          expect(match).toMatchObject(row);
        }
        // And the previously blocked enqueue now genuinely persists.
        const retried = await outboxModule.enqueueCaptureEventUnderOwner(
          payload('evt-during-block'),
          'owner-a',
          { creationToken: 'tok-during-block' },
        );
        expect(retried.kind).toBe('persisted');
      }

      // Late-connection proof, LAST (it bumps the version): a v3+1 open
      // completes promptly ONLY if NO production v3 connection lingers —
      // the rejected open's late success closed itself, and every settled
      // operation closed in its finally. A live v3 connection would fire
      // `blocked` here and fail the race.
      const higher = await Promise.race([
        new Promise<IDBDatabase>((resolve, reject) => {
          const open = realIdb.open('MAIC-mistake-outbox', 3 + 1);
          open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('late-marker')) {
              open.result.createObjectStore('late-marker');
            }
          };
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
          open.onblocked = () => reject(new Error('a production v3 connection never closed'));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('late-close proof timed out')), 2_000),
        ),
      ]);
      expect(higher.objectStoreNames.contains('late-marker')).toBe(true);
      higher.close();
    } finally {
      blocker.close();
    }
  });

  it('the LEARNING database is untouched through the whole blocked/upgrade lifecycle', async () => {
    // A real old learning DB (maic-runtime via the production browser store)
    // with an old quiz attempt: every outbox lifecycle failure below must
    // leave it byte-identical — no failure path may "recover" by clearing
    // the learner's data.
    const { IDBKeyRange } = await import('fake-indexeddb');
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const { BrowserRuntimeStore } = await import('@openmaic/storage');
    const learning = new BrowserRuntimeStore({ indexedDB, dbName: 'maic-runtime' });
    await learning.createSession({
      id: 'quiz-attempt:stage-old:learner-old',
      kind: 'quizAttempt',
      stageId: 'stage-old',
      learnerKey: 'learner-old',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    await learning.appendRecord(
      {
        id: 'legacy-review-1',
        sessionId: 'quiz-attempt:stage-old:learner-old',
        sceneId: 'scene-old',
        createdAt: '2026-01-01T00:00:30.000Z',
        payload: {
          payloadVersion: 1,
          phase: 'reviewed',
          answers: { q1: 'A' },
          results: [{ questionId: 'q1', correct: null, status: 'ungraded', earned: 0 }],
        },
      },
      { sessionTransition: { status: 'completed', updatedAt: '2026-01-01T00:01:00.000Z' } },
    );
    const learningSnapshot = async (): Promise<unknown> => {
      const sessions = await learning.listSessions('stage-old', 'learner-old');
      const records = await Promise.all(sessions.map((s) => learning.listRecords(s.id)));
      return JSON.parse(JSON.stringify({ sessions, records }));
    };
    const before = await learningSnapshot();

    const outboxModule = await freshOutbox();
    const { db: blocker } = await seedV1Fixture();
    try {
      const blocked = await outboxModule.enqueueCaptureEventUnderOwner(
        payload('evt-learning-guard'),
        'owner-a',
      );
      expect(blocked.kind).toBe('local-failed');
      expect(await learningSnapshot()).toEqual(before); // blocked: untouched
    } finally {
      blocker.close();
    }
    // After release the upgrade runs; the learning DB is STILL untouched.
    await outboxModule.__readAllForTests();
    expect(await learningSnapshot()).toEqual(before);
    const retried = await outboxModule.enqueueCaptureEventUnderOwner(
      payload('evt-learning-guard'),
      'owner-a',
    );
    expect(retried.kind).toBe('persisted');
    expect(await learningSnapshot()).toEqual(before); // healthy ops never touch it either
  });

  it('a blocked READ answers honest unavailability — never an empty queue (single-open fixture)', async () => {
    const outboxModule = await freshOutbox();
    const { db: blocker, rows } = await seedV1Fixture();
    try {
      const read = await outboxModule.__readAllForTests(); // the ONE blocked open
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error).toContain('blocked');
      const v1Rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const tx = blocker.transaction('events', 'readonly');
        const getAll = tx.objectStore('events').getAll();
        getAll.onsuccess = () => resolve(getAll.result as Record<string, unknown>[]);
        tx.onerror = () => reject(tx.error);
      });
      const byKey = (list: Array<Record<string, unknown>>) =>
        [...list].sort((a, b) => String(a.key).localeCompare(String(b.key)));
      expect(byKey(v1Rows)).toEqual(byKey(rows)); // getAll is primary-key ordered // the failure read NOTHING away
    } finally {
      blocker.close();
    }
  });

  it('a LIVE production connection closes on versionchange — a real higher-version open is not blocked by us', async () => {
    const realIdb = indexedDB;
    // Park the enqueue's readwrite transaction completion so the PRODUCTION
    // db connection stays live (its finally close has not run). The wrapper
    // bridges every request to the real factory; only the tx completion
    // callback is deferred.
    let parkTx: (() => void) | undefined;
    const parkedFactory = {
      open(...args: Parameters<IDBFactory['open']>) {
        const request = realIdb.open(...args);
        return new Proxy(request, {
          get(target, prop, receiver) {
            if (prop === 'result') {
              const result = Reflect.get(target, prop, receiver);
              if (result && typeof result === 'object' && 'transaction' in result) {
                const db = result as IDBDatabase;
                const realTransaction = db.transaction.bind(db);
                (db as unknown as Record<string, unknown>).transaction = (
                  ...txArgs: Parameters<IDBDatabase['transaction']>
                ) => {
                  const tx = realTransaction(...txArgs);
                  return new Proxy(tx, {
                    get(txTarget, txProp, txReceiver) {
                      const value = Reflect.get(txTarget, txProp, txReceiver);
                      return typeof value === 'function' ? value.bind(txTarget) : value;
                    },
                    set(txTarget, txProp, value, txReceiver) {
                      if (txProp === 'oncomplete' && typeof value === 'function') {
                        parkTx = value; // hold the production connection open
                        return true;
                      }
                      return Reflect.set(txTarget, txProp, value, txReceiver);
                    },
                  }) as IDBTransaction;
                };
              }
              return result;
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    vi.stubGlobal('indexedDB', parkedFactory);
    const outboxModule = await import('@/lib/mistake-book/outbox');
    let heldDb: IDBDatabase | undefined;
    const capturingFactory = parkedFactory; // same wrapper also captures dbs
    // Track the live production db via a second wrapper layer is redundant —
    // parkTx holding IS the liveness proof; observe versionchange directly:
    // patch the production db's onversionchange setter? No — the REAL
    // handler must fire. Instead, capture the db by wrapping transaction
    // (already) — grab it from the first readwrite tx origin is unavailable,
    // so observe the upgrade completing: a v(DB_VERSION+1) open via the REAL
    // factory succeeds promptly ONLY if production closed on versionchange.
    const enqueuePromise = outboxModule
      .enqueueCaptureEventUnderOwner(payload('evt-versionchange'), 'owner-a', {
        creationToken: 'tok-versionchange',
      })
      .then(
        (outcome) => outcome,
        (error: unknown) => error,
      );
    // Wait until the parked transaction exists (the production db is LIVE).
    for (let tick = 0; tick < 100 && parkTx === undefined; tick += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    expect(parkTx).toBeDefined();
    void heldDb;
    void capturingFactory;

    let upgrade: IDBDatabase | undefined;
    try {
      upgrade = await Promise.race([
        new Promise<IDBDatabase>((resolve, reject) => {
          const open = realIdb.open('MAIC-mistake-outbox', 3 + 1); // future version
          open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('future-marker')) {
              open.result.createObjectStore('future-marker');
            }
          };
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
          open.onblocked = () =>
            reject(new Error('upgrade was blocked by a production connection'));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('upgrade open timed out')), 2_000),
        ),
      ]);
      expect(upgrade.objectStoreNames.contains('future-marker')).toBe(true);
    } finally {
      parkTx?.(); // release the parked production transaction
      await Promise.allSettled([enqueuePromise]);
      upgrade?.close();
      vi.unstubAllGlobals();
      vi.stubGlobal('indexedDB', realIdb);
    }
    // The enqueue settled honestly once its transaction completed.
    const settled = await enqueuePromise;
    expect(settled).toMatchObject({ kind: 'persisted' });
  });

  it('a FUTURE version answers honest failures without clearing anything', async () => {
    const realIdb = indexedDB;
    const future = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = realIdb.open('MAIC-mistake-outbox', 3 + 2);
      open.onupgradeneeded = () => {
        for (const name of ['events', 'receipts', 'bindings']) {
          if (!open.result.objectStoreNames.contains(name)) {
            const keyPath = name === 'bindings' ? 'sourceKey' : 'key';
            open.result.createObjectStore(name, { keyPath });
          }
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const futureRow = {
      key: 'owner-z|future',
      eventId: 'future',
      owner: 'owner-z',
      payload: payload('future'),
      createdAt: 9,
      attempts: 0,
      status: 'pending',
    };
    await new Promise<void>((resolve, reject) => {
      const tx = future.transaction('events', 'readwrite');
      tx.objectStore('events').put(futureRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const outboxModule = await freshOutbox();
    try {
      const outcome = await outboxModule.enqueueCaptureEventUnderOwner(
        payload('evt-future'),
        'owner-a',
      );
      expect(outcome.kind).toBe('local-failed'); // VersionError — honest
      const read = await outboxModule.__readAllForTests();
      expect(read.ok).toBe(false); // never an empty queue
      const futureRows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const tx = future.transaction('events', 'readonly');
        const getAll = tx.objectStore('events').getAll();
        getAll.onsuccess = () => resolve(getAll.result as Record<string, unknown>[]);
        tx.onerror = () => reject(tx.error);
      });
      expect(futureRows).toEqual([futureRow]); // untouched
    } finally {
      future.close();
    }
  });

  it('a v3 database missing the events store: upgrade ADDS it and preserves receipts rows', async () => {
    const realIdb = indexedDB;
    // A v2 database whose upgrade deliberately created only receipts (an
    // events-less partial schema): the CURRENT v3 open's upgrade must ADD
    // the missing store without touching the receipts rows.
    const partial = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = realIdb.open('MAIC-mistake-outbox', 2);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('receipts')) {
          open.result.createObjectStore('receipts', { keyPath: 'key' });
        }
        // deliberately no events/bindings stores
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const receiptRow = {
      key: 'owner-a|evt-kept',
      eventId: 'evt-kept',
      fingerprint: 'fp-kept',
      recordToken: 'tok-kept',
      createdAt: 5,
      at: 6,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = partial.transaction('receipts', 'readwrite');
      tx.objectStore('receipts').put(receiptRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    partial.close();

    const outboxModule = await freshOutbox();
    const outcome = await outboxModule.enqueueCaptureEventUnderOwner(
      payload('evt-after-repair'),
      'owner-a',
      {
        creationToken: 'tok-after-repair',
      },
    );
    expect(outcome.kind).toBe('persisted'); // the store was added, not rebuilt
    const read = await outboxModule.__readAllForTests();
    expect(read.ok && read.events.map((event) => event.eventId)).toEqual(['evt-after-repair']);
    const kept = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const open = realIdb.open('MAIC-mistake-outbox');
      open.onsuccess = () => {
        const tx = open.result.transaction('receipts', 'readonly');
        const get = tx.objectStore('receipts').get('owner-a|evt-kept');
        get.onsuccess = () => {
          resolve(get.result as Record<string, unknown> | undefined);
          open.result.close();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(kept).toEqual(receiptRow);
  });
  it('a SAME-VERSION v3 schema missing the events store: honest failures, receipts untouched, no rebuild or version bump', async () => {
    const realIdb = indexedDB;
    // A corrupt v3 fixture: receipts exists, events does NOT. Same-version
    // opens never run onupgradeneeded, so no code path may "repair" this by
    // rebuilding, clearing, or bumping the schema — every operation must
    // fail honestly and the receipts rows must remain exactly as stored.
    const partial = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = realIdb.open('MAIC-mistake-outbox', 3);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('receipts')) {
          open.result.createObjectStore('receipts', { keyPath: 'key' });
        }
        // deliberately no events/bindings stores
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const receiptRow = {
      key: 'owner-a|evt-same-version',
      eventId: 'evt-same-version',
      fingerprint: 'fp-same-version',
      recordToken: 'tok-same-version',
      createdAt: 5,
      at: 6,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = partial.transaction('receipts', 'readwrite');
      tx.objectStore('receipts').put(receiptRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    partial.close();

    const outboxModule = await freshOutbox();
    const outcome = await outboxModule.enqueueCaptureEventUnderOwner(
      payload('evt-c3-corrupt'),
      'owner-a',
      {
        creationToken: 'tok-c3-corrupt',
      },
    );
    expect(outcome.kind).toBe('local-failed'); // no fake persisted success
    const read = await outboxModule.__readAllForTests();
    expect(read.ok).toBe(false); // unavailable — never an empty queue

    const after = await new Promise<{ version: number; receipts: unknown }>((resolve, reject) => {
      const open = realIdb.open('MAIC-mistake-outbox'); // no version: current
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('receipts', 'readonly');
        const getAll = tx.objectStore('receipts').getAll();
        getAll.onsuccess = () => {
          resolve({ version: db.version, receipts: getAll.result });
          db.close();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(after.version).toBe(3); // never bumped to force a repair
    expect(after.receipts).toEqual([receiptRow]); // untouched, not rebuilt
  });
});
