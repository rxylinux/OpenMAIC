/**
 * P4 REAL empty-report race, both consumers (C2-P4 design): after the
 * original caller's BIND transaction commits but before its readAll
 * completes, a second real consumer uploads and deletes the exact
 * destination row. The released original must return uploaded=[] with its
 * OWN committed mapping; the real plan consumer then migrates progress
 * through the full mapping and settles the ledger exactly once via the
 * exact durable receipt. Same-content tokenless LEGACY dedupe target uses
 * its OWN date; mismatched receipts upgrade nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { MistakeCapturePayload } from '@/lib/mistake-book/client';
import type { QuizCapturePlan, QuizCapturePlanItem } from '@/lib/quiz/runtime';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body }) as Response;

function payloadFor(eventId: string): MistakeCapturePayload {
  return {
    eventId,
    stageId: 's1',
    stageName: '课',
    sceneId: 'sc1',
    items: [{ eventId, questionId: 'q1', questionType: 'single', question: 'a?', userAnswer: 'B' }],
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
    originEpisodeId: 'att-1',
    attemptId: 'att-1',
    sceneId: 'sc1',
    learnerKey: 'learner-1',
    items,
  };
}

/**
 * The REAL ledger wiring (QuizView's patchLedger semantics), mirroring
 * plan-executor-p3's harness.
 */
function makeLedger() {
  const ledger = new Map<string, import('@/lib/mistake-book/plan-executor').PlanLedgerTarget>();
  let opSeq = 0;
  return {
    ledger,
    register: (questionId: string, eventId: string) => {
      opSeq += 1;
      ledger.set(questionId, { questionId, eventId, state: 'saving', opSeq });
      return ledger.get(questionId)!;
    },
    deps: () => ({
      getLearnerKey: async () => 'learner-1',
      stillCurrent: () => true,
      getTarget: (questionId: string) => ledger.get(questionId),
      patchLedger: (
        questionId: string,
        patch: Partial<import('@/lib/mistake-book/plan-executor').PlanLedgerTarget>,
      ) => {
        const target = ledger.get(questionId);
        if (!target) return;
        if (patch.opSeq !== undefined && patch.opSeq !== target.opSeq) return;
        if (target.state === 'uploaded' && patch.state !== 'uploaded') return;
        if (target.state === 'conflict' && patch.state !== 'conflict') return;
        ledger.set(questionId, { ...target, ...patch } as typeof target);
      },
    }),
  };
}

/**
 * Hold the SECOND `MAIC-mistake-outbox` open AFTER arming: armed right
 * before the original caller's flush, open #1 is its bind transaction and
 * open #2 is its readAll — parked with the real DB already open (a proxy
 * captures the success handler; release replays it). Later opens pass.
 */
function installHeldSecondOpen() {
  // Wrap the CURRENTLY ACTIVE factory (the test's seeded database), never a
  // fresh one — the seeded rows must stay visible to every later operation.
  const realFactory = globalThis.indexedDB as unknown as IDBFactory;
  let opens = 0;
  let releaseHold!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let heldArrived = false;
  const wrappedOpen = (...args: unknown[]) => {
    opens += 1;
    const request = (realFactory.open as (...a: unknown[]) => IDBOpenDBRequest)(...args);
    if (opens === 2 && String(args[0]) === 'MAIC-mistake-outbox') {
      heldArrived = true;
      const successHandlers: Array<(event: { target: unknown }) => void> = [];
      const proxy = new Proxy(request, {
        get(target, prop, receiver) {
          if (prop === 'onsuccess') return successHandlers[0] ?? null;
          if (prop === 'addEventListener') {
            return (type: string, listener: (event: unknown) => void) => {
              if (type === 'success') {
                successHandlers.push(listener as (event: { target: unknown }) => void);
                return;
              }
              return target.addEventListener(type, listener as EventListener);
            };
          }
          void receiver;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, prop, value) {
          if (prop === 'onsuccess') {
            successHandlers[0] = value as (event: { target: unknown }) => void;
            return true;
          }
          Reflect.set(target, prop, value);
          return true;
        },
      });
      void gate.then(() => {
        for (const handler of successHandlers.splice(0)) {
          handler.call(proxy, { target: proxy });
        }
      });
      return proxy;
    }
    return request;
  };
  vi.stubGlobal(
    'indexedDB',
    new Proxy(realFactory, {
      get(target: IDBFactory, prop: string | symbol) {
        if (prop === 'open') return wrappedOpen;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
  return {
    releaseHold,
    held: () => heldArrived,
  };
}

describe('P4 real empty-report race (both consumers, real outbox operations)', () => {
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('fetch', mocks.fetchMock);
    mocks.fetchMock.mockReset();
    mocks.fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
      }
      return jsonResponse({ success: true, data: { count: 0 } }, { 'x-owner-id': 'owner-a' });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('original bind committed + background consumer uploads/deletes → released original returns uploaded=[] with ITS mapping; the real consumer settles once via the exact receipt', async () => {
    vi.resetModules();
    const moduleA = await import('@/lib/mistake-book/outbox');
    vi.resetModules();
    const modulesB = await import('@/lib/mistake-book/outbox');
    const executorB = await import('@/lib/mistake-book/plan-executor');
    vi.resetModules();
    // The consumer runs on the caller's module view for report correlation.
    const modulesA = await import('@/lib/mistake-book/outbox');
    const executorA = await import('@/lib/mistake-book/plan-executor');

    const payload = payloadFor('ev-race-empty');
    const plan = unknownPlan([itemFor('q1', 'tok-race-empty', payload)]);
    const ledgerBox = makeLedger();
    // The page's real entry: enqueue unbound + durable note + ledger adopt.
    const target = ledgerBox.register('q1', 'ev-race-empty');
    const outcome = await modulesA.enqueueCaptureEventUnderOwner(payload, '', {
      creationToken: 'tok-race-empty',
    });
    expect(outcome.kind).toBe('persisted');
    if (outcome.kind !== 'persisted' && outcome.kind !== 'reused') {
      throw new Error('unexpected enqueue outcome');
    }
    await executorA.noteEnqueuedActual(
      plan,
      plan.items[0]!,
      modulesA.fingerprintOf(payload),
      outcome,
      { getLearnerKey: async () => 'learner-1' },
    );
    ledgerBox.ledger.set('q1', executorA.adoptEnqueuedOutcome(target, outcome, ''));
    expect(ledgerBox.ledger.get('q1')?.state).toBe('unbound');

    // Arm the readAll hold, then start the ORIGINAL caller's flush: its
    // bind transaction COMMITS (move + journal + mapping) and its readAll
    // parks on the held open.
    const hold = installHeldSecondOpen();
    const passA = modulesA.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-race-empty', creationToken: 'tok-race-empty' }],
    });
    await vi.waitFor(() => expect(hold.held()).toBe(true));

    // The SECOND real consumer (separate module — a background page/tab
    // flush): uploads and deletes the exact destination row.
    const reportB = await modulesB.flushOutbox();
    expect(reportB.uploaded).toHaveLength(1);
    expect(reportB.uploaded[0]!.key).toBe('owner-a|ev-race-empty');
    const readAfterB = await modulesB.__readAllForTests();
    expect(readAfterB.ok ? readAfterB.events : ['leftover']).toEqual([]);

    // Release the original read: EMPTY queue, its OWN committed mapping.
    hold.releaseHold();
    const reportA = await passA;
    expect(reportA.uploaded).toHaveLength(0); // the true empty-report race
    expect(reportA.committedBinds).toHaveLength(1);
    const mapping = reportA.committedBinds[0]!;
    expect(mapping.source.key).toBe('|ev-race-empty');
    expect(mapping.source.recordToken).toBe('tok-race-empty');
    expect(mapping.destination.key).toBe('owner-a|ev-race-empty');
    expect(mapping.destination.recordToken).toBe('tok-race-empty'); // move keeps the token

    // ONE transport POST for the whole race; the server saw the event once.
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);

    // The REAL consumer settles the ledger ONCE through the exact durable
    // receipt + the full committed mapping (migrate → receipt confirm).
    const consumed = await executorA.consumeReportForPlan(plan, reportA, ledgerBox.deps());
    expect(consumed).toBe(true);
    const settled = ledgerBox.ledger.get('q1')!;
    expect(settled.state).toBe('uploaded');
    expect(settled.handle).toBe('owner-a|ev-race-empty'); // migrated destination handle
    expect(settled.recordToken).toBe('tok-race-empty');

    // The exact durable receipt exists and STRICTLY matches this instance;
    // every mismatched plane (token/date/fingerprint/owner-key) matches 0.
    const receiptQuery = {
      key: 'owner-a|ev-race-empty',
      fingerprint: modulesA.fingerprintOf(payload),
      recordToken: 'tok-race-empty',
    };
    const exact = await modulesA.readReceipts([receiptQuery]);
    expect(exact.ok && exact.matched).toHaveLength(1);
    const wrongToken = await modulesA.readReceipts([
      { ...receiptQuery, recordToken: 'OTHER-token' },
    ]);
    expect(wrongToken.ok ? wrongToken.matched.length : -1).toBe(0);
    const wrongFingerprint = await modulesA.readReceipts([
      { ...receiptQuery, fingerprint: 'OTHER-fingerprint' },
    ]);
    expect(wrongFingerprint.ok ? wrongFingerprint.matched.length : -1).toBe(0);
    const wrongKey = await modulesA.readReceipts([
      { ...receiptQuery, key: 'owner-b|ev-race-empty' },
    ]);
    expect(wrongKey.ok ? wrongKey.matched.length : -1).toBe(0);
    void executorB;
    void moduleA;
  });

  it('same-content tokenless LEGACY dedupe target: the mapping destination uses its OWN date — never the source token/date — and settles through that legacy receipt', async () => {
    vi.resetModules();
    const modulesA = await import('@/lib/mistake-book/outbox');
    vi.resetModules();
    const modulesB = await import('@/lib/mistake-book/outbox');
    vi.resetModules();
    const executorA = await import('@/lib/mistake-book/plan-executor');

    const payload = payloadFor('ev-legacy-race');
    const plan = unknownPlan([itemFor('q1', 'tok-legacy-race', payload)]);
    const ledgerBox = makeLedger();
    // A pre-existing LEGACY tokenless target under owner-a with the EXACT
    // frozen content; the unbound source twin enqueues beside it.
    await modulesA.__seedLegacyRecordForTests({
      key: 'owner-a|ev-legacy-race',
      eventId: 'ev-legacy-race',
      owner: 'owner-a',
      createdAt: 42_424_242,
      payload: payload as never,
    });
    const target = ledgerBox.register('q1', 'ev-legacy-race');
    const outcome = await modulesA.enqueueCaptureEventUnderOwner(payload, '', {
      creationToken: 'tok-legacy-race',
    });
    expect(outcome.kind).toBe('persisted');
    if (outcome.kind !== 'persisted' && outcome.kind !== 'reused') {
      throw new Error('unexpected enqueue outcome');
    }
    ledgerBox.ledger.set('q1', executorA.adoptEnqueuedOutcome(target, outcome, ''));

    const hold = installHeldSecondOpen();
    const passA = modulesA.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-legacy-race', creationToken: 'tok-legacy-race' }],
    });
    await vi.waitFor(() => expect(hold.held()).toBe(true));

    // The background consumer uploads and deletes the LEGACY destination.
    const reportB = await modulesB.flushOutbox();
    expect(reportB.uploaded).toHaveLength(1);
    expect(reportB.uploaded[0]!.key).toBe('owner-a|ev-legacy-race');
    expect(reportB.uploaded[0]!.recordToken).toBeNull(); // the legacy plane
    expect(reportB.uploaded[0]!.createdAt).toBe(42_424_242);

    hold.releaseHold();
    const reportA = await passA;
    expect(reportA.uploaded).toHaveLength(0);
    expect(reportA.committedBinds).toHaveLength(1);
    const mapping = reportA.committedBinds[0]!;
    expect(mapping.destination.key).toBe('owner-a|ev-legacy-race');
    expect(mapping.destination.recordToken).toBeNull(); // its OWN plane
    expect(mapping.destination.createdAt).toBe(42_424_242); // its OWN date
    expect(mapping.source.recordToken).toBe('tok-legacy-race'); // source keeps its token

    // The real consumer migrates through the full mapping and settles via
    // the legacy date receipt.
    expect(await executorA.consumeReportForPlan(plan, reportA, ledgerBox.deps())).toBe(true);
    const settled = ledgerBox.ledger.get('q1')!;
    expect(settled.state).toBe('uploaded');
    expect(settled.handle).toBe('owner-a|ev-legacy-race');
    expect(settled.recordToken).toBeUndefined(); // legacy plane adopted
    expect(settled.recordCreatedAt).toBe(42_424_242);
    // The legacy receipt matches ONLY with the real date; a modern token
    // query never matches it.
    const legacyReceipt = await modulesA.readReceipts([
      {
        key: 'owner-a|ev-legacy-race',
        fingerprint: modulesA.fingerprintOf(payload),
        recordToken: null,
        createdAt: 42_424_242,
      },
    ]);
    expect(legacyReceipt.ok && legacyReceipt.matched).toHaveLength(1);
    const modernProbe = await modulesA.readReceipts([
      {
        key: 'owner-a|ev-legacy-race',
        fingerprint: modulesA.fingerprintOf(payload),
        recordToken: 'tok-legacy-race',
      },
    ]);
    expect(modernProbe.ok ? modernProbe.matched.length : -1).toBe(0);
  });
  it('BOTH consumers: the REAL client consumer (captureMistakesFromQuiz) also settles an empty-report race through its own receipt confirm', async () => {
    // The plan consumer (consumeReportForPlan) is exercised above; this run
    // executes the OTHER real consumer — the legacy client capture path —
    // with the same race: its internal flush's readAll parks after its
    // enqueue committed; a second module uploads+deletes the exact record;
    // the released client gets an EMPTY report and must NOT borrow the
    // other sender's success — its own receipt replay confirms.
    vi.resetModules();
    const clientModule = await import('@/lib/mistake-book/client');
    const clientOutbox = await import('@/lib/mistake-book/outbox');
    vi.resetModules();
    const moduleB = await import('@/lib/mistake-book/outbox');

    const payloadClient: MistakeCapturePayload = {
      eventId: 'ev-client-race',
      stageId: 's1',
      stageName: '课',
      sceneId: 'sc1',
      items: [
        {
          eventId: 'ev-client-race',
          questionId: 'q1',
          questionType: 'single',
          question: 'a?',
          userAnswer: 'B',
        },
      ],
    };

    // Hold the CLIENT's flush readAll: after arming, its opens are #1 the
    // client's enqueue, #2 the flush's bind-step open (candidates miss, the
    // open still happens), #3 the flush's readAll.
    const realFactory = globalThis.indexedDB as unknown as IDBFactory;
    let opens = 0;
    let releaseHold!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let heldArrived = false;
    const wrappedOpen = (...args: unknown[]) => {
      opens += 1;
      const request = (realFactory.open as (...a: unknown[]) => IDBOpenDBRequest)(...args);
      if (opens === 3 && String(args[0]) === 'MAIC-mistake-outbox') {
        heldArrived = true;
        const successHandlers: Array<(event: { target: unknown }) => void> = [];
        const proxy = new Proxy(request, {
          get(target: IDBOpenDBRequest, prop: string | symbol) {
            if (prop === 'onsuccess') return successHandlers[0] ?? null;
            if (prop === 'addEventListener') {
              return (
                type: string,
                listener: (event: { target: unknown; type: string }) => void,
              ) => {
                if (type === 'success') {
                  successHandlers.push(listener as (event: { target: unknown }) => void);
                }
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target: IDBOpenDBRequest, prop: string | symbol, value: unknown) {
            if (prop === 'onsuccess') {
              successHandlers[0] = value as (event: { target: unknown }) => void;
              return true;
            }
            Reflect.set(target, prop, value);
            return true;
          },
        });
        void gate.then(() => {
          for (const handler of successHandlers.splice(0)) {
            handler.call(proxy, { target: proxy });
          }
        });
        return proxy;
      }
      return request;
    };
    vi.stubGlobal(
      'indexedDB',
      new Proxy(realFactory, {
        get(target: IDBFactory, prop: string | symbol) {
          if (prop === 'open') return wrappedOpen;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );

    const capturePromise = clientModule.captureMistakesFromQuiz(payloadClient);
    await vi.waitFor(() => expect(heldArrived).toBe(true)); // readAll parked

    // The second real consumer uploads + deletes the exact record.
    const reportB = await moduleB.flushOutbox();
    expect(reportB.uploaded).toHaveLength(1);
    const readAfterB = await moduleB.__readAllForTests();
    expect(readAfterB.ok ? readAfterB.events : ['leftover']).toEqual([]);

    releaseHold();
    const result = await capturePromise;
    // The client's own receipt confirm settles every question honestly —
    // no borrowed verdict, exactly one transport POST overall.
    expect(result.questions.every((question) => question.state === 'uploaded')).toBe(true);
    expect(result.uploaded).toEqual(['ev-client-race']);
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    void clientOutbox;
  });
});
