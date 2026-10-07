/**
 * P3 §1 focused tests: the queue's STRICT structured evidence —
 * readCaptureEvidence (every identity plane must match; the returned side
 * carries the stored row's OWN metadata; read failures are 'unreadable',
 * never 'absent'), CommittedBindMapping sides built from the records
 * re-read inside the bind transaction (a legacy dedupe destination keeps
 * its OWN date, never the source's token), and readReceipts returning the
 * matched rows' full identity (never a bare key set).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import type { MistakeCapturePayload } from '@/lib/mistake-book/client';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function freshOutbox() {
  vi.resetModules();
  return await import('@/lib/mistake-book/outbox');
}

function payload(eventId: string, answer = 'B'): MistakeCapturePayload {
  return {
    eventId,
    stageId: 's1',
    stageName: '课',
    sceneId: 'sc1',
    items: [
      { eventId, questionId: 'q1', questionType: 'single', question: 'a', userAnswer: answer },
    ],
  };
}

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body }) as Response;

describe('P3 §1: strict capture-evidence query', () => {
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

  it("an exactly-matching queued record returns queued with the ROW's own side", async () => {
    outbox.observeOwner('owner-a');
    const enqueued = await outbox.enqueueCaptureEvent(payload('ev-exact'));
    if (enqueued.kind !== 'persisted') throw new Error('expected persisted');
    const verdict = await outbox.readCaptureEvidence({
      owner: 'owner-a',
      eventId: 'ev-exact',
      fingerprint: outbox.fingerprintOf(payload('ev-exact')),
      recordToken: enqueued.creationToken,
    });
    expect(verdict).toEqual({
      status: 'queued',
      side: {
        key: 'owner-a|ev-exact',
        owner: 'owner-a',
        eventId: 'ev-exact',
        fingerprint: outbox.fingerprintOf(payload('ev-exact')),
        recordToken: enqueued.creationToken,
      },
    });
  });

  it('formal counters: foreign owner / different fingerprint / different token never upgrade', async () => {
    outbox.observeOwner('owner-a');
    const enqueued = await outbox.enqueueCaptureEvent(payload('ev-counters'));
    if (enqueued.kind !== 'persisted') throw new Error('expected persisted');
    const fp = outbox.fingerprintOf(payload('ev-counters'));
    // Foreign owner: a DIFFERENT key entirely → absent (never their success):
    expect(
      await outbox.readCaptureEvidence({
        owner: 'owner-b',
        eventId: 'ev-counters',
        fingerprint: fp,
        recordToken: enqueued.creationToken,
      }),
    ).toEqual({ status: 'absent' });
    // Same key, different frozen content → conflict:
    expect(
      await outbox.readCaptureEvidence({
        owner: 'owner-a',
        eventId: 'ev-counters',
        fingerprint: outbox.fingerprintOf(payload('ev-counters', 'OTHER')),
        recordToken: enqueued.creationToken,
      }),
    ).toEqual({ status: 'conflict' });
    // Same key + content, DIFFERENT instance token → conflict:
    expect(
      await outbox.readCaptureEvidence({
        owner: 'owner-a',
        eventId: 'ev-counters',
        fingerprint: fp,
        recordToken: 'another-instance',
      }),
    ).toEqual({ status: 'conflict' });
    // r1 §4: a query that names NO instance plane is a boundary error —
    // "missing token" is never a permission to match the legacy plane.
    await expect(
      outbox.readCaptureEvidence({ owner: 'owner-a', eventId: 'ev-counters', fingerprint: fp }),
    ).rejects.toThrow(/instance plane/);
    // A legacy null query WITHOUT the real date is equally refused:
    await expect(
      outbox.readCaptureEvidence({
        owner: 'owner-a',
        eventId: 'ev-counters',
        fingerprint: fp,
        recordToken: null,
      }),
    ).rejects.toThrow(/createdAt/);
  });

  it('r1 §4: a REJECTED queued record is a permanent conflict, never "queued"', async () => {
    outbox.observeOwner('owner-a');
    const enqueued = await outbox.enqueueCaptureEvent(payload('ev-rej-status'));
    if (enqueued.kind !== 'persisted') throw new Error('expected persisted');
    // The server permanently refused this exact frozen content (400).
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) =>
      (init as RequestInit | undefined)?.method === 'POST'
        ? ({
            ok: false,
            status: 400,
            headers: new Headers({ 'x-owner-id': 'owner-a' }),
            json: async () => ({ errorCode: 'EVENT_PAYLOAD_CONFLICT' }),
          } as Response)
        : (jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }) as Response),
    );
    const report = await outbox.flushOutbox();
    expect(report.rejected.length).toBeGreaterThan(0);
    const verdict = await outbox.readCaptureEvidence({
      owner: 'owner-a',
      eventId: 'ev-rej-status',
      fingerprint: outbox.fingerprintOf(payload('ev-rej-status')),
      recordToken: enqueued.creationToken,
    });
    expect(verdict).toEqual({ status: 'conflict' }); // quarantined — not queued evidence
  });

  it('r1 §4: a torn receipt row (missing event/fingerprint) reads UNREADABLE, never fabricated', async () => {
    // Plant a corrupt receipt row directly: no eventId, no fingerprint.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('MAIC-mistake-outbox', 3);
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
        const tx = db.transaction('receipts', 'readwrite');
        tx.objectStore('receipts').put({ key: 'owner-a|ev-torn', recordToken: 'tok' });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    const verdict = await outbox.readCaptureEvidence({
      owner: 'owner-a',
      eventId: 'ev-torn',
      fingerprint: 'whatever',
      recordToken: 'tok',
    });
    expect(verdict).toEqual({ status: 'unreadable' }); // corrupt — never the query's values
  });

  it('r1 §4: readReceipts publishes ONLY on tx.complete — a GET late abort is ok:false', async () => {
    outbox.observeOwner('owner-a');
    const enqueued = await outbox.enqueueCaptureEvent(payload('ev-late-abort'));
    if (enqueued.kind !== 'persisted') throw new Error('expected persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox();
    // Abort every readonly transaction on the RECEIPTS store right after
    // its get request succeeds: staged matches must never publish.
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
            if (mode === 'readonly') {
              const realObjectStore = tx.objectStore.bind(tx);
              (tx as unknown as Record<string, unknown>)['objectStore'] = (name: string) => {
                const store = realObjectStore(name);
                if (name === 'receipts') {
                  const realGet = store.get.bind(store);
                  (store as unknown as Record<string, unknown>)['get'] = (
                    ...getArgs: unknown[]
                  ) => {
                    const getRequest = (realGet as (...a: unknown[]) => IDBRequest)(...getArgs);
                    getRequest.addEventListener('success', () => tx.abort(), { once: true });
                    return getRequest;
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
    const outbox2 = await freshOutbox();
    const result = await outbox2.readReceipts([
      {
        key: 'owner-a|ev-late-abort',
        fingerprint: outbox.fingerprintOf(payload('ev-late-abort')),
        recordToken: enqueued.creationToken,
      },
    ]);
    expect(result.ok).toBe(false); // late abort — staged matches discarded
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it('legacy receipts: the createdAt plane decides — a different date is conflict', async () => {
    outbox.observeOwner('owner-a');
    await outbox.__seedLegacyRecordForTests({
      key: 'owner-a|ev-legacy',
      eventId: 'ev-legacy',
      owner: 'owner-a',
      createdAt: 1_000,
      payload: payload('ev-legacy') as never,
    });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox();
    const fp = outbox.fingerprintOf(payload('ev-legacy'));
    // Exact legacy instance (null token + the SAME createdAt) → receipt:
    const matched = await outbox.readCaptureEvidence({
      owner: 'owner-a',
      eventId: 'ev-legacy',
      fingerprint: fp,
      recordToken: null,
      recordCreatedAt: 1_000,
    });
    expect(matched.status).toBe('receipt');
    if (matched.status !== 'receipt') throw new Error('unreachable');
    expect(matched.side).toEqual({
      key: 'owner-a|ev-legacy',
      owner: 'owner-a',
      eventId: 'ev-legacy',
      fingerprint: fp,
      recordToken: null,
      createdAt: 1_000,
    });
    // A DIFFERENT legacy date at the same key/content → conflict, no borrow:
    expect(
      await outbox.readCaptureEvidence({
        owner: 'owner-a',
        eventId: 'ev-legacy',
        fingerprint: fp,
        recordToken: null,
        recordCreatedAt: 2_000,
      }),
    ).toEqual({ status: 'conflict' });
    // Modern-token query against the legacy receipt → conflict:
    expect(
      await outbox.readCaptureEvidence({
        owner: 'owner-a',
        eventId: 'ev-legacy',
        fingerprint: fp,
        recordToken: 'modern-token',
      }),
    ).toEqual({ status: 'conflict' });
  });

  it('a committed receipt outranks nothing absent — and a read failure is unreadable, never absent', async () => {
    outbox.observeOwner('owner-a');
    const enqueued = await outbox.enqueueCaptureEvent(payload('ev-receipt'));
    if (enqueued.kind !== 'persisted') throw new Error('expected persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox(); // uploaded + deleted; the receipt remains
    const fp = outbox.fingerprintOf(payload('ev-receipt'));
    const verdict = await outbox.readCaptureEvidence({
      owner: 'owner-a',
      eventId: 'ev-receipt',
      fingerprint: fp,
      recordToken: enqueued.creationToken,
    });
    expect(verdict.status).toBe('receipt');
    // Read failure (db open error) → unreadable, NOT absent:
    vi.stubGlobal(
      'indexedDB',
      (() => {
        let onError: (() => void) | undefined;
        const request = {
          set onerror(cb: () => void) {
            onError = cb;
          },
        };
        setTimeout(() => onError?.(), 0);
        return { open: () => request } as unknown as IDBFactory;
      })(),
    );
    const outbox2 = await freshOutbox();
    expect(
      await outbox2.readCaptureEvidence({
        owner: 'owner-a',
        eventId: 'ev-receipt',
        fingerprint: fp,
        recordToken: enqueued.creationToken,
      }),
    ).toEqual({ status: 'unreadable' });
  });

  it("committed bind mapping sides carry the records' COMPLETE real identity", async () => {
    // A pre-existing LEGACY bound record under owner-a (token-less).
    await outbox.__seedLegacyRecordForTests({
      key: 'owner-a|ev-dedupe',
      eventId: 'ev-dedupe',
      owner: 'owner-a',
      createdAt: 5_000,
      payload: payload('ev-dedupe') as never,
    });
    // The plan's own UNBOUND record (modern, plan token) — same frozen content.
    const unbound = await outbox.enqueueCaptureEventUnderOwner(payload('ev-dedupe') as never, '', {
      creationToken: 'plan-token-1',
    });
    if (unbound.kind !== 'persisted') throw new Error('expected persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-dedupe', creationToken: 'plan-token-1' }],
    });
    expect(report.committedBinds).toHaveLength(1);
    const mapping = report.committedBinds[0]!;
    const fp = outbox.fingerprintOf(payload('ev-dedupe'));
    // Source: the plan's unbound modern instance, COMPLETE identity.
    expect(mapping.source).toEqual({
      key: '|ev-dedupe',
      owner: '',
      eventId: 'ev-dedupe',
      fingerprint: fp,
      recordToken: 'plan-token-1',
    });
    // Destination: the EXISTING LEGACY record's own identity — token null
    // and ITS createdAt, never the source's modern token.
    expect(mapping.destination).toEqual({
      key: 'owner-a|ev-dedupe',
      owner: 'owner-a',
      eventId: 'ev-dedupe',
      fingerprint: fp,
      recordToken: null,
      createdAt: 5_000,
    });
  });

  it("readReceipts returns the matched rows' OWN full identity; failures are ok:false", async () => {
    outbox.observeOwner('owner-a');
    const enqueued = await outbox.enqueueCaptureEvent(payload('ev-rows'));
    if (enqueued.kind !== 'persisted') throw new Error('expected persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox();
    const result = await outbox.readReceipts([
      {
        key: 'owner-a|ev-rows',
        fingerprint: outbox.fingerprintOf(payload('ev-rows')),
        recordToken: enqueued.creationToken,
      },
      // Same key + content but a DIFFERENT instance token: not matched.
      {
        key: 'owner-a|ev-rows',
        fingerprint: outbox.fingerprintOf(payload('ev-rows')),
        recordToken: 'other',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toEqual({
      key: 'owner-a|ev-rows',
      owner: 'owner-a',
      eventId: 'ev-rows',
      fingerprint: outbox.fingerprintOf(payload('ev-rows')),
      recordToken: enqueued.creationToken,
    });
    // A failed read is ok:false — never a downgrade to "no receipts".
    vi.stubGlobal(
      'indexedDB',
      (() => {
        let onError: (() => void) | undefined;
        const request = {
          set onerror(cb: () => void) {
            onError = cb;
          },
        };
        setTimeout(() => onError?.(), 0);
        return { open: () => request } as unknown as IDBFactory;
      })(),
    );
    const outbox2 = await freshOutbox();
    const failed = await outbox2.readReceipts([
      { key: 'owner-a|ev-rows', fingerprint: 'x', recordToken: 'y' },
    ]);
    expect(failed.ok).toBe(false);
  });
});
