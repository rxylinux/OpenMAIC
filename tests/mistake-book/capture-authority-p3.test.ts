/**
 * P3 §2 focused tests: the typed attempt-authority adoption for later items
 * of an unknown-origin attempt — a q2 item legally created DIRECTLY under
 * the PROVEN attempt owner A (basis 'attempt-authority' + the committed
 * bind proof), verified against the PERSISTED authority row in the same
 * transaction on write AND on every read. Formal counters: no authority →
 * refused; foreign header/owner → boundary TypeError; a removed or torn
 * persisted authority makes the stored adoption unreadable; the known-
 * origin migrate entry refusal (unified impossible-history rejection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
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
    originOwner: '',
    questionId: 'q1',
    eventId: 'ev-1',
    planRecordToken: 'plan-token-1',
    frozenPayloadFingerprint: 'fp-1',
    ...overrides,
  };
}

const unboundQ1 = (): ModernActualIdentity => ({
  kind: 'modern',
  key: '|ev-1',
  owner: '',
  eventId: 'ev-1',
  fingerprint: 'fp-1',
  recordToken: 'plan-token-1',
});

const boundQ1 = (): ModernActualIdentity => ({
  kind: 'modern',
  key: 'owner-a|ev-1',
  owner: 'owner-a',
  eventId: 'ev-1',
  fingerprint: 'fp-1',
  recordToken: 'plan-token-1',
});

/** q2's own expected instance: created directly under the proven owner A. */
const q2UnderA = (): ModernActualIdentity => ({
  kind: 'modern',
  key: 'owner-a|ev-2',
  owner: 'owner-a',
  eventId: 'ev-2',
  fingerprint: 'fp-2',
  recordToken: 'plan-token-2',
});

const q2Plan = (): PlanIdentity =>
  planIdentity({
    questionId: 'q2',
    eventId: 'ev-2',
    planRecordToken: 'plan-token-2',
    frozenPayloadFingerprint: 'fp-2',
  });

const header = (): AttemptHeaderIdentity => ({
  learnerKey: 'learner-1',
  attemptId: 'att-1',
  sceneId: 'sc-1',
  originEpisodeId: 'att-1',
  originOwner: '',
});

/** The attempt's committed adoption proof (q1's plan → its bound instance). */
const adoptionProof = (): AuthorityBindProof => ({
  kind: 'active-operation-bind',
  sourcePlan: planIdentity(),
  source: unboundQ1(),
  destination: boundQ1(),
});

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

describe('P3 §2: typed attempt-authority adoption', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('q2 of a proven-A attempt notes DIRECTLY under A and confirms; evidence survives', async () => {
    // The attempt's authority was wired by q1's committed bind:
    expect(await recordAttemptOwnerAuthority(header(), adoptionProof())).toEqual({
      kind: 'written',
    });
    // q2 — a LATER item — is created directly under the PROVEN owner A:
    expect(
      await writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderA(),
        basis: 'attempt-authority',
        authority: adoptionProof(),
      }),
    ).toEqual({ kind: 'written', state: 'pending' });
    // Its own strict receipt confirmation completes it:
    expect(
      await writeCaptureProgress(q2Plan(), {
        kind: 'confirm',
        actual: q2UnderA(),
        basis: 'receipt',
      }),
    ).toEqual({ kind: 'written', state: 'confirmed' });
    // The full evidence survives re-reads (adoption + confirmation):
    expect(await readCaptureProgress(q2Plan())).toEqual({
      status: 'confirmed',
      actual: q2UnderA(),
      adoption: 'receipt',
    });
    // The authority itself still proves A under the ORIGINAL header:
    const verdict = await readAttemptOwnerAuthority(header());
    expect(verdict.status).toBe('proven');
    if (verdict.status !== 'proven') throw new Error('unreachable');
    expect(verdict.effectiveOwner).toBe('owner-a');
  });

  it('counters: no authority / foreign proof owner / known-origin plan are all refused', async () => {
    // No persisted authority at all → the adoption cannot be verified:
    expect(
      await writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderA(),
        basis: 'attempt-authority',
        authority: adoptionProof(),
      }),
    ).toEqual({ kind: 'conflict-actual' });
    expect(await readCaptureProgress(q2Plan())).toEqual({ status: 'absent' });

    // A proof whose destination owner is NOT the actual's owner → boundary:
    const proofB: AuthorityBindProof = {
      kind: 'active-operation-bind',
      sourcePlan: planIdentity(),
      source: unboundQ1(),
      destination: { ...boundQ1(), key: 'owner-b|ev-1', owner: 'owner-b' },
    };
    await expect(
      writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderA(),
        basis: 'attempt-authority',
        authority: proofB,
      }),
    ).rejects.toThrow(/equal the proof destination/);

    // A proof from ANOTHER attempt's header → boundary:
    const foreignProof: AuthorityBindProof = {
      kind: 'active-operation-bind',
      sourcePlan: planIdentity({ attemptId: 'att-OTHER', originEpisodeId: 'att-OTHER' }),
      source: unboundQ1(),
      destination: boundQ1(),
    };
    await expect(
      writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderA(),
        basis: 'attempt-authority',
        authority: foreignProof,
      }),
    ).rejects.toThrow(/does not belong/);

    // Missing proof entirely → boundary:
    await expect(
      writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderA(),
        basis: 'attempt-authority',
      } as never),
    ).rejects.toThrow(/bind proof/);

    // KNOWN-origin plans never adopt via authority (created bound):
    await expect(
      writeCaptureProgress(
        planIdentity({
          originOwner: 'owner-a',
          questionId: 'q2',
          eventId: 'ev-2',
          planRecordToken: 'plan-token-2',
          frozenPayloadFingerprint: 'fp-2',
        }),
        {
          kind: 'note-actual',
          actual: q2UnderA(),
          basis: 'attempt-authority',
          authority: adoptionProof(),
        },
      ),
    ).rejects.toThrow(/unknown-origin/);
    // The authority proof on a non-authority basis is refused too:
    await expect(
      writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: { ...q2UnderA(), owner: '', key: '|ev-2' },
        basis: 'enqueue-reused',
        authority: adoptionProof(),
      }),
    ).rejects.toThrow(/only to the attempt-authority basis/);
  });

  it('a torn/removed persisted authority makes the stored adoption UNREADABLE (re-verified on read)', async () => {
    await recordAttemptOwnerAuthority(header(), adoptionProof());
    expect(
      await writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderA(),
        basis: 'attempt-authority',
        authority: adoptionProof(),
      }),
    ).toEqual({ kind: 'written', state: 'pending' });
    expect((await readCaptureProgress(q2Plan())).status).toBe('pending');

    // The authority row VANISHES: the adoption evidence no longer verifies.
    await directRow('attempt-authority', (store) => store.clear());
    expect(await readCaptureProgress(q2Plan())).toEqual({ status: 'unreadable' });

    // Restore it, then corrupt the stored adoption's proof (torn header):
    await recordAttemptOwnerAuthority(header(), adoptionProof());
    await directRow('progress', (store) =>
      store.put({
        progressVersion: 1,
        scope: 'learner-1|att-1|ev-2',
        planIdentity: q2Plan(),
        state: 'pending',
        actual: q2UnderA(),
        adoption: 'attempt-authority',
        authorityAdoption: {
          header: { ...header(), sceneId: 'sc-TORN' },
          proof: adoptionProof(),
        },
        updatedAt: 1,
      }),
    );
    expect(await readCaptureProgress(q2Plan())).toEqual({ status: 'unreadable' });

    // A planted bound-pending row WITHOUT any adoption evidence on an
    // unknown plan stays unreadable (a bare token claim proves nothing).
    await directRow('progress', (store) =>
      store.put({
        progressVersion: 1,
        scope: 'learner-1|att-1|ev-2',
        planIdentity: q2Plan(),
        state: 'pending',
        actual: q2UnderA(),
        adoption: 'attempt-authority',
        updatedAt: 1,
      }),
    );
    expect(await readCaptureProgress(q2Plan())).toEqual({ status: 'unreadable' });
  });

  it('an authority whose row proves owner B refuses an A-adoption (no cache guesses)', async () => {
    const proofB: AuthorityBindProof = {
      kind: 'explicit-claim',
      sourcePlan: planIdentity(),
      source: unboundQ1(),
      destination: { ...boundQ1(), key: 'owner-b|ev-1', owner: 'owner-b' },
    };
    expect(await recordAttemptOwnerAuthority(header(), proofB)).toEqual({ kind: 'written' });
    // Attempting to adopt A while the persisted authority proves B:
    expect(
      await writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderA(),
        basis: 'attempt-authority',
        authority: adoptionProof(), // claims A — the STORED row says B
      }),
    ).toEqual({ kind: 'conflict-actual' });
    expect(await readCaptureProgress(q2Plan())).toEqual({ status: 'absent' });
    // Adopting under the PROVEN B is legal:
    const q2UnderB: ModernActualIdentity = { ...q2UnderA(), key: 'owner-b|ev-2', owner: 'owner-b' };
    expect(
      await writeCaptureProgress(q2Plan(), {
        kind: 'note-actual',
        actual: q2UnderB,
        basis: 'attempt-authority',
        authority: proofB,
      }),
    ).toEqual({ kind: 'written', state: 'pending' });
    void (null as unknown as LegacyActualIdentity);
  });

  it('known-origin migrate is refused AT THE ENTRY (unified impossible history)', async () => {
    const knownPlan = planIdentity({ originOwner: 'owner-a' });
    await expect(
      writeCaptureProgress(knownPlan, {
        kind: 'migrate-actual',
        source: unboundQ1(),
        destination: boundQ1(),
      }),
    ).rejects.toThrow(/never migrates/);
    expect(await readCaptureProgress(knownPlan)).toEqual({ status: 'absent' });
  });
});
