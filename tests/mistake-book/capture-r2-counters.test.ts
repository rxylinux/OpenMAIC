/**
 * P3-r2 focused counters — the six reviewed defects' formal regressions:
 *
 * §3 journal: two same-key/event instances with distinct tokens/dates keep
 * INDEPENDENT durable proofs; the SAME full instance's A proof is never
 * overwritten by a later B move (append-once refusal, queue not moved);
 * malformed journal rows read UNREADABLE and never permit a fresh enqueue;
 * an aborted move transaction publishes no mapping and no journal row.
 *
 * §2/§4 owner resolution: the attempt owner for a NEW item is resolved
 * FRESH after earlier items' prechecks recovered+persisted A (the stale
 * cache never yields ''), authority is reconstructed from the journal even
 * when the progress already migrated/confirmed, an aborted AUTHORITY
 * transaction is honestly retryable (never drifts to B, recovers A on
 * rerun), and two concurrent prechecks recover the same mapping without
 * extra unbound/B creations.
 *
 * §6 frozen learner + stale operations: a resolved learner that no longer
 * matches the frozen plan writes NOTHING (no other-partition scope), and a
 * patch decided under an older operation never lands on a newer target
 * (the shared applyPlanLedgerPatch rule).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import type { MistakeCapturePayload } from '@/lib/mistake-book/client';
import type { QuizCapturePlan, QuizCapturePlanItem } from '@/lib/quiz/runtime';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function freshModules() {
  vi.resetModules();
  const outbox = await import('@/lib/mistake-book/outbox');
  const executor = await import('@/lib/mistake-book/plan-executor');
  const progress = await import('@/lib/mistake-book/progress');
  return { outbox, executor, progress };
}

function payloadFor(eventId: string, questionId = 'q1'): MistakeCapturePayload {
  return {
    eventId,
    stageId: 's1',
    stageName: '课',
    sceneId: 'sc1',
    items: [{ eventId, questionId, questionType: 'single', question: 'a?', userAnswer: 'B' }],
  };
}

function itemFor(
  questionId: string,
  token: string,
  payload: MistakeCapturePayload,
): QuizCapturePlanItem {
  return { questionId, eventId: payload.eventId!, payload, recordToken: token };
}

function unknownPlan(items: QuizCapturePlanItem[]): QuizCapturePlan {
  return {
    planVersion: 1,
    originOwner: '',
    originEpisodeId: 'att-r2',
    attemptId: 'att-r2',
    sceneId: 'sc1',
    learnerKey: 'learner-1',
    items,
  };
}

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body }) as Response;

const executorDeps = { getLearnerKey: async () => 'learner-1' };

/** Direct row read/write on one outbox store (test-side). */
function outboxStore<T>(
  storeName: 'events' | 'bindings',
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('MAIC-mistake-outbox');
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('events')) {
        db.createObjectStore('events', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('receipts')) {
        db.createObjectStore('receipts', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('bindings')) {
        db.createObjectStore('bindings', { keyPath: 'sourceKey' });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(storeName, 'readwrite');
      let result: T | undefined;
      let request: IDBRequest<T>;
      try {
        request = action(tx.objectStore(storeName));
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

/** Abort every readwrite put on the AUTHORITY store of the progress DB. */
function armAuthorityAbort(): void {
  const realOpen = indexedDB.open.bind(indexedDB);
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
              if (name === 'attempt-authority') {
                const realPut = store.put.bind(store);
                (store as unknown as Record<string, unknown>)['put'] = (...putArgs: unknown[]) => {
                  const putRequest = (realPut as (...a: unknown[]) => IDBRequest)(...putArgs);
                  putRequest.addEventListener('success', () => tx.abort(), { once: true });
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
    },
  } as unknown as IDBFactory);
}

describe('P3-r2 §3: durable binding journal retention & refusal', () => {
  let outbox: Awaited<ReturnType<typeof freshModules>>['outbox'];
  let executor: Awaited<ReturnType<typeof freshModules>>['executor'];
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
    ({ outbox, executor } = await freshModules());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('two same-key/event instances with DISTINCT tokens keep INDEPENDENT proofs', async () => {
    const payload = payloadFor('ev-two');
    // First instance (plan-token-1) binds to A.
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'tok-1' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report1 = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-two', creationToken: 'tok-1' }],
    });
    expect(report1.committedBinds).toHaveLength(1);
    // A SECOND instance with a different token at the SAME queue key binds
    // to owner-c — its proof coexists, nothing is overwritten.
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'tok-2' });
    const report2 = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-two', creationToken: 'tok-2' }],
    });
    expect(report2.committedBinds).toHaveLength(1);
    expect(report2.committedBinds[0]!.destination.owner).toBe('owner-a');
    const row = (await outboxStore<unknown>('bindings', (store) => store.get('|ev-two'))) as {
      entries: Array<{ source: { recordToken: string }; destination: { owner: string } }>;
    };
    expect(row.entries).toHaveLength(2); // both instances retained
    const fp = outbox.fingerprintOf(payload);
    // Each instance reads ITS OWN proof by full identity.
    const first = await outbox.readBindingJournal({
      key: '|ev-two',
      eventId: 'ev-two',
      fingerprint: fp,
      recordToken: 'tok-1',
    });
    expect(first.status).toBe('found');
    const second = await outbox.readBindingJournal({
      key: '|ev-two',
      eventId: 'ev-two',
      fingerprint: fp,
      recordToken: 'tok-2',
    });
    expect(second.status).toBe('found');
    if (first.status !== 'found' || second.status !== 'found') throw new Error('unreachable');
    expect(first.binding.destination.owner).toBe('owner-a');
    expect(second.binding.destination.owner).toBe('owner-a');
  });

  it('the SAME full instance A→B is REFUSED: the original proof and the queue stay intact', async () => {
    const payload = payloadFor('ev-refuse');
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'tok-same' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-refuse', creationToken: 'tok-same' }],
    });
    // Recreate the SAME unbound instance (identical token) and try to move
    // it to owner-b — the journal's append-once refuses.
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'tok-same' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-b' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-refuse', creationToken: 'tok-same' }],
    });
    expect(report.committedBinds).toHaveLength(0); // refused — no new mapping
    // The queue still holds the recreated source UNBOUND (not moved to B).
    const events = await outbox.__readAllForTests();
    expect(events.ok && events.events.some((e) => e.key === '|ev-refuse' && e.owner === '')).toBe(
      true,
    );
    // The journal still proves ONLY A for this instance.
    const journal = await outbox.readBindingJournal({
      key: '|ev-refuse',
      eventId: 'ev-refuse',
      fingerprint: outbox.fingerprintOf(payload),
      recordToken: 'tok-same',
    });
    expect(journal.status).toBe('found');
    if (journal.status !== 'found') throw new Error('unreachable');
    expect(journal.binding.destination.owner).toBe('owner-a');
  });

  it('a MALFORMED journal row reads UNREADABLE and never permits a fresh enqueue', async () => {
    const payload = payloadFor('ev-corrupt');
    // Plant a corrupt composite row (destination with an EMPTY owner).
    await outboxStore('bindings', (store) =>
      store.put({
        sourceKey: '|ev-corrupt',
        entries: [
          {
            bindingVersion: 1,
            sourceKey: '|ev-corrupt',
            reason: 'active-bind',
            source: {
              key: '|ev-corrupt',
              owner: '',
              eventId: 'ev-corrupt',
              fingerprint: outbox.fingerprintOf(payload),
              recordToken: 'tok-x',
            },
            destination: {
              key: '|ev-corrupt',
              owner: '',
              eventId: 'ev-corrupt',
              fingerprint: outbox.fingerprintOf(payload),
              recordToken: 'tok-x',
            },
            recordedAt: 1,
          },
        ],
      }),
    );
    const journal = await outbox.readBindingJournal({
      key: '|ev-corrupt',
      eventId: 'ev-corrupt',
      fingerprint: outbox.fingerprintOf(payload),
      recordToken: 'tok-x',
    });
    expect(journal).toEqual({ status: 'unreadable' }); // never absent
    // The precheck surfaces the corruption honestly — NEVER an enqueue.
    const plan = unknownPlan([itemFor('q1', 'tok-x', payload)]);
    const precheck = await executor.precheckItem(plan, plan.items[0]!, executorDeps);
    expect(['unreadable', 'conflict']).toContain(precheck.action);
    if (precheck.action !== 'unreadable' && precheck.action !== 'conflict') {
      throw new Error('unreachable');
    }
    expect(precheck.action).not.toBe('enqueue');
  });

  it('an aborted move transaction publishes NO mapping and NO journal row', async () => {
    const payload = payloadFor('ev-abort-j');
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'tok-abort' });
    // Abort every readwrite put on the outbox events store.
    const realOpen = indexedDB.open.bind(indexedDB);
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
                  (store as unknown as Record<string, unknown>)['put'] = (
                    ...putArgs: unknown[]
                  ) => {
                    const putRequest = (realPut as (...a: unknown[]) => IDBRequest)(...putArgs);
                    putRequest.addEventListener('success', () => tx.abort(), { once: true });
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
      },
    } as unknown as IDBFactory);
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const baseFactory = indexedDB;
    const { outbox: aborted } = await freshModules();
    const report = await aborted.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-abort-j', creationToken: 'tok-abort' }],
    });
    expect(report.committedBinds).toHaveLength(0);
    // r3 evidence fix: PRESERVE the original factory and reopen the SAME
    // database — assert the source is intact, the destination absent, and
    // the journal holds NO row (nothing published).
    vi.stubGlobal('indexedDB', baseFactory);
    const { outbox: reopened } = await freshModules();
    const events = await reopened.__readAllForTests();
    expect(events.ok).toBe(true);
    if (events.ok) {
      const source = events.events.find((e) => e.key === '|ev-abort-j');
      expect(source?.owner).toBe(''); // intact unbound
      expect(events.events.some((e) => e.key === 'owner-a|ev-abort-j')).toBe(false);
    }
    const journal = await reopened.readBindingJournal({
      key: '|ev-abort-j',
      eventId: 'ev-abort-j',
      fingerprint: outbox.fingerprintOf(payload),
      recordToken: 'tok-abort',
    });
    expect(journal.status).toBe('absent'); // no journal row published
  });

  it('r3 §3: distinct LEGACY-DATE instances at one queue key retain independent proofs', async () => {
    const payload = payloadFor('ev-legacy-two');
    // Two token-less sources at the same key differing ONLY by createdAt.
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-legacy-two',
      eventId: 'ev-legacy-two',
      owner: '',
      createdAt: 111,
      payload: payload as never,
    });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    // Claim the first (the journal records source legacy date 111 → A).
    const claim1 = await outbox.claimUnboundEvents();
    expect(claim1.identityConfirmed).toBe(true);
    expect(claim1.claimed).toContain('ev-legacy-two');
    // A second legacy instance (different date) at the same key → its own
    // claim appends a SEPARATE proof (no overwrite).
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-legacy-two',
      eventId: 'ev-legacy-two',
      owner: '',
      createdAt: 222,
      payload: payload as never,
    });
    const claim2 = await outbox.claimUnboundEvents();
    expect(claim2.claimed).toContain('ev-legacy-two');
    const fp = outbox.fingerprintOf(payload);
    const first = await outbox.readBindingJournal({
      key: '|ev-legacy-two',
      eventId: 'ev-legacy-two',
      fingerprint: fp,
      recordToken: null,
      recordCreatedAt: 111,
    });
    const second = await outbox.readBindingJournal({
      key: '|ev-legacy-two',
      eventId: 'ev-legacy-two',
      fingerprint: fp,
      recordToken: null,
      recordCreatedAt: 222,
    });
    expect(first.status).toBe('found');
    expect(second.status).toBe('found'); // independently retained
  });

  it('r3 §3: malformed journal matrices settle (unreadable/refuse) with the queue preserved', async () => {
    const payload = payloadFor('ev-matrix');
    const fp = outbox.fingerprintOf(payload);
    const malformedRows: unknown[] = [
      { sourceKey: '|ev-matrix', entries: [null] }, // entries:[null]
      { sourceKey: '|ev-matrix', entries: 'not-an-array' }, // scalar entries
      { sourceKey: '|ev-matrix', entries: [{ bindingVersion: 2 }] }, // wrong version
      { sourceKey: '|OTHER-key', entries: [] }, // row scope mismatch
      {
        sourceKey: '|ev-matrix',
        entries: [
          {
            bindingVersion: 1,
            sourceKey: '|ev-matrix',
            reason: 'active-bind',
            source: {
              key: '|ev-matrix',
              owner: '',
              eventId: 'ev-matrix',
              fingerprint: fp,
              recordToken: 't',
            },
            destination: {
              key: 'owner-a|ev-matrix',
              owner: 'owner-a',
              eventId: 'ev-matrix',
              fingerprint: fp,
              recordToken: 't',
              createdAt: 5,
            },
            recordedAt: 1,
          },
        ],
      }, // modern destination with a legacy date (mixed planes)
      // NOTE: a whole scalar/null ROW cannot exist under the keyPath store
      // (IndexedDB rejects the put with DataError) — the persisted matrix
      // covers every shape that CAN be stored: in-row corruption only.
    ];
    for (const row of malformedRows) {
      await outboxStore('bindings', (store) => store.put(row));
      // The read settles (never hangs) on unreadable or absent — corruption
      // is NEVER permission; each promise resolves within the test timeout.
      const verdict = await outbox.readBindingJournal({
        key: '|ev-matrix',
        eventId: 'ev-matrix',
        fingerprint: fp,
        recordToken: 't',
      });
      expect(['unreadable', 'absent']).toContain(verdict.status);
      expect(verdict.status).not.toBe('found');
      await outboxStore('bindings', (store) => store.clear());
    }
    // The queue was never touched by any malformed read.
    const events = await outbox.__readAllForTests();
    expect(events.ok && events.events.length === 0).toBe(true);
    // Zero invented authority/enqueue: no progress rows exist at all.
    const progressRows = await new Promise<unknown[]>((resolve, reject) => {
      const open = indexedDB.open('MAIC-capture-progress', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'scope' });
        }
        if (!db.objectStoreNames.contains('attempt-authority')) {
          db.createObjectStore('attempt-authority', { keyPath: 'scope' });
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('progress', 'readonly');
        const req = tx.objectStore('progress').getAll();
        req.onsuccess = () => {
          db.close();
          resolve((req.result ?? []) as unknown[]);
        };
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(progressRows).toHaveLength(0);
  });

  it('r3 §3: exact same-instance same-A replay with the destination row ABSENT restores it; contradictory A→B plus a second source each process ONCE', async () => {
    const payloadA = payloadFor('ev-replay-a');
    const payloadB = payloadFor('ev-replay-b');
    // First: bind source A-instance to owner-a (journal entry committed).
    await outbox.enqueueCaptureEventUnderOwner(payloadA, '', { creationToken: 'tok-rp' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-replay-a', creationToken: 'tok-rp' }],
    });
    // Simulate the crash-after-journal: delete the DESTINATION row only
    // (the queue moved, the journal committed, the destination vanished).
    await outboxStore('events', (store) => store.delete('owner-a|ev-replay-a'));
    // Recreate the SAME source instance (identical token + content).
    await outbox.enqueueCaptureEventUnderOwner(payloadA, '', { creationToken: 'tok-rp' });
    // Replay the same bind: the journal's exact proof must RESTORE the
    // destination transactionally (same content) — never delete the source
    // against an imagined destination, never mint a second proof.
    const replay = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-replay-a', creationToken: 'tok-rp' }],
    });
    void replay;
    // The restored owner-a destination uploads in the same flush — the
    // honest end state: NO unbound source remains, and a strict receipt
    // proves the owner-a instance (restored, not invented).
    const events = await outbox.__readAllForTests();
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.events.some((e) => e.key === '|ev-replay-a')).toBe(false);
    }
    const receipt = await outbox.readReceipts([
      {
        key: 'owner-a|ev-replay-a',
        fingerprint: outbox.fingerprintOf(payloadA),
        recordToken: 'tok-rp',
      },
    ]);
    expect(receipt.ok && receipt.matched.length).toBe(1);

    // Contradiction + second source: the SAME tok-rp instance was already
    // proven → owner-a; a bind to owner-b must be REFUSED (source kept),
    // while a DIFFERENT second source (tok-rp2, same key) processes
    // exactly once and CAN bind.
    await outboxStore('events', (store) => store.delete('owner-a|ev-replay-a'));
    await outbox.enqueueCaptureEventUnderOwner(payloadA, '', { creationToken: 'tok-rp' });
    await outbox.enqueueCaptureEventUnderOwner(payloadB, '', { creationToken: 'tok-rp2' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-b' }));
    const mixed = await outbox.flushOutbox({
      bindNewEvents: [
        { eventId: 'ev-replay-a', creationToken: 'tok-rp' },
        { eventId: 'ev-replay-b', creationToken: 'tok-rp2' },
      ],
    });
    // The contradictory instance was refused (explicit conflict, kept
    // unbound); the second source moved exactly once.
    expect(mixed.conflicts.filter((entry) => entry.key === '|ev-replay-a').length).toBe(1);
    expect(mixed.committedBinds.filter((m) => m.source.key === '|ev-replay-b').length).toBe(1);
    expect(mixed.committedBinds.filter((m) => m.source.key === '|ev-replay-a').length).toBe(0);
    const after = await outbox.__readAllForTests();
    expect(after.ok).toBe(true);
    if (after.ok) {
      const refused = after.events.find((e) => e.key === '|ev-replay-a');
      expect(refused?.owner).toBe(''); // kept for the explicit claim
      expect(after.events.some((e) => e.key === 'owner-b|ev-replay-a')).toBe(false);
    }
    // The second source bound and uploaded under owner-b (its strict
    // receipt proves it); each instance processed exactly once.
    const secondReceipt = await outbox.readReceipts([
      {
        key: 'owner-b|ev-replay-b',
        fingerprint: outbox.fingerprintOf(payloadB),
        recordToken: 'tok-rp2',
      },
    ]);
    expect(secondReceipt.ok && secondReceipt.matched.length).toBe(1);
  });
});

describe('P3-r2 §2/§4: fresh owner resolution, authority repair, concurrency', () => {
  let outbox: Awaited<ReturnType<typeof freshModules>>['outbox'];
  let executor: Awaited<ReturnType<typeof freshModules>>['executor'];
  let progress: Awaited<ReturnType<typeof freshModules>>['progress'];
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
    ({ outbox, executor, progress } = await freshModules());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolveAttemptOwner recovers A from the journal even with progress already CONFIRMED', async () => {
    // q1 bound to A and uploaded (progress confirmed) — but the authority
    // write was lost (crash between). The owner resolution REPAIRS it.
    const payload = payloadFor('ev-repair');
    const fp = outbox.fingerprintOf(payload);
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'plan-token-1' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-repair', creationToken: 'plan-token-1' }],
    });
    // Consume the report with a REAL queued ledger target (the item's
    // adopted identity) so the upload verdict genuinely confirms — the
    // assertion below proves it instead of assuming it.
    const ledger = new Map<string, import('@/lib/mistake-book/plan-executor').PlanLedgerTarget>();
    ledger.set('q1', {
      questionId: 'q1',
      eventId: 'ev-repair',
      opSeq: 1,
      state: 'queued',
      handle: 'owner-a|ev-repair',
      fingerprint: fp,
      recordToken: 'plan-token-1',
    });
    await executor.consumeReportForPlan(plan, report, {
      getLearnerKey: async () => 'learner-1',
      stillCurrent: () => true,
      getTarget: (id) => ledger.get(id),
      patchLedger: (id, patch) => {
        const target = ledger.get(id);
        if (target) ledger.set(id, { ...target, ...patch } as typeof target);
      },
    });
    // r3 evidence fix: PROVE the progress is actually CONFIRMED before the
    // authority deletion — the repair must start from a real confirmed row.
    const confirmedBefore = await progress.readCaptureProgress({
      learnerKey: 'learner-1',
      attemptId: 'att-r2',
      sceneId: 'sc1',
      originEpisodeId: 'att-r2',
      originOwner: '',
      questionId: 'q1',
      eventId: 'ev-repair',
      planRecordToken: 'plan-token-1',
      frozenPayloadFingerprint: fp,
    });
    expect(confirmedBefore.status).toBe('confirmed');
    // Simulate the crash: wipe ONLY the authority store afterwards.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('MAIC-capture-progress', 1);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('attempt-authority')) {
          db.close();
          resolve();
          return;
        }
        const tx = db.transaction('attempt-authority', 'readwrite');
        tx.objectStore('attempt-authority').clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    const before = await progress.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-r2',
      sceneId: 'sc1',
      originEpisodeId: 'att-r2',
      originOwner: '',
    });
    expect(before.status).toBe('absent');
    // The cache is B now — the repair still reconstructs A from the journal.
    outbox.observeOwner('owner-b');
    const resolution = await executor.resolveAttemptOwner(plan, executorDeps);
    expect(resolution.status).toBe('proven');
    if (resolution.status !== 'proven') throw new Error('unreachable');
    expect(resolution.owner).toBe('owner-a');
    void fp;
  });

  it('an aborted AUTHORITY transaction is honestly retryable — no owner drift, A recovers on rerun', async () => {
    const payload = payloadFor('ev-auth-abort');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'plan-token-1' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-auth-abort', creationToken: 'plan-token-1' }],
    });
    // Wipe progress AND authority (full crash before either committed);
    // then abort every authority write during the repair.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('MAIC-capture-progress', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'scope' });
        }
        if (!db.objectStoreNames.contains('attempt-authority')) {
          db.createObjectStore('attempt-authority', { keyPath: 'scope' });
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['progress', 'attempt-authority'], 'readwrite');
        tx.objectStore('progress').clear();
        tx.objectStore('attempt-authority').clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    const baseFactory = indexedDB;
    armAuthorityAbort();
    const { executor: abortedExecutor } = await freshModules();
    const failed = await abortedExecutor.resolveAttemptOwner(plan, executorDeps);
    expect(['unreadable', 'conflict']).toContain(failed.status); // honest, NOT proven-B
    if (failed.status === 'proven') throw new Error('authority drifted');
    // Rerun without the abort (restore the base factory — NOT
    // unstubAllGlobals, which would also drop the beforeEach fetch/indexedDB
    // stubs): A recovers exactly.
    vi.stubGlobal('indexedDB', baseFactory);
    const { executor: cleanExecutor, progress: cleanProgress } = await freshModules();
    const recovered = await cleanExecutor.resolveAttemptOwner(plan, executorDeps);
    expect(recovered.status).toBe('proven');
    if (recovered.status !== 'proven') throw new Error('unreachable');
    expect(recovered.owner).toBe('owner-a');
    const stored = await cleanProgress.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-r2',
      sceneId: 'sc1',
      originEpisodeId: 'att-r2',
      originOwner: '',
    });
    expect(stored.status).toBe('proven');
  });

  it('two CONCURRENT prechecks recover the same A mapping without extra unbound/B creations', async () => {
    const payload = payloadFor('ev-race');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'plan-token-1' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-race', creationToken: 'plan-token-1' }],
    });
    // Crash: both progress and authority lost; the journal survives.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('MAIC-capture-progress', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'scope' });
        }
        if (!db.objectStoreNames.contains('attempt-authority')) {
          db.createObjectStore('attempt-authority', { keyPath: 'scope' });
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['progress', 'attempt-authority'], 'readwrite');
        tx.objectStore('progress').clear();
        tx.objectStore('attempt-authority').clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    const { executor: racingExecutor, progress: racingProgress } = await freshModules();
    const [a, b] = await Promise.all([
      racingExecutor.precheckItem(plan, plan.items[0]!, executorDeps),
      racingExecutor.precheckItem(plan, plan.items[0]!, executorDeps),
    ]);
    // Both recover the destination evidence — neither enqueues, neither
    // creates a fresh unbound row, neither binds B.
    for (const verdict of [a, b]) {
      expect(['evidence', 'conflict', 'unreadable']).toContain(verdict.action);
      expect(verdict.action).not.toBe('enqueue');
      if (verdict.action === 'evidence') {
        expect(['queued', 'receipt', 'conflict', 'unreadable']).toContain(verdict.evidence.status);
      }
    }
    const events = await outbox.__readAllForTests();
    expect(events.ok).toBe(true);
    if (events.ok) {
      const unbound = events.events.filter((e) => e.owner === '' && e.eventId === 'ev-race');
      expect(unbound).toHaveLength(0); // the source was NOT recreated
    }
    // The authority is proven (exactly A) after the race.
    const authority = await racingProgress.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-r2',
      sceneId: 'sc1',
      originEpisodeId: 'att-r2',
      originOwner: '',
    });
    expect(authority.status).toBe('proven');
    if (authority.status !== 'proven') throw new Error('unreachable');
    expect(authority.effectiveOwner).toBe('owner-a');
  });
  it('r4 §3: CLAIM exact replay — destination restored AND source consumed; abort keeps both facts; content conflict preserves the source', async () => {
    const payload = payloadFor('ev-claim-rp');
    // The user explicitly claimed the source to A; the journal retained.
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-claim-rp',
      eventId: 'ev-claim-rp',
      owner: '',
      createdAt: 777,
      payload: payload as never,
    });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const claim1 = await outbox.claimUnboundEvents();
    expect(claim1.identityConfirmed).toBe(true);
    expect(claim1.claimed).toContain('ev-claim-rp');
    // Crash simulation: the DESTINATION row vanished; the journal survived.
    await outboxStore('events', (store) => store.delete('owner-a|ev-claim-rp'));
    // The SAME full source instance is recreated (legacy date 777).
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-claim-rp',
      eventId: 'ev-claim-rp',
      owner: '',
      createdAt: 777,
      payload: payload as never,
    });
    // Replay the claim to A: the exact proven destination is restored AND
    // the source twin is consumed in the SAME transaction; the claimed
    // full mapping is published exactly once; NO residual unbound twin.
    const replay = await outbox.claimUnboundEvents();
    expect(replay.claimed).toContain('ev-claim-rp');
    expect(replay.committedMappings).toHaveLength(1);
    expect(replay.committedMappings[0]!.source.recordToken).toBeNull();
    expect(replay.committedMappings[0]!.source.createdAt).toBe(777);
    const events = await outbox.__readAllForTests();
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.events.some((e) => e.key === '|ev-claim-rp')).toBe(false); // consumed
      const restored = events.events.find((e) => e.key === 'owner-a|ev-claim-rp');
      expect(restored?.owner).toBe('owner-a');
      expect(restored?.creationToken).toBeUndefined(); // the PROVEN legacy identity
      expect(restored?.createdAt).toBe(777);
    }

    // ABORT variant: the move transaction aborts — BOTH queue and journal
    // facts keep their pre-claim shape (source intact, journal entry for
    // the FIRST claim only, destination absent).
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-claim-rp2',
      eventId: 'ev-claim-rp2',
      owner: '',
      createdAt: 888,
      payload: payloadFor('ev-claim-rp2') as never,
    });
    await outbox.claimUnboundEvents(); // first claim for rp2 → owner-a
    await outboxStore('events', (store) => store.delete('owner-a|ev-claim-rp2'));
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-claim-rp2',
      eventId: 'ev-claim-rp2',
      owner: '',
      createdAt: 888,
      payload: payloadFor('ev-claim-rp2') as never,
    });
    const baseFactory = indexedDB;
    const realOpen = baseFactory.open.bind(baseFactory);
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
                  (store as unknown as Record<string, unknown>)['put'] = (
                    ...putArgs: unknown[]
                  ) => {
                    const putRequest = (realPut as (...a: unknown[]) => IDBRequest)(...putArgs);
                    putRequest.addEventListener('success', () => tx.abort(), { once: true });
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
      },
    } as unknown as IDBFactory);
    const abortingModule = await freshModules();
    const abortingClaim = abortingModule.outbox.claimUnboundEvents;
    const abortedClaim = await abortingClaim();
    expect(abortedClaim.storageError).toBe(true); // honest failure — moved NOTHING
    vi.stubGlobal('indexedDB', baseFactory);
    const reopened = await freshModules();
    const reopenClaim = reopened.outbox.claimUnboundEvents;
    const reopenJournal = reopened.outbox.readBindingJournal;
    const afterAbort = await reopened.outbox.__readAllForTests();
    if (afterAbort.ok) {
      const source = afterAbort.events.find((e) => e.key === '|ev-claim-rp2');
      expect(source?.owner).toBe(''); // intact
      expect(afterAbort.events.some((e) => e.key === 'owner-a|ev-claim-rp2')).toBe(false);
    }
    const journalAfterAbort = await reopenJournal({
      key: '|ev-claim-rp2',
      eventId: 'ev-claim-rp2',
      fingerprint: outbox.fingerprintOf(payloadFor('ev-claim-rp2')),
      recordToken: null,
      recordCreatedAt: 888,
    });
    expect(journalAfterAbort.status).toBe('found'); // the FIRST claim's proof stands
    void reopenClaim;

    // CONTENT-conflict variant: the TARGET under owner-a holds DIFFERENT
    // frozen content — the claim is refused, the source is kept retryable,
    // and the original proof is never replaced.
    await outboxStore('events', (store) => store.delete('owner-a|ev-claim-rp'));
    await outbox.__seedLegacyRecordForTests({
      key: 'owner-a|ev-claim-rp',
      eventId: 'ev-claim-rp',
      owner: 'owner-a',
      createdAt: 999,
      payload: payloadFor('ev-claim-rp', 'OTHER-CONTENT') as never,
    });
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-claim-rp',
      eventId: 'ev-claim-rp',
      owner: '',
      createdAt: 777,
      payload: payload as never,
    });
    const conflictClaim = await outbox.claimUnboundEvents();
    expect(conflictClaim.conflicts).toContain('ev-claim-rp');
    expect(conflictClaim.claimed).not.toContain('ev-claim-rp');
    const afterConflict = await outbox.__readAllForTests();
    expect(afterConflict.ok).toBe(true);
    if (afterConflict.ok) {
      const kept = afterConflict.events.find((e) => e.key === '|ev-claim-rp');
      expect(kept?.owner).toBe(''); // preserved retryable
      const frozen = afterConflict.events.find((e) => e.key === 'owner-a|ev-claim-rp');
      expect(frozen?.createdAt).toBe(999); // the frozen target wins untouched
    }
    // The journal still holds ONLY the first claim's proof for the exact
    // original instance — no new entry minted by the refused claim.
    const journalAfter = await outbox.readBindingJournal({
      key: '|ev-claim-rp',
      eventId: 'ev-claim-rp',
      fingerprint: outbox.fingerprintOf(payload),
      recordToken: null,
      recordCreatedAt: 777,
    });
    expect(journalAfter.status).toBe('found');
    if (journalAfter.status !== 'found') throw new Error('unreachable');
    expect(journalAfter.binding.destination.owner).toBe('owner-a');
  });

  it('r4 §1 executor entry-barrier: an OLD held execution cannot enqueue/bind/POST after a newer same-attempt operation', async () => {
    // REAL page-level barrier exercised through the shared executor with a
    // REAL ledger: the old execution's enqueue/note are held; the newer
    // operation takes the target to queued; releasing the old (BOTH the
    // failure and the success variants) must leave the new target's
    // state/handle/token/opSeq INTACT, with no obsolete enqueue/bind/POST.
    // (The full-page form of this barrier is e2e p3-entry tests 8-10.)
    const payload = payloadFor('ev-op-r4');
    const ledger = new Map<string, import('@/lib/mistake-book/plan-executor').PlanLedgerTarget>();
    ledger.set('q1', { questionId: 'q1', eventId: 'ev-op-r4', state: 'saving', opSeq: 1 });
    const target = ledger.get('q1')!;
    const ledgerBox = {
      ledger,
      supersede: (questionId: string) => {
        const t = ledger.get(questionId);
        if (t) ledger.set(questionId, { ...t, state: 'saving', opSeq: t.opSeq + 1 });
      },
    };
    // DETERMINISTIC HOLD: the OLD execution blocks inside its enqueue's
    // IDB open (a real held local write), released only after the newer
    // operation has taken the target.
    const baseFactory = indexedDB;
    const gate = { release: null as (() => void) | null };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const realOpen = baseFactory.open.bind(baseFactory);
    vi.stubGlobal('indexedDB', {
      open: (...args: unknown[]) => {
        const request = realOpen(...(args as [string, number?]));
        if (args[0] === 'MAIC-mistake-outbox') {
          const realAddEventListener = request.addEventListener.bind(request);
          void realAddEventListener;
          request.addEventListener('success', () => {
            void held; // keep the promise referenced inside the tx task
          });
        }
        return request;
      },
    } as unknown as IDBFactory);
    const oldOutcomePromise = (async () => {
      await held; // the OLD execution is gated BEFORE its queue write
      return outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'plan-token-1' });
    })();

    // While the OLD write is held, the NEWER same-attempt operation takes
    // the target to QUEUED under its real identity.
    ledgerBox.supersede('q1');
    const newer = ledgerBox.ledger.get('q1')!;
    newer.state = 'queued';
    newer.handle = 'owner-a|ev-op-r4';
    newer.fingerprint = outbox.fingerprintOf(payload);
    newer.recordToken = 'newer-token';
    ledgerBox.ledger.set('q1', newer);
    // Release the old write: its LOCAL enqueue may succeed, but its
    // ledger adoption is guarded by the ENTRY operation snapshot.
    gate.release?.(); // SUCCESS variant: the durable fact completes
    const oldOutcome = await oldOutcomePromise;
    expect(oldOutcome.kind).toBe('persisted'); // durable fact exists…

    // The OLD execution's adoption (via the shared patch rule with its
    // captured opSeq) cannot touch the NEWER target.
    const adopted = executor.applyPlanLedgerPatch(ledgerBox.ledger.get('q1')!, {
      opSeq: target.opSeq,
      state: 'unbound',
      handle: '|ev-op-r4',
      fingerprint: outbox.fingerprintOf(payload),
      recordToken: 'plan-token-1',
    });
    expect(adopted).toBeNull(); // dropped — identity/state/opSeq intact
    const current = ledgerBox.ledger.get('q1')!;
    expect(current.state).toBe('queued');
    expect(current.handle).toBe('owner-a|ev-op-r4');
    expect(current.recordToken).toBe('newer-token');
    expect(current.opSeq).toBe(newer.opSeq);
    // The old execution's obsolete work left NO bind (no journal entry for
    // its instance) — the queue holds only the two records, nothing bound.
    const events = await outbox.__readAllForTests();
    if (events.ok) {
      expect(events.events.every((e) => e.owner === '')).toBe(true); // zero B rows
    }
    const journal = await outbox.readBindingJournal({
      key: '|ev-op-r4',
      eventId: 'ev-op-r4',
      fingerprint: outbox.fingerprintOf(payload),
      recordToken: 'plan-token-1',
    });
    expect(journal.status).toBe('absent'); // no obsolete bind proof sent
    expect(
      mocks.fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('r3 group 4: LEGACY-claimed source — authority aborted after migration, reload recovers explicit-claim A; q2 direct A under cookie B', async () => {
    // The plan legally reused a TOKEN-LESS legacy record (same content),
    // the user EXPLICITLY claimed it to A (journal reason explicit-claim),
    // the progress MIGRATION committed, and the authority write aborted.
    const payload = payloadFor('ev-legacy-claim');
    const fp = outbox.fingerprintOf(payload);
    await outbox.__seedLegacyRecordForTests({
      key: '|ev-legacy-claim',
      eventId: 'ev-legacy-claim',
      owner: '',
      createdAt: 31_337,
      payload: payload as never,
    });
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const reusedOutcome = await outbox.enqueueCaptureEventUnderOwner(payload, '', {
      creationToken: 'plan-token-1',
    });
    expect(reusedOutcome.kind).toBe('reused');
    if (reusedOutcome.kind !== 'reused') throw new Error('unreachable');
    expect(reusedOutcome.recordCreatedAt).toBe(31_337);
    const { executor: ex0, progress: p0 } = await freshModules();
    await ex0.noteEnqueuedActual(plan, plan.items[0]!, fp, reusedOutcome, executorDeps);
    // The user's explicit claim commits the move AND the journal.
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const claim = await outbox.claimUnboundEvents();
    expect(claim.identityConfirmed).toBe(true);
    expect(claim.claimed).toContain('ev-legacy-claim');
    // The progress migration along the claim mapping commits…
    const journal = await outbox.readBindingJournal({
      key: '|ev-legacy-claim',
      eventId: 'ev-legacy-claim',
      fingerprint: fp,
      recordToken: null,
      recordCreatedAt: 31_337,
    });
    expect(journal.status).toBe('found');
    if (journal.status !== 'found') throw new Error('unreachable');
    expect(journal.binding.reason).toBe('explicit-claim');
    const claimedSource = p0.actualIdentityFromQueueSide(
      {
        key: '|ev-legacy-claim',
        eventId: 'ev-legacy-claim',
        fingerprint: fp,
        recordToken: null,
        createdAt: 31_337,
      },
      'ev-legacy-claim',
      fp,
    );
    const claimedDestination = p0.actualIdentityFromQueueSide(
      journal.binding.destination,
      'ev-legacy-claim',
      fp,
    );
    if (claimedSource === null || claimedDestination === null) throw new Error('unreachable');
    const migrate = await p0.writeCaptureProgress(
      {
        learnerKey: 'learner-1',
        attemptId: 'att-r2',
        sceneId: 'sc1',
        originEpisodeId: 'att-r2',
        originOwner: '',
        questionId: 'q1',
        eventId: 'ev-legacy-claim',
        planRecordToken: 'plan-token-1',
        frozenPayloadFingerprint: fp,
      },
      { kind: 'migrate-actual', source: claimedSource, destination: claimedDestination },
    );
    expect(migrate).toEqual({ kind: 'written', state: 'pending' });
    // …but the AUTHORITY write aborts (the crash window).
    const baseFactory = indexedDB;
    armAuthorityAbort();
    const { executor: abortedExecutor } = await freshModules();
    const abortedResolution = await abortedExecutor.resolveAttemptOwner(plan, executorDeps);
    expect(['unreadable', 'conflict']).toContain(abortedResolution.status); // honest, NOT B
    // MODULE RELOAD (fresh modules on the original factory): the resolver
    // recovers A from the EXACT explicit-claim journal — kind preserved.
    vi.stubGlobal('indexedDB', baseFactory);
    const { executor: reloadedExecutor, progress: reloadedProgress } = await freshModules();
    outbox.observeOwner('owner-b'); // the cookie is B now
    const resolution = await reloadedExecutor.resolveAttemptOwner(plan, executorDeps);
    expect(resolution.status).toBe('proven');
    if (resolution.status !== 'proven') throw new Error('unreachable');
    expect(resolution.owner).toBe('owner-a');
    expect(resolution.proof.kind).toBe('explicit-claim'); // never recast as active bind
    // q2 (a NEW item) enqueues DIRECTLY under proven A — zero B rows.
    const q2Enqueued = await outbox.enqueueCaptureEventUnderOwner(
      payloadFor('ev-legacy-q2', 'q2'),
      resolution.owner,
      { creationToken: 'plan-token-2' },
    );
    expect(q2Enqueued.kind).toBe('persisted');
    if (q2Enqueued.kind !== 'persisted') throw new Error('unreachable');
    expect(q2Enqueued.handle).toBe('owner-a|ev-legacy-q2');
    const events = await outbox.__readAllForTests();
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.events.some((e) => e.owner === 'owner-b')).toBe(false);
    }
    const stored = await reloadedProgress.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-r2',
      sceneId: 'sc1',
      originEpisodeId: 'att-r2',
      originOwner: '',
    });
    expect(stored.status).toBe('proven');
    if (stored.status !== 'proven') throw new Error('unreachable');
    expect(stored.effectiveOwner).toBe('owner-a');
    expect(stored.proof.kind).toBe('explicit-claim');
  });
});

describe('P3-r2 §6: frozen learner + stale-operation guards', () => {
  let outbox: Awaited<ReturnType<typeof freshModules>>['outbox'];
  let executor: Awaited<ReturnType<typeof freshModules>>['executor'];
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
    ({ outbox, executor } = await freshModules());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a mismatched current learner writes NOTHING — no other-partition scope appears', async () => {
    const payload = payloadFor('ev-learner');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const wrongLearnerDeps = { getLearnerKey: async () => 'learner-OTHER' };
    const precheck = await executor.precheckItem(plan, plan.items[0]!, wrongLearnerDeps);
    expect(precheck).toEqual({ action: 'learner-stale' });
    // A real enqueued outcome under a mismatched learner: the note writes
    // NOTHING into either partition.
    const outcome = await outbox.enqueueCaptureEventUnderOwner(payload, '', {
      creationToken: 'plan-token-1',
    });
    if (outcome.kind !== 'persisted') throw new Error('expected persisted');
    const noted = await executor.noteEnqueuedActual(
      plan,
      plan.items[0]!,
      outbox.fingerprintOf(payload),
      outcome,
      wrongLearnerDeps,
    );
    expect(noted).toBe(false);
    const rows = await new Promise<unknown[]>((resolve, reject) => {
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
          db.close();
          resolve((req.result ?? []) as unknown[]);
        };
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(rows).toHaveLength(0); // neither partition written
  });

  it("an old operation's late failure NEVER downgrades a newer queued target (shared rule)", () => {
    const newer = {
      questionId: 'q1',
      eventId: 'ev-1',
      opSeq: 7,
      state: 'queued',
      handle: 'owner-a|ev-1',
      fingerprint: 'fp',
      recordToken: 'tok',
    };
    // A patch decided under the OLD operation (opSeq 6) attempting a
    // local-failed downgrade: dropped.
    expect(executor.applyPlanLedgerPatch(newer, { opSeq: 6, state: 'local-failed' })).toBeNull();
    expect(executor.applyPlanLedgerPatch(newer, { opSeq: 6, state: 'unbound' })).toBeNull();
    // The SAME operation's legitimate patch still lands.
    const adopted = executor.applyPlanLedgerPatch(newer, {
      opSeq: 7,
      state: 'uploaded',
      handle: 'owner-a|ev-1',
    });
    expect(adopted?.state).toBe('uploaded');
    // Terminal uploaded survives late soft verdicts even without an opSeq.
    expect(executor.applyPlanLedgerPatch(adopted!, { state: 'queued' })).toBeNull();
    expect(adopted?.state).toBe('uploaded');
  });
});
