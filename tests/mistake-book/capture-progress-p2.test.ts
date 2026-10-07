/**
 * P2 focused regression (progress design + early source review #1-#6): the
 * transactional capture-plan confirmation progress and the attempt-owner
 * authority boundary, with FORMAL COUNTER-TESTS for every reviewed defect:
 *
 * 1. actuals are SEMANTICALLY tied to their plan (event/fingerprint/owner
 *    planes); an absent scope accepts a first confirm only for the plan's
 *    own instance; confirmed requires an upload/receipt basis;
 * 2. mappings migrate ONLY a plan's unbound source to a bound destination —
 *    confirmed state is never copied onto another actual/owner, a known
 *    owner A never becomes B, wrong token/date/fingerprint sides are
 *    refused without downgrading;
 * 3. authority proofs carry the full sourcePlan (header-tied); a known-A
 *    header cannot record B; torn stored proofs read 'unreadable';
 * 4. the consumer-side builder accepts only sides carrying their OWN
 *    event/fingerprint metadata — a foreign-content side can never be
 *    washed into this plan's identity;
 * 5. reads resolve only on transaction completion (a late-aborted read
 *    REJECTS, never 'absent'); a blocked open that later succeeds closes
 *    the late connection; a synchronously throwing put fails the write
 *    with the previous state intact;
 * 6. unreadable/conflict read outcomes stay distinct from absent (honest
 *    branches — the QuizView adapter has them; here the statuses are
 *    pinned so no caller can conflate them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  actualIdentityFromQueueSide,
  readAttemptOwnerAuthority,
  readCaptureProgress,
  recordAttemptOwnerAuthority,
  writeCaptureProgress,
  type AttemptHeaderIdentity,
  type AuthorityBindProof,
  type LegacyActualIdentity,
  type ModernActualIdentity,
  type PlanIdentity,
} from '@/lib/mistake-book/progress';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function planIdentity(overrides: Partial<PlanIdentity> = {}): PlanIdentity {
  return {
    learnerKey: 'learner-1',
    attemptId: 'att-1',
    sceneId: 'sc-1',
    originEpisodeId: 'att-1',
    originOwner: 'owner-a',
    questionId: 'q1',
    eventId: 'ev-1',
    planRecordToken: 'plan-token-1',
    frozenPayloadFingerprint: 'fp-1',
    ...overrides,
  };
}

/** Default token MATCHES the plan token so happy-path confirms tie (review #1). */
function modernActual(overrides: Partial<ModernActualIdentity> = {}): ModernActualIdentity {
  return {
    kind: 'modern',
    key: 'owner-a|ev-1',
    owner: 'owner-a',
    eventId: 'ev-1',
    fingerprint: 'fp-1',
    recordToken: 'plan-token-1',
    ...overrides,
  };
}

function legacyActual(overrides: Partial<LegacyActualIdentity> = {}): LegacyActualIdentity {
  return {
    kind: 'legacy',
    key: 'owner-a|ev-1',
    owner: 'owner-a',
    eventId: 'ev-1',
    fingerprint: 'fp-1',
    recordToken: null,
    recordCreatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function headerIdentity(overrides: Partial<AttemptHeaderIdentity> = {}): AttemptHeaderIdentity {
  return {
    learnerKey: 'learner-1',
    attemptId: 'att-1',
    sceneId: 'sc-1',
    originEpisodeId: 'att-1',
    originOwner: '',
    ...overrides,
  };
}

/** A proof whose sourcePlan DERIVES from `header` (ties enforced at the boundary). */
function proofFor(
  header: AttemptHeaderIdentity,
  kind: AuthorityBindProof['kind'],
  source: ModernActualIdentity | LegacyActualIdentity,
  destination: ModernActualIdentity | LegacyActualIdentity,
): AuthorityBindProof {
  return {
    kind,
    sourcePlan: {
      learnerKey: header.learnerKey,
      attemptId: header.attemptId,
      sceneId: header.sceneId,
      originEpisodeId: header.originEpisodeId,
      originOwner: header.originOwner,
      questionId: 'q1',
      eventId: 'ev-1',
      planRecordToken: 'plan-token-1',
      frozenPayloadFingerprint: 'fp-1',
    },
    source,
    destination,
  };
}

/** Direct row access on the progress store — bypasses the module. Resolves
 * only after the transaction COMMITS (request success alone races). */
function directRow<T>(
  storeName: 'progress' | 'attempt-authority',
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
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
      const tx = db.transaction(storeName, 'readwrite');
      let result: T | undefined;
      const request = action(tx.objectStore(storeName));
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

/** Patch a factory's `method` on transactions of `storeName` in `mode`. */
function patchStoreMethod(
  base: IDBFactory,
  storeName: string,
  mode: IDBTransactionMode,
  method: 'get' | 'put',
  hook: (invoke: (...args: unknown[]) => unknown, tx: IDBTransaction) => unknown,
): IDBFactory {
  const realOpen = base.open.bind(base);
  return {
    open: (...args: unknown[]) => {
      const request = realOpen(...(args as [string, number?]));
      request.addEventListener('success', () => {
        const db = request.result as IDBDatabase;
        const realTransaction = db.transaction.bind(db);
        (db as unknown as Record<string, unknown>)['transaction'] = (
          stores: string | string[],
          txMode?: IDBTransactionMode,
        ) => {
          const tx = realTransaction(stores, txMode);
          if (txMode === mode) {
            const realObjectStore = tx.objectStore.bind(tx);
            (tx as unknown as Record<string, unknown>)['objectStore'] = (name: string) => {
              const store = realObjectStore(name);
              if (name === storeName) {
                const realMethod = (store as unknown as Record<string, unknown>)[method] as (
                  ...args: unknown[]
                ) => IDBRequest;
                (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
                  hook(() => realMethod(...args), tx) as IDBRequest;
              }
              return store;
            };
          }
          return tx;
        };
      });
      return request;
    },
  } as unknown as IDBFactory;
}

/** Quota-style late abort: the request succeeds, then the tx aborts. */
function wrapWithAbortingPuts(base: IDBFactory, storeName: string): IDBFactory {
  return patchStoreMethod(base, storeName, 'readwrite', 'put', (invoke, tx) => {
    const request = invoke() as IDBRequest;
    request.addEventListener('success', () => tx.abort(), { once: true });
    return request;
  });
}

/** A read whose get succeeds but whose transaction aborts afterwards. */
function wrapWithAbortingGets(base: IDBFactory, storeName: string): IDBFactory {
  return patchStoreMethod(base, storeName, 'readonly', 'get', (invoke, tx) => {
    const request = invoke() as IDBRequest;
    request.addEventListener('success', () => tx.abort(), { once: true });
    return request;
  });
}

/** A put that throws synchronously inside the request-success callback. */
function wrapWithThrowingPuts(base: IDBFactory, storeName: string): IDBFactory {
  return patchStoreMethod(base, storeName, 'readwrite', 'put', () => {
    throw new Error('put exploded synchronously');
  });
}

describe('C2-P2: transactional capture-plan progress (early-review fixes)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('1. full-identity confirmed round-trips and plan-tied actuals', () => {
    it('a modern confirm (the plan token) re-reads confirmed with basis upload', async () => {
      const plan = planIdentity();
      const actual = modernActual();
      expect(
        await writeCaptureProgress(plan, { kind: 'confirm', actual, basis: 'upload' }),
      ).toEqual({ kind: 'written', state: 'confirmed' });
      expect(await readCaptureProgress(plan)).toEqual({
        status: 'confirmed',
        actual,
        adoption: 'upload',
      });
    });

    it('an absent scope REFUSES a confirm whose token is not the plan instance', async () => {
      // A different-token modern instance cannot confirm an absent scope —
      // its adoption (reused/committed bind) must be durable FIRST.
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'confirm',
          actual: modernActual({ recordToken: 'rec-token-OTHER' }),
          basis: 'upload',
        }),
      ).toEqual({ kind: 'conflict-actual' });
      expect(await readCaptureProgress(planIdentity())).toEqual({ status: 'absent' });
      // Legacy instances are equally unadoptable on a bare confirm:
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'confirm',
          actual: legacyActual(),
          basis: 'receipt',
        }),
      ).toEqual({ kind: 'conflict-actual' });
    });

    it('a legal LEGACY confirm goes through its durable reused adoption first', async () => {
      const plan = planIdentity();
      const actual = legacyActual({ recordCreatedAt: 1_700_000_000_777 });
      expect(
        await writeCaptureProgress(plan, { kind: 'note-actual', actual, basis: 'enqueue-reused' }),
      ).toEqual({ kind: 'written', state: 'pending' });
      expect(
        await writeCaptureProgress(plan, { kind: 'confirm', actual, basis: 'receipt' }),
      ).toEqual({ kind: 'written', state: 'confirmed' });
      expect(await readCaptureProgress(plan)).toEqual({
        status: 'confirmed',
        actual,
        adoption: 'receipt',
      });
    });

    it('an untouched scope reads absent; a note reads pending with its actual', async () => {
      expect(await readCaptureProgress(planIdentity())).toEqual({ status: 'absent' });
      const actual = modernActual();
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual,
          basis: 'enqueue-persisted',
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
      expect(await readCaptureProgress(planIdentity())).toEqual({
        status: 'pending',
        actual,
        adoption: 'enqueue-persisted',
      });
    });

    it('the real P3 flow shape: persisted note → same-instance upload confirm', async () => {
      const plan = planIdentity();
      const actual = modernActual();
      expect(
        await writeCaptureProgress(plan, {
          kind: 'note-actual',
          actual,
          basis: 'enqueue-persisted',
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
      expect(
        await writeCaptureProgress(plan, { kind: 'confirm', actual, basis: 'upload' }),
      ).toEqual({ kind: 'written', state: 'confirmed' });
      expect((await readCaptureProgress(plan)).status).toBe('confirmed');
    });

    it('formal counters (review #1): same plan, another event/fp/owner actual is refused', async () => {
      const plan = planIdentity();
      await expect(
        writeCaptureProgress(plan, {
          kind: 'confirm',
          actual: modernActual({ eventId: 'ev-OTHER', key: 'owner-a|ev-OTHER' }),
          basis: 'upload',
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        writeCaptureProgress(plan, {
          kind: 'confirm',
          actual: modernActual({ fingerprint: 'fp-OTHER' }),
          basis: 'upload',
        }),
      ).rejects.toThrow(TypeError);
      // Known-origin plan A confirming under owner B:
      await expect(
        writeCaptureProgress(plan, {
          kind: 'confirm',
          actual: modernActual({ key: 'owner-b|ev-1', owner: 'owner-b' }),
          basis: 'upload',
        }),
      ).rejects.toThrow(/origin owner/);
      // Unbound confirm (unknown origin plan, owner ''):
      await expect(
        writeCaptureProgress(planIdentity({ originOwner: '' }), {
          kind: 'confirm',
          actual: modernActual({ key: '|ev-1', owner: '' }),
          basis: 'upload',
        }),
      ).rejects.toThrow(/non-empty/);
      expect(await readCaptureProgress(plan)).toEqual({ status: 'absent' }); // nothing written
    });

    it('r2 #1: an UNKNOWN plan NEVER confirms an absent scope — token alone is not a binding', async () => {
      const unknownPlan = planIdentity({ originOwner: '' });
      // Even the plan's OWN token under a plausible owner B (or A!) cannot
      // first-confirm an absent scope: the owner binding must be evidenced
      // by a PERSISTED committed mapping first.
      for (const owner of ['owner-b', 'owner-a']) {
        expect(
          await writeCaptureProgress(unknownPlan, {
            kind: 'confirm',
            actual: modernActual({ key: `${owner}|ev-1`, owner }),
            basis: 'upload',
          }),
        ).toEqual({ kind: 'conflict-actual' });
      }
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'confirm',
          actual: modernActual({ key: 'owner-b|ev-1', owner: 'owner-b' }),
          basis: 'receipt',
        }),
      ).toEqual({ kind: 'conflict-actual' });
      expect(await readCaptureProgress(unknownPlan)).toEqual({ status: 'absent' });
    });

    it('r2 #1: enqueue-persisted cannot note a LEGACY actual; fake bases never persist', async () => {
      // A freshly persisted record is the plan's own MODERN instance:
      await expect(
        writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual: legacyActual(),
          basis: 'enqueue-persisted',
        }),
      ).rejects.toThrow(/modern/);
      // Runtime basis whitelists — drifted strings are refused at the
      // boundary (nothing is written that would later read 'unreadable'):
      await expect(
        writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual: modernActual(),
          basis: 'enqueue-fabricated' as 'enqueue-persisted',
        }),
      ).rejects.toThrow(/whitelisted/);
      await expect(
        writeCaptureProgress(planIdentity(), {
          kind: 'confirm',
          actual: modernActual(),
          basis: 'assumed' as 'upload',
        }),
      ).rejects.toThrow(/whitelisted/);
      expect(await readCaptureProgress(planIdentity())).toEqual({ status: 'absent' });
    });

    it('note admission counters: foreign owner / mismatched persisted token throw', async () => {
      // Known-origin plan A cannot note an owner-B actual:
      await expect(
        writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual: modernActual({ key: 'owner-b|ev-1', owner: 'owner-b' }),
          basis: 'enqueue-persisted',
        }),
      ).rejects.toThrow(/origin owner/);
      // Unknown-origin plan cannot note a bound actual (nothing bound it):
      await expect(
        writeCaptureProgress(planIdentity({ originOwner: '' }), {
          kind: 'note-actual',
          actual: modernActual(),
          basis: 'enqueue-persisted',
        }),
      ).rejects.toThrow(/origin owner/);
      // enqueue-persisted basis must carry the PLAN token:
      await expect(
        writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual: modernActual({ recordToken: 'rec-token-OTHER' }),
          basis: 'enqueue-persisted',
        }),
      ).rejects.toThrow(/plan record token/);
      // The reused basis legitimately carries the REAL record token:
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual: modernActual({ recordToken: 'rec-token-REAL' }),
          basis: 'enqueue-reused',
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
    });
  });

  describe('2. different plans/actuals never borrow a success', () => {
    it('same-scope plan-field changes read conflict; scope moves read absent', async () => {
      await writeCaptureProgress(planIdentity(), {
        kind: 'confirm',
        actual: modernActual(),
        basis: 'upload',
      });
      for (const overrides of [
        { originOwner: 'owner-b' },
        { originOwner: '' },
        { frozenPayloadFingerprint: 'fp-2' },
        { planRecordToken: 'plan-token-2' },
        { sceneId: 'sc-2' },
        { originEpisodeId: 'ep-2' },
        { questionId: 'q2' },
      ] as Partial<PlanIdentity>[]) {
        expect((await readCaptureProgress(planIdentity(overrides))).status).toBe('conflict');
      }
      for (const overrides of [
        { learnerKey: 'learner-2' },
        { attemptId: 'att-2' },
        { eventId: 'ev-2' },
      ] as Partial<PlanIdentity>[]) {
        expect((await readCaptureProgress(planIdentity(overrides))).status).toBe('absent');
      }
    });

    it('a different-plan WRITE is refused (conflict-plan) and the original stays intact', async () => {
      const actual = modernActual();
      await writeCaptureProgress(planIdentity(), { kind: 'confirm', actual, basis: 'upload' });
      const foreign = planIdentity({ planRecordToken: 'plan-token-2', questionId: 'q2' });
      expect(
        await writeCaptureProgress(foreign, { kind: 'confirm', actual, basis: 'upload' }),
      ).toEqual({ kind: 'conflict-plan' });
      expect(await readCaptureProgress(planIdentity())).toEqual({
        status: 'confirmed',
        actual,
        adoption: 'upload',
      });
      expect((await readCaptureProgress(foreign)).status).toBe('conflict');
    });

    it('same key, different actual instance (token / legacy date / kind) cannot borrow', async () => {
      await writeCaptureProgress(planIdentity(), {
        kind: 'confirm',
        actual: modernActual(),
        basis: 'upload',
      });
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'confirm',
          actual: modernActual({ recordToken: 'rec-token-OTHER' }),
          basis: 'receipt',
        }),
      ).toEqual({ kind: 'conflict-actual' });
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'confirm',
          actual: legacyActual(),
          basis: 'receipt',
        }),
      ).toEqual({ kind: 'conflict-actual' });
      expect(await readCaptureProgress(planIdentity())).toEqual({
        status: 'confirmed',
        actual: modernActual(),
        adoption: 'upload',
      });

      const legacyPlan = planIdentity({ eventId: 'ev-legacy', questionId: 'qL' });
      const legacyInstance = legacyActual({
        key: 'owner-a|ev-legacy',
        eventId: 'ev-legacy',
        recordCreatedAt: 1,
      });
      await writeCaptureProgress(legacyPlan, {
        kind: 'note-actual',
        actual: legacyInstance,
        basis: 'enqueue-reused',
      });
      await writeCaptureProgress(legacyPlan, {
        kind: 'confirm',
        actual: legacyInstance,
        basis: 'receipt',
      });
      expect(
        await writeCaptureProgress(legacyPlan, {
          kind: 'confirm',
          actual: legacyActual({
            key: 'owner-a|ev-legacy',
            eventId: 'ev-legacy',
            recordCreatedAt: 2,
          }),
          basis: 'receipt',
        }),
      ).toEqual({ kind: 'conflict-actual' });
    });
  });

  describe('3. monotonicity, no cross-instance inheritance, concurrency barriers', () => {
    it('a same-instance pending note after confirmed NEVER downgrades', async () => {
      const actual = modernActual();
      await writeCaptureProgress(planIdentity(), { kind: 'confirm', actual, basis: 'upload' });
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual,
          basis: 'enqueue-reused',
        }),
      ).toEqual({ kind: 'written', state: 'confirmed' });
      expect(await readCaptureProgress(planIdentity())).toEqual({
        status: 'confirmed',
        actual,
        adoption: 'upload',
      });
    });

    it('a DIFFERENT-instance pending note on confirmed inherits nothing', async () => {
      const actual = modernActual();
      await writeCaptureProgress(planIdentity(), { kind: 'confirm', actual, basis: 'upload' });
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'note-actual',
          actual: modernActual({ recordToken: 'rec-token-OTHER' }),
          basis: 'enqueue-reused',
        }),
      ).toEqual({ kind: 'conflict-actual' });
      const after = await readCaptureProgress(planIdentity());
      expect(after.status).toBe('confirmed');
      if (after.status !== 'confirmed') throw new Error('unreachable');
      expect(after.actual).toEqual(actual);
    });

    it('concurrent same-actual writers end confirmed (no pending overwrite of a confirm)', async () => {
      const plan = planIdentity();
      const actual = modernActual();
      const ops = [
        writeCaptureProgress(plan, { kind: 'confirm', actual, basis: 'upload' }),
        ...Array.from({ length: 15 }, () =>
          writeCaptureProgress(plan, { kind: 'note-actual', actual, basis: 'enqueue-persisted' }),
        ),
      ];
      const results = await Promise.all(ops);
      expect(results.every((result) => result.kind === 'written')).toBe(true);
      expect(await readCaptureProgress(plan)).toEqual({
        status: 'confirmed',
        actual,
        adoption: 'upload',
      });
    });

    it('mixed same-scope concurrent writers stay serializable: confirmed(A) or pending(B) only', async () => {
      const plan = planIdentity();
      const actualA = modernActual(); // the plan's own instance
      const actualB = modernActual({ recordToken: 'rec-token-B' }); // a legal reused instance
      const confirmA = writeCaptureProgress(plan, {
        kind: 'confirm',
        actual: actualA,
        basis: 'upload',
      });
      const notes = Array.from({ length: 12 }, (_, i) =>
        writeCaptureProgress(plan, {
          kind: 'note-actual',
          actual: i % 3 === 0 ? actualB : actualA,
          basis: 'enqueue-reused',
        }),
      );
      const [confirmResult, ...noteResults] = await Promise.all([confirmA, ...notes]);
      const final = await readCaptureProgress(plan);
      if (final.status === 'confirmed') {
        expect(final.actual).toEqual(actualA);
        if (confirmResult.kind === 'written') expect(confirmResult.state).toBe('confirmed');
      } else if (final.status === 'pending') {
        expect(final.actual).toEqual(actualB); // a B-note committed BEFORE confirm-A
        expect(confirmResult).toEqual({ kind: 'conflict-actual' });
      } else {
        throw new Error(`illegal post-race state: ${JSON.stringify(final)}`);
      }
      expect(noteResults.every((r) => r.kind === 'written' || r.kind === 'conflict-actual')).toBe(
        true,
      );
    });

    it('parallel DIFFERENT scopes never interfere', async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => {
          const plan = planIdentity({ eventId: `ev-${i}`, questionId: `q${i}` });
          const actual = modernActual({ key: `owner-a|ev-${i}`, eventId: `ev-${i}` });
          return (async () => {
            await writeCaptureProgress(plan, {
              kind: 'note-actual',
              actual,
              basis: 'enqueue-persisted',
            });
            await writeCaptureProgress(plan, { kind: 'confirm', actual, basis: 'upload' });
          })();
        }),
      );
      for (let i = 0; i < 10; i++) {
        const verdict = await readCaptureProgress(
          planIdentity({ eventId: `ev-${i}`, questionId: `q${i}` }),
        );
        expect(verdict.status).toBe('confirmed');
      }
    });
  });

  describe('4. honest failures: unreadable rows, db errors, late aborts, lifecycle', () => {
    const scope = 'learner-1|att-1|ev-1';
    const validRow = () => ({
      progressVersion: 1,
      scope,
      planIdentity: planIdentity(),
      state: 'confirmed' as const,
      actual: modernActual(),
      adoption: 'upload' as const,
      updatedAt: 1,
    });

    it('corrupt/forward-version/identity-less rows read UNREADABLE — never absent', async () => {
      const corruptVariants: unknown[] = [
        { ...validRow(), progressVersion: 2 }, // unknown version
        { ...validRow(), planIdentity: { ...planIdentity(), planRecordToken: '' } },
        { ...validRow(), planIdentity: { ...planIdentity(), learnerKey: '' } },
        { ...validRow(), planIdentity: undefined },
        { ...validRow(), state: 'half-broken' },
        { ...validRow(), state: 'confirmed', actual: undefined }, // confirmed without actual
        { ...validRow(), actual: { ...modernActual(), recordToken: null } }, // broken union
        { ...validRow(), actual: { ...legacyActual(), recordCreatedAt: 'not-a-number' } },
        { ...validRow(), actual: { ...modernActual(), key: 'mismatched-key' } },
        { ...validRow(), adoption: 'made-up-basis' },
        // Semantic tears (review #1): shape-valid but drifted from its plan.
        {
          ...validRow(),
          actual: { ...modernActual(), eventId: 'ev-OTHER', key: 'owner-a|ev-OTHER' },
        },
        { ...validRow(), actual: { ...modernActual(), fingerprint: 'fp-OTHER' } },
        { ...validRow(), planIdentity: { ...planIdentity(), originOwner: 'owner-z' } },
        { ...validRow(), state: 'pending', adoption: 'upload' }, // confirmation basis on pending
        { ...validRow(), adoption: 'enqueue-persisted' }, // confirmed on an enqueue basis
        { ...validRow(), adoption: undefined }, // basis-less actual
      ];
      for (const variant of corruptVariants) {
        await directRow('progress', (store) => store.put(variant));
        expect(await readCaptureProgress(planIdentity())).toEqual({ status: 'unreadable' });
        await directRow('progress', (store) => store.clear());
      }
    });

    it('unreadable stays DISTINCT from absent for callers (no conflation)', async () => {
      expect(await readCaptureProgress(planIdentity())).toEqual({ status: 'absent' });
      await directRow('progress', (store) => store.put({ ...validRow(), progressVersion: 99 }));
      const unreadable = await readCaptureProgress(planIdentity());
      expect(unreadable).toEqual({ status: 'unreadable' });
      expect(unreadable).not.toEqual({ status: 'absent' });
    });

    it('r2 #2: bound-without-evidence, torn bind evidence, and impossible histories are unreadable', async () => {
      const unknownPlan = planIdentity({ originOwner: '' });
      const unbound = modernActual({ key: '|ev-1', owner: '' });
      const bound = modernActual();
      const intactBind = {
        source: unbound,
        destination: bound,
      };
      const bindRow = (overrides: Record<string, unknown> = {}) => ({
        progressVersion: 1,
        scope: 'learner-1|att-1|ev-1',
        planIdentity: unknownPlan,
        state: 'pending' as const,
        actual: bound,
        adoption: 'committed-bind' as const,
        committedBind: intactBind,
        updatedAt: 1,
        ...overrides,
      });
      const variants: Array<{ label: string; row: unknown; plan: PlanIdentity }> = [
        {
          label: 'unknown bound CONFIRMED without any bind evidence',
          row: { ...bindRow({ state: 'confirmed', adoption: 'upload' }), committedBind: undefined },
          plan: unknownPlan,
        },
        {
          label: 'unknown bound PENDING without any bind evidence',
          row: { ...bindRow(), committedBind: undefined },
          plan: unknownPlan,
        },
        {
          label: 'torn bind source event',
          row: bindRow({
            committedBind: {
              source: { ...unbound, eventId: 'ev-OTHER', key: '|ev-OTHER' },
              destination: bound,
            },
          }),
          plan: unknownPlan,
        },
        {
          label: 'torn bind source fingerprint',
          row: bindRow({
            committedBind: { source: { ...unbound, fingerprint: 'fp-X' }, destination: bound },
          }),
          plan: unknownPlan,
        },
        {
          label: 'torn bind source token (broken modern shape)',
          row: bindRow({
            committedBind: { source: { ...unbound, recordToken: '' }, destination: bound },
          }),
          plan: unknownPlan,
        },
        {
          label: 'torn bind source legacy date (missing createdAt)',
          row: bindRow({
            committedBind: {
              source: {
                kind: 'legacy',
                key: '|ev-1',
                owner: '',
                eventId: 'ev-1',
                fingerprint: 'fp-1',
                recordToken: null,
              },
              destination: bound,
            },
          }),
          plan: unknownPlan,
        },
        {
          label: 'bind source is a BOUND record (not a legal bind source)',
          row: bindRow({ committedBind: { source: bound, destination: bound } }),
          plan: unknownPlan,
        },
        {
          label: 'bind destination owner torn from the stored actual',
          row: bindRow({
            committedBind: {
              source: unbound,
              destination: modernActual({ key: 'owner-b|ev-1', owner: 'owner-b' }),
            },
          }),
          plan: unknownPlan,
        },
        {
          label: 'bind destination key torn (not the owner-scoped handle)',
          row: bindRow({
            committedBind: {
              source: unbound,
              destination: { ...bound, key: 'mismatched-key' },
            },
          }),
          plan: unknownPlan,
        },
        {
          label: 'bind evidence without its instance',
          row: { ...bindRow(), actual: undefined, adoption: undefined },
          plan: unknownPlan,
        },
        {
          label: 'KNOWN-origin plan carrying a (well-formed) bind mapping',
          row: {
            ...bindRow({ planIdentity: planIdentity() }),
            committedBind: intactBind,
          },
          plan: planIdentity(),
        },
      ];
      for (const variant of variants) {
        await directRow('progress', (store) => store.put(variant.row));
        void variant.label;
        expect(await readCaptureProgress(variant.plan)).toEqual({ status: 'unreadable' });
        await directRow('progress', (store) => store.clear());
      }
    });

    it('a write over a corrupt row is refused unreadable and overwrites nothing', async () => {
      const corrupt = { ...validRow(), progressVersion: 99 };
      await directRow('progress', (store) => store.put(corrupt));
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'confirm',
          actual: modernActual(),
          basis: 'upload',
        }),
      ).toEqual({ kind: 'unreadable' });
      expect(await directRow('progress', (store) => store.get(scope))).toEqual(corrupt);
    });

    it('database open failures reject reads and fail writes closed', async () => {
      vi.stubGlobal('indexedDB', {
        open: () => {
          let onError: (() => void) | undefined;
          const request = {
            set onerror(cb: () => void) {
              onError = cb;
            },
          };
          setTimeout(() => onError?.(), 0); // fires AFTER the caller wired onerror
          return request;
        },
      } as unknown as IDBFactory);
      await expect(readCaptureProgress(planIdentity())).rejects.toThrow();
      expect(
        await writeCaptureProgress(planIdentity(), {
          kind: 'confirm',
          actual: modernActual(),
          basis: 'upload',
        }),
      ).toEqual({ kind: 'write-failed' });
      await expect(readAttemptOwnerAuthority(headerIdentity())).rejects.toThrow();
      expect(
        await recordAttemptOwnerAuthority(
          headerIdentity(),
          proofFor(
            headerIdentity(),
            'explicit-claim',
            modernActual({ key: '|ev-1', owner: '' }),
            modernActual(),
          ),
        ),
      ).toEqual({ kind: 'write-failed' });
    });

    it('a late transaction abort reports write-failed and the previous state survives', async () => {
      const base = new IDBFactory();
      vi.stubGlobal('indexedDB', base);
      const actual = modernActual();
      await writeCaptureProgress(planIdentity(), {
        kind: 'note-actual',
        actual,
        basis: 'enqueue-persisted',
      });
      vi.stubGlobal('indexedDB', wrapWithAbortingPuts(base, 'progress'));
      expect(
        await writeCaptureProgress(planIdentity(), { kind: 'confirm', actual, basis: 'upload' }),
      ).toEqual({ kind: 'write-failed' });
      vi.stubGlobal('indexedDB', base);
      expect(await readCaptureProgress(planIdentity())).toEqual({
        status: 'pending',
        actual,
        adoption: 'enqueue-persisted',
      });
    });

    it('a READ whose get succeeds but whose transaction aborts REJECTS (never absent)', async () => {
      const base = new IDBFactory();
      vi.stubGlobal('indexedDB', base);
      await writeCaptureProgress(planIdentity(), {
        kind: 'confirm',
        actual: modernActual(),
        basis: 'upload',
      });
      vi.stubGlobal('indexedDB', wrapWithAbortingGets(base, 'progress'));
      await expect(readCaptureProgress(planIdentity())).rejects.toThrow();
      vi.stubGlobal('indexedDB', wrapWithAbortingGets(base, 'attempt-authority'));
      await expect(readAttemptOwnerAuthority(headerIdentity())).rejects.toThrow();
    });

    it('a blocked open whose success arrives late CLOSES that connection (no leak)', async () => {
      const close = vi.fn();
      let onblocked: (() => void) | undefined;
      let onsuccess: (() => void) | undefined;
      vi.stubGlobal('indexedDB', {
        open: () => ({
          set onblocked(cb: () => void) {
            onblocked = cb;
          },
          set onsuccess(cb: () => void) {
            onsuccess = cb;
          },
          set onerror(cb: () => void) {
            void cb;
          },
          set onupgradeneeded(cb: () => void) {
            void cb;
          },
          get result() {
            return { close };
          },
        }),
      } as unknown as IDBFactory);
      const readPromise = readCaptureProgress(planIdentity());
      await new Promise((resolve) => setTimeout(resolve, 0));
      onblocked?.();
      onsuccess?.(); // the late connection must be closed, never used or leaked
      await expect(readPromise).rejects.toThrow(/blocked/);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('a synchronously throwing put fails the write safely and preserves the old state', async () => {
      const base = new IDBFactory();
      vi.stubGlobal('indexedDB', base);
      const actual = modernActual();
      await writeCaptureProgress(planIdentity(), {
        kind: 'note-actual',
        actual,
        basis: 'enqueue-persisted',
      });
      vi.stubGlobal('indexedDB', wrapWithThrowingPuts(base, 'progress'));
      expect(
        await writeCaptureProgress(planIdentity(), { kind: 'confirm', actual, basis: 'upload' }),
      ).toEqual({ kind: 'write-failed' }); // no uncaught exception, no torn state
      vi.stubGlobal('indexedDB', base);
      expect(await readCaptureProgress(planIdentity())).toEqual({
        status: 'pending',
        actual,
        adoption: 'enqueue-persisted',
      });
    });
  });

  describe('5. no navigator.locks in the environment changes anything', () => {
    const exercise = async () => {
      const plan = planIdentity();
      const actual = modernActual();
      expect(
        await writeCaptureProgress(plan, {
          kind: 'note-actual',
          actual,
          basis: 'enqueue-persisted',
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
      expect(
        await writeCaptureProgress(plan, { kind: 'confirm', actual, basis: 'upload' }),
      ).toEqual({ kind: 'written', state: 'confirmed' });
      const raced = await Promise.all([
        writeCaptureProgress(plan, { kind: 'note-actual', actual, basis: 'enqueue-reused' }),
        readCaptureProgress(plan),
      ]);
      expect(raced[0]).toEqual({ kind: 'written', state: 'confirmed' });
      return readCaptureProgress(plan);
    };

    it('works with navigator lacking locks entirely', async () => {
      vi.stubGlobal('navigator', {});
      expect((await exercise()).status).toBe('confirmed');
    });

    it('works with navigator undefined', async () => {
      vi.stubGlobal('navigator', undefined);
      expect((await exercise()).status).toBe('confirmed');
    });

    it('works with a present LockManager (no dependence, no deadlock)', async () => {
      vi.stubGlobal('navigator', {
        locks: { request: async (_name: string, cb: () => Promise<void>) => cb() },
      });
      expect((await exercise()).status).toBe('confirmed');
    });
  });

  describe('6. actual transitions only along a legal committed mapping (review #2)', () => {
    const unknownPlan = planIdentity({ originOwner: '' });
    const unboundSource = (token = 'plan-token-1') =>
      modernActual({ key: '|ev-1', owner: '', recordToken: token });

    it('FLAGSHIP: unknown unbound source → bound A stays PENDING, then A strictly confirms', async () => {
      // The enqueue persisted the plan's own unbound record…
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'note-actual',
          actual: unboundSource(),
          basis: 'enqueue-persisted',
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
      // …a committed bind moved it to owner A (same token) — PENDING only,
      // with the COMPLETE source→destination mapping persisted as the
      // adoption evidence (r2 #2):
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: unboundSource(),
          destination: modernActual(), // owner-a, plan token preserved by the move
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
      let verdict = await readCaptureProgress(unknownPlan);
      expect(verdict).toEqual({
        status: 'pending',
        actual: modernActual(),
        adoption: 'committed-bind',
        committedBind: { source: unboundSource(), destination: modernActual() },
      });
      // …the destination's OWN strict upload/receipt confirmation completes
      // it — the full adoption evidence is RETAINED, not overwritten:
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'confirm',
          actual: modernActual(),
          basis: 'upload',
        }),
      ).toEqual({ kind: 'written', state: 'confirmed' });
      verdict = await readCaptureProgress(unknownPlan);
      expect(verdict).toEqual({
        status: 'confirmed',
        actual: modernActual(),
        adoption: 'upload',
        committedBind: { source: unboundSource(), destination: modernActual() },
      });
    });

    it('r2 #2 positive: LEGACY destination dedupe adoption → confirm → full proof survives re-read', async () => {
      // The flush's same-content dedupe binds the unbound source onto an
      // EXISTING legacy record (token-less, date-identified destination).
      const legacyDestination = legacyActual({ recordCreatedAt: 1_700_000_123_456 });
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: unboundSource(),
          destination: legacyDestination,
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
      // The legacy instance's own strict receipt confirmation:
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'confirm',
          actual: legacyDestination,
          basis: 'receipt',
        }),
      ).toEqual({ kind: 'written', state: 'confirmed' });
      // A later read (fresh open — "module reload") still carries the FULL
      // source→destination adoption evidence alongside the confirmation:
      expect(await readCaptureProgress(unknownPlan)).toEqual({
        status: 'confirmed',
        actual: legacyDestination,
        adoption: 'receipt',
        committedBind: { source: unboundSource(), destination: legacyDestination },
      });
    });

    it('KNOWN-A → B is REJECTED at the ENTRY and A keeps its confirmation (appendix rewrite)', async () => {
      const plan = planIdentity(); // originOwner 'owner-a'
      const actualA = modernActual();
      await writeCaptureProgress(plan, { kind: 'confirm', actual: actualA, basis: 'upload' });
      // P3 entry unification (accepted limitation): a known-origin plan
      // NEVER migrates — its records are created bound, so ANY mapping for
      // one is impossible history, refused before any merge or write (a
      // write can never succeed here and then read back 'unreadable').
      await expect(
        writeCaptureProgress(plan, {
          kind: 'migrate-actual',
          source: actualA,
          destination: modernActual({ key: 'owner-b|ev-1', owner: 'owner-b' }),
        }),
      ).rejects.toThrow(/never migrates/);
      await expect(
        writeCaptureProgress(plan, {
          kind: 'migrate-actual',
          source: unboundSource(),
          destination: modernActual({ key: 'owner-b|ev-1', owner: 'owner-b' }),
        }),
      ).rejects.toThrow(/never migrates/);
      await expect(
        writeCaptureProgress(plan, {
          kind: 'migrate-actual',
          source: unboundSource(),
          destination: modernActual(), // even a same-owner forged mapping
        }),
      ).rejects.toThrow(/never migrates/);
      expect(await readCaptureProgress(plan)).toEqual({
        status: 'confirmed',
        actual: actualA,
        adoption: 'upload',
      }); // A intact, nothing lent to B
    });

    it('r2 #2: a planted confirmed-unbound row is IMPOSSIBLE history — unreadable, never overwritten', async () => {
      // Nothing uploads while unbound: a confirmed unbound record cannot
      // have been produced by this API and must not read as confirmed.
      await directRow('progress', (store) =>
        store.put({
          progressVersion: 1,
          scope: 'learner-1|att-1|ev-1',
          planIdentity: unknownPlan,
          state: 'confirmed',
          actual: unboundSource(),
          adoption: 'upload',
          updatedAt: 1,
        }),
      );
      expect(await readCaptureProgress(unknownPlan)).toEqual({ status: 'unreadable' });
      // A legal-looking mapping against it is refused — no overwrite:
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: unboundSource(),
          destination: modernActual(),
        }),
      ).toEqual({ kind: 'unreadable' });
      expect(await readCaptureProgress(unknownPlan)).toEqual({ status: 'unreadable' });
    });

    it('wrong source token / date / fingerprint refuse the mapping and downgrade nothing', async () => {
      await writeCaptureProgress(unknownPlan, {
        kind: 'note-actual',
        actual: unboundSource(),
        basis: 'enqueue-persisted',
      });
      // Wrong source token:
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: unboundSource('rec-token-WRONG'),
          destination: modernActual({ recordToken: 'rec-token-WRONG' }),
        }),
      ).toEqual({ kind: 'conflict-actual' });
      // Wrong source kind/date (legacy twin of the modern record):
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: legacyActual({ key: '|ev-1', owner: '', recordCreatedAt: 5 }),
          destination: legacyActual({ recordCreatedAt: 6 }),
        }),
      ).toEqual({ kind: 'conflict-actual' });
      // Mapping internally consistent but for a DIFFERENT payload: each
      // side's own fingerprint no longer ties to the plan — a boundary
      // TypeError (the refusal fires before any merge):
      await expect(
        writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: { ...unboundSource(), fingerprint: 'fp-OTHER' },
          destination: { ...modernActual(), fingerprint: 'fp-OTHER' },
        }),
      ).rejects.toThrow(/mapping source/);
      expect(await readCaptureProgress(unknownPlan)).toEqual({
        status: 'pending',
        actual: unboundSource(),
        adoption: 'enqueue-persisted',
      });
    });

    it('absent-scope mappings adopt ONLY the plan own instance (complete ownership proof)', async () => {
      // Legacy source cannot prove ownership of an absent scope:
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: legacyActual({ key: '|ev-1', owner: '', recordCreatedAt: 9 }),
          destination: legacyActual({ recordCreatedAt: 10 }),
        }),
      ).toEqual({ kind: 'conflict-actual' });
      // Wrong-token modern source equally cannot:
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: unboundSource('rec-token-FOREIGN'),
          destination: modernActual({ recordToken: 'rec-token-FOREIGN' }),
        }),
      ).toEqual({ kind: 'conflict-actual' });
      expect(await readCaptureProgress(unknownPlan)).toEqual({ status: 'absent' });
      // The plan's OWN unbound instance CAN (pending, full evidence kept):
      expect(
        await writeCaptureProgress(unknownPlan, {
          kind: 'migrate-actual',
          source: unboundSource(),
          destination: modernActual(),
        }),
      ).toEqual({ kind: 'written', state: 'pending' });
      expect(await readCaptureProgress(unknownPlan)).toEqual({
        status: 'pending',
        actual: modernActual(),
        adoption: 'committed-bind',
        committedBind: { source: unboundSource(), destination: modernActual() },
      });
    });

    it('torn mapping sides (other event/fingerprint/owner) are boundary TypeErrors', async () => {
      // Unknown-origin plan: torn sides hit their own tie boundaries; a
      // known-origin plan refuses ANY mapping at the entry (covered above).
      const plan = planIdentity({ originOwner: '' });
      await expect(
        writeCaptureProgress(plan, {
          kind: 'migrate-actual',
          source: modernActual({ key: '|ev-OTHER', eventId: 'ev-OTHER', owner: '' }),
          destination: modernActual(),
        }),
      ).rejects.toThrow(/mapping source/);
      await expect(
        writeCaptureProgress(plan, {
          kind: 'migrate-actual',
          source: modernActual({ key: '|ev-1', owner: '', fingerprint: 'fp-OTHER' }),
          destination: modernActual(),
        }),
      ).rejects.toThrow(/mapping source/);
      await expect(
        writeCaptureProgress(plan, {
          kind: 'migrate-actual',
          source: modernActual({ key: '|ev-1', owner: '' }),
          destination: modernActual({ eventId: 'ev-OTHER', key: 'owner-a|ev-OTHER' }),
        }),
      ).rejects.toThrow(/mapping destination/);
      // Mismatched source/destination payload pair: the source side's own
      // fingerprint fails the plan tie first (each side must independently
      // tie; the same-payload equality is enforced defensively after):
      await expect(
        writeCaptureProgress(plan, {
          kind: 'migrate-actual',
          source: modernActual({ key: '|ev-1', owner: '', fingerprint: 'fp-X' }),
          destination: modernActual({ fingerprint: 'fp-Y' }),
        }),
      ).rejects.toThrow(/mapping source/);
    });
  });

  describe('7. attempt-owner authority boundary (review #3)', () => {
    const unboundSource = (token = 'plan-token-1') =>
      modernActual({ key: '|ev-1', owner: '', recordToken: token });
    const boundTo = (owner: string) =>
      modernActual({ key: `${owner}|ev-1`, owner, recordToken: 'plan-token-1' });

    it('unknown origin + proven bind A → re-reads A under the ORIGINAL header', async () => {
      const header = headerIdentity(); // originOwner '' stays ''
      expect(await readAttemptOwnerAuthority(header)).toEqual({ status: 'absent' });
      expect(
        await recordAttemptOwnerAuthority(
          header,
          proofFor(header, 'active-operation-bind', unboundSource(), boundTo('owner-a')),
        ),
      ).toEqual({ kind: 'written' });
      const verdict = await readAttemptOwnerAuthority(header);
      expect(verdict.status).toBe('proven');
      if (verdict.status !== 'proven') throw new Error('unreachable');
      expect(verdict.effectiveOwner).toBe('owner-a');
      expect(verdict.header).toEqual(header); // header unchanged, no rollover
      expect(verdict.proof.sourcePlan).toEqual(planIdentity({ originOwner: '' }));
    });

    it('a later owner-B write is refused and never rewrites A (cache B changes nothing)', async () => {
      const header = headerIdentity();
      await recordAttemptOwnerAuthority(
        header,
        proofFor(header, 'active-operation-bind', unboundSource(), boundTo('owner-a')),
      );
      expect(
        await recordAttemptOwnerAuthority(
          header,
          proofFor(header, 'explicit-claim', unboundSource(), boundTo('owner-b')),
        ),
      ).toEqual({ kind: 'conflict-owner' });
      expect(
        await recordAttemptOwnerAuthority(
          header,
          proofFor(header, 'explicit-claim', unboundSource(), boundTo('owner-a')),
        ),
      ).toEqual({ kind: 'written' }); // A→A idempotent
      const reread = await readAttemptOwnerAuthority(header);
      expect(reread.status).toBe('proven');
      if (reread.status !== 'proven') throw new Error('unreachable');
      expect(reread.effectiveOwner).toBe('owner-a');
    });

    it('a KNOWN-A header never records B — not even with no prior row', async () => {
      const knownHeader = headerIdentity({ originOwner: 'owner-a' });
      await expect(
        recordAttemptOwnerAuthority(
          knownHeader,
          proofFor(
            knownHeader,
            'active-operation-bind',
            unboundSource(),
            boundTo('owner-b'), // B contradicts the known origin
          ),
        ),
      ).rejects.toThrow(/only its own origin owner/);
      expect(await readAttemptOwnerAuthority(knownHeader)).toEqual({ status: 'absent' }); // nothing written
      // The same proof binding A is legal:
      expect(
        await recordAttemptOwnerAuthority(
          knownHeader,
          proofFor(knownHeader, 'active-operation-bind', unboundSource(), boundTo('owner-a')),
        ),
      ).toEqual({ kind: 'written' });
      const verdict = await readAttemptOwnerAuthority(knownHeader);
      expect(verdict.status).toBe('proven');
      if (verdict.status !== 'proven') throw new Error('unreachable');
      expect(verdict.effectiveOwner).toBe('owner-a');
    });

    it('proofs from ANOTHER attempt/event/content, or fake evidence, are boundary TypeErrors', async () => {
      const header = headerIdentity();
      // sourcePlan of another attempt:
      const foreignPlan = planIdentity({ attemptId: 'att-OTHER', originEpisodeId: 'att-OTHER' });
      await expect(
        recordAttemptOwnerAuthority(header, {
          kind: 'active-operation-bind',
          sourcePlan: foreignPlan,
          source: unboundSource(),
          destination: boundTo('owner-a'),
        }),
      ).rejects.toThrow(/does not belong/);
      // source actual of another event/fingerprint:
      await expect(
        recordAttemptOwnerAuthority(
          header,
          proofFor(
            header,
            'active-operation-bind',
            modernActual({ key: '|ev-OTHER', eventId: 'ev-OTHER', owner: '' }),
            boundTo('owner-a'),
          ),
        ),
      ).rejects.toThrow(/authority source/);
      await expect(
        recordAttemptOwnerAuthority(
          header,
          proofFor(
            header,
            'active-operation-bind',
            modernActual({ key: '|ev-1', owner: '', fingerprint: 'fp-OTHER' }),
            boundTo('owner-a'),
          ),
        ),
      ).rejects.toThrow(/authority source/);
      // a bound (owner-ful) record as the bind SOURCE:
      await expect(
        recordAttemptOwnerAuthority(
          header,
          proofFor(header, 'explicit-claim', boundTo('owner-a'), boundTo('owner-b')),
        ),
      ).rejects.toThrow(/unbound/);
      // active-operation-bind without the plan's OWN token:
      await expect(
        recordAttemptOwnerAuthority(
          header,
          proofFor(
            header,
            'active-operation-bind',
            unboundSource('foreign-token'),
            boundTo('owner-a'),
          ),
        ),
      ).rejects.toThrow(/own token/);
      // an ownerless destination:
      await expect(
        recordAttemptOwnerAuthority(
          header,
          proofFor(
            header,
            'explicit-claim',
            unboundSource(),
            modernActual({ key: '|ev-1', owner: '' }),
          ),
        ),
      ).rejects.toThrow(/real owner/);
      expect(await readAttemptOwnerAuthority(header)).toEqual({ status: 'absent' });
    });

    it('r2 #3: a FAKE proof kind is rejected by the WRITER itself — scope stays absent', async () => {
      const header = headerIdentity();
      // Direct API call with a drifted kind (not a hand-seeded row): the
      // boundary whitelist refuses it BEFORE any write…
      await expect(
        recordAttemptOwnerAuthority(header, {
          kind: 'assumed',
          sourcePlan: planIdentity({ originOwner: '' }),
          source: unboundSource(),
          destination: boundTo('owner-a'),
        } as unknown as AuthorityBindProof),
      ).rejects.toThrow(/kind/);
      // …the scope was never occupied by the corrupt row:
      expect(await readAttemptOwnerAuthority(header)).toEqual({ status: 'absent' });
      // The LEGAL shape still writes normally afterwards:
      expect(
        await recordAttemptOwnerAuthority(
          header,
          proofFor(header, 'active-operation-bind', unboundSource(), boundTo('owner-a')),
        ),
      ).toEqual({ kind: 'written' });
      const verdict = await readAttemptOwnerAuthority(header);
      expect(verdict.status).toBe('proven');
      if (verdict.status !== 'proven') throw new Error('unreachable');
      expect(verdict.proof.kind).toBe('active-operation-bind');
    });

    it('an explicit claim may adopt a LEGACY unbound instance (real unknown history)', async () => {
      const header = headerIdentity();
      expect(
        await recordAttemptOwnerAuthority(
          header,
          proofFor(
            header,
            'explicit-claim',
            legacyActual({ key: '|ev-1', owner: '', recordCreatedAt: 42 }),
            boundTo('owner-a'),
          ),
        ),
      ).toEqual({ kind: 'written' });
      const verdict = await readAttemptOwnerAuthority(header);
      expect(verdict.status).toBe('proven');
      if (verdict.status !== 'proven') throw new Error('unreachable');
      expect(verdict.effectiveOwner).toBe('owner-a');
    });

    it('a different header at the same scope conflicts; torn stored rows read unreadable', async () => {
      const header = headerIdentity();
      await recordAttemptOwnerAuthority(
        header,
        proofFor(header, 'explicit-claim', unboundSource(), boundTo('owner-a')),
      );
      const otherHeader = headerIdentity({ sceneId: 'sc-OTHER' });
      expect(
        await recordAttemptOwnerAuthority(
          otherHeader,
          proofFor(otherHeader, 'explicit-claim', unboundSource(), boundTo('owner-b')),
        ),
      ).toEqual({ kind: 'conflict-header' });

      const authorityScope = 'learner-1|att-1';
      const storedProof = proofFor(header, 'explicit-claim', unboundSource(), boundTo('owner-a'));
      // effectiveOwner torn from the proof's destination:
      await directRow('attempt-authority', (store) =>
        store.put({
          authorityVersion: 1,
          scope: authorityScope,
          header,
          effectiveOwner: 'owner-b',
          proof: storedProof,
          recordedAt: 1,
        }),
      );
      expect(await readAttemptOwnerAuthority(header)).toEqual({ status: 'unreadable' });
      // proof missing its sourcePlan (old shape):
      await directRow('attempt-authority', (store) =>
        store.put({
          authorityVersion: 1,
          scope: authorityScope,
          header,
          effectiveOwner: 'owner-a',
          proof: {
            kind: 'explicit-claim',
            source: unboundSource(),
            destination: boundTo('owner-a'),
          },
          recordedAt: 1,
        }),
      );
      expect(await readAttemptOwnerAuthority(header)).toEqual({ status: 'unreadable' });
      // fake proof kind:
      await directRow('attempt-authority', (store) =>
        store.put({
          authorityVersion: 1,
          scope: authorityScope,
          header,
          effectiveOwner: 'owner-a',
          proof: {
            kind: 'assumed',
            sourcePlan: planIdentity({ originOwner: '' }),
            source: unboundSource(),
            destination: boundTo('owner-a'),
          },
          recordedAt: 1,
        }),
      );
      expect(await readAttemptOwnerAuthority(header)).toEqual({ status: 'unreadable' });
      // header torn from the proof's own sourcePlan:
      await directRow('attempt-authority', (store) =>
        store.put({
          authorityVersion: 1,
          scope: authorityScope,
          header: headerIdentity({ sceneId: 'sc-TORN' }),
          effectiveOwner: 'owner-a',
          proof: storedProof,
          recordedAt: 1,
        }),
      );
      expect(await readAttemptOwnerAuthority(headerIdentity({ sceneId: 'sc-TORN' }))).toEqual({
        status: 'unreadable',
      });
    });

    it('an authority write hit by a late abort fails honestly and preserves the record', async () => {
      const base = new IDBFactory();
      vi.stubGlobal('indexedDB', base);
      const header = headerIdentity();
      await recordAttemptOwnerAuthority(
        header,
        proofFor(header, 'explicit-claim', unboundSource(), boundTo('owner-a')),
      );
      vi.stubGlobal('indexedDB', wrapWithAbortingPuts(base, 'attempt-authority'));
      const otherHeader = headerIdentity({ attemptId: 'att-2' });
      expect(
        await recordAttemptOwnerAuthority(
          otherHeader,
          proofFor(otherHeader, 'explicit-claim', unboundSource(), boundTo('owner-b')),
        ),
      ).toEqual({ kind: 'write-failed' });
      vi.stubGlobal('indexedDB', base);
      expect((await readAttemptOwnerAuthority(header)).status).toBe('proven');
      expect(await readAttemptOwnerAuthority(otherHeader)).toEqual({ status: 'absent' });
    });
  });

  describe('8. API-boundary validation (required identities cannot be omitted)', () => {
    it('empty required plan fields throw TypeError at the boundary', async () => {
      await expect(readCaptureProgress(planIdentity({ planRecordToken: '' }))).rejects.toThrow(
        TypeError,
      );
      await expect(
        readCaptureProgress(planIdentity({ frozenPayloadFingerprint: '' })),
      ).rejects.toThrow(TypeError);
      await expect(readAttemptOwnerAuthority(headerIdentity({ attemptId: '' }))).rejects.toThrow(
        TypeError,
      );
    });

    it('malformed actuals and fabricated updates throw TypeError', async () => {
      const plan = planIdentity();
      await expect(
        writeCaptureProgress(plan, {
          kind: 'note-actual',
          actual: modernActual({ recordToken: '' }),
          basis: 'enqueue-persisted',
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        writeCaptureProgress(plan, {
          kind: 'confirm',
          actual: modernActual({ key: 'not-owner-scoped' }),
          basis: 'upload',
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('9. superseded WIP localStorage rows prove nothing', () => {
    it('an old completed-shaped localStorage record never confirms the new store', async () => {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) =>
          key === 'maic:capture-plan-progress:learner-1|att-1|ev-1'
            ? JSON.stringify({
                handle: 'owner-a|ev-1',
                recordToken: 'plan-token-1',
                fingerprint: 'fp-1',
                owner: 'owner-a',
                completed: true,
                updatedAt: 1,
              })
            : null,
        setItem: () => {},
        removeItem: () => {},
      });
      expect(await readCaptureProgress(planIdentity())).toEqual({ status: 'absent' }); // not confirmed
    });
  });

  describe('10. consumer-side identity builder (review #4: no invented fingerprints)', () => {
    const completeSide = {
      key: 'owner-a|ev-1',
      eventId: 'ev-1',
      fingerprint: 'fp-1',
      recordToken: 'rec-token-1',
    };

    it('builds modern/legacy actuals from COMPLETE self-describing sides', () => {
      expect(actualIdentityFromQueueSide(completeSide, 'ev-1', 'fp-1')).toEqual(
        modernActual({ recordToken: 'rec-token-1' }),
      );
      expect(
        actualIdentityFromQueueSide(
          {
            key: 'owner-a|ev-1',
            eventId: 'ev-1',
            fingerprint: 'fp-1',
            recordToken: null,
            createdAt: 7,
          },
          'ev-1',
          'fp-1',
        ),
      ).toEqual(legacyActual({ recordCreatedAt: 7 }));
    });

    it('a side for OTHER content can never be washed into this plan identity', () => {
      // The side's OWN fingerprint disagrees with the expected content:
      expect(
        actualIdentityFromQueueSide({ ...completeSide, fingerprint: 'fp-OTHER' }, 'ev-1', 'fp-1'),
      ).toBeNull();
      // The side's own event id disagrees:
      expect(
        actualIdentityFromQueueSide({ ...completeSide, eventId: 'ev-OTHER' }, 'ev-1', 'fp-1'),
      ).toBeNull();
    });

    it('incomplete sides return null — never a fabricated identity', () => {
      expect(actualIdentityFromQueueSide({ key: 'owner-a|ev-1' }, 'ev-1', 'fp-1')).toBeNull(); // no metadata
      expect(
        actualIdentityFromQueueSide(
          { key: 'owner-a|ev-1', eventId: 'ev-1', fingerprint: 'fp-1' }, // no token AND no date
          'ev-1',
          'fp-1',
        ),
      ).toBeNull();
      expect(
        actualIdentityFromQueueSide(
          { key: 'owner-a|ev-2', eventId: 'ev-2', fingerprint: 'fp-1', recordToken: 't' },
          'ev-1',
          'fp-1',
        ),
      ).toBeNull(); // a key that is not this event's handle
    });
  });
});
