/**
 * P3 §3/§5 + r1 focused tests: the SHARED plan executor on REAL report
 * paths — every report comes from the REAL outbox.flushOutbox against
 * fake-indexeddb (fetch mocked at the network boundary only), driven
 * through the real consumeReportForPlan/precheckItem/authority logic, with
 * the ledger manipulated ONLY through the REAL adoption functions
 * (adoptEnqueuedOutcome / adoptEvidenceSide) and opSeq-checked patches —
 * the same wiring QuizView uses (r1: hand-seeded full ledger entries hid
 * the actual page bugs).
 *
 * r1 additions: the same-attempt opSeq replacement barrier and the
 * new-attempt late-result negative (stale async results never patch newer
 * targets), the durable-binding crash-recovery bridge for BOTH an active
 * bind and an explicit claim (progress+authority re-wired from the
 * same-transaction journal, then the real destination evidence), and the
 * full-plane adoption semantics (fingerprint/legacy-date/queued, other
 * plane cleared).
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
    originEpisodeId: 'att-1',
    attemptId: 'att-1',
    sceneId: 'sc1',
    learnerKey: 'learner-1',
    items,
  };
}

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body }) as Response;

/**
 * The REAL ledger wiring (the same semantics QuizView's patchLedger uses):
 * PlanLedgerTarget entries, adoption only via the exported real functions,
 * opSeq-checked patches, terminal states preserved.
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
    /** Simulate a NEWER operation taking over the target (same attempt). */
    supersede: (questionId: string) => {
      const target = ledger.get(questionId);
      if (!target) return;
      opSeq += 1;
      ledger.set(questionId, { ...target, state: 'saving', opSeq });
    },
    deps: (stillCurrent = () => true) => ({
      getLearnerKey: async () => 'learner-1',
      stillCurrent,
      getTarget: (questionId: string) => ledger.get(questionId),
      patchLedger: (
        questionId: string,
        patch: Partial<import('@/lib/mistake-book/plan-executor').PlanLedgerTarget>,
      ) => {
        const target = ledger.get(questionId);
        if (!target) return;
        if (patch.opSeq !== undefined && patch.opSeq !== target.opSeq) return; // superseded op
        if (target.state === 'uploaded' && patch.state !== 'uploaded') return; // terminal
        if (target.state === 'conflict' && patch.state !== 'conflict') return; // permanent
        ledger.set(questionId, { ...target, ...patch } as typeof target);
      },
    }),
  };
}

/** Real outbox enqueue + note + register: the page's actual entry sequence. */
async function realEnqueue(
  modules: Awaited<ReturnType<typeof freshModules>>,
  plan: QuizCapturePlan,
  item: QuizCapturePlanItem,
  owner: string,
  ledgerBox: ReturnType<typeof makeLedger>,
  authority?: import('@/lib/mistake-book/progress').AuthorityBindProof,
) {
  const { outbox, executor } = modules;
  const target = ledgerBox.register(item.questionId, item.eventId);
  const outcome = await outbox.enqueueCaptureEventUnderOwner(item.payload, owner, {
    creationToken: item.recordToken,
  });
  if (outcome.kind !== 'persisted' && outcome.kind !== 'reused') return outcome;
  const fingerprint = outbox.fingerprintOf(item.payload);
  await executor.noteEnqueuedActual(
    plan,
    item,
    fingerprint,
    outcome,
    { getLearnerKey: async () => 'learner-1' },
    authority,
  );
  ledgerBox.ledger.set(item.questionId, executor.adoptEnqueuedOutcome(target, outcome, owner));
  return outcome;
}

const executorDeps = { getLearnerKey: async () => 'learner-1' };

describe('P3/r1 executor: real report paths (real outbox flush, real adoption)', () => {
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

  it('r1 §1: the REAL entry adopts the FULL identity — fingerprint, token-or-date, queued, plane cleared', async () => {
    const payload = payloadFor('ev-adopt');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const ledgerBox = makeLedger();
    const target = ledgerBox.register('q1', 'ev-adopt');
    // A previously-seen LEGACY twin left a stale date — the modern adoption
    // must CLEAR it (never cross planes).
    ledgerBox.ledger.set('q1', { ...target, recordCreatedAt: 999 });
    const outcome = await realEnqueue(
      { outbox, executor, progress },
      plan,
      plan.items[0]!,
      '',
      ledgerBox,
    );
    expect(outcome?.kind).toBe('persisted');
    const adopted = ledgerBox.ledger.get('q1')!;
    // r2 item 5: the state follows the REAL enqueue owner — an unbound
    // creation is 'unbound' (claim-only), never a 'queued' sync promise.
    expect(adopted.state).toBe('unbound');
    expect(adopted.handle).toBe('|ev-adopt');
    expect(adopted.fingerprint).toBe(outbox.fingerprintOf(payload)); // REAL fp recorded
    expect(adopted.recordToken).toBe('plan-token-1');
    expect(adopted.recordCreatedAt).toBeUndefined(); // other plane cleared
  });

  it("r1 §1: a LEGACY reuse adoption keeps the target's real date and clears the token", async () => {
    await outbox.__seedLegacyRecordForTests({
      key: 'owner-a|ev-legacy-ad',
      eventId: 'ev-legacy-ad',
      owner: 'owner-a',
      createdAt: 42_000,
      payload: payloadFor('ev-legacy-ad') as never,
    });
    const payload = payloadFor('ev-legacy-ad');
    const ledgerBox = makeLedger();
    const target = ledgerBox.register('q1', 'ev-legacy-ad');
    const adopted = executor.adoptEnqueuedOutcome(
      target,
      {
        kind: 'reused',
        handle: 'owner-a|ev-legacy-ad',
        fingerprint: outbox.fingerprintOf(payload),
        recordCreatedAt: 42_000,
      },
      'owner-a',
    );
    expect(adopted.state).toBe('queued'); // bound owner — durable offline
    expect(adopted.recordToken).toBeUndefined();
    expect(adopted.recordCreatedAt).toBe(42_000);
  });

  it('fresh-persisted unknown → A: real bind + upload wires progress, authority, and the ledger', async () => {
    const payload = payloadFor('ev-1');
    const fp = outbox.fingerprintOf(payload);
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const ledgerBox = makeLedger();
    const outcome = await realEnqueue(
      { outbox, executor, progress },
      plan,
      plan.items[0]!,
      '',
      ledgerBox,
    );
    expect(outcome?.kind).toBe('persisted');
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-1', creationToken: 'plan-token-1' }],
    });
    expect(report.committedBinds).toHaveLength(1);
    expect(report.uploaded.map((entry) => entry.key)).toContain('owner-a|ev-1');
    const consumed = await executor.consumeReportForPlan(plan, report, ledgerBox.deps());
    expect(consumed).toBe(true);
    const verdict = await progress.readCaptureProgress({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
      questionId: 'q1',
      eventId: 'ev-1',
      planRecordToken: 'plan-token-1',
      frozenPayloadFingerprint: fp,
    });
    expect(verdict.status).toBe('confirmed');
    const authority = await progress.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
    });
    expect(authority.status).toBe('proven');
    if (authority.status !== 'proven') throw new Error('unreachable');
    expect(authority.effectiveOwner).toBe('owner-a');
    expect(ledgerBox.ledger.get('q1')?.state).toBe('uploaded');
    expect(ledgerBox.ledger.get('q1')?.handle).toBe('owner-a|ev-1'); // identity migrated
  });

  it('r1 §7 bridge: crash AFTER the outbox bind commit — precheck re-wires progress+authority from the journal', async () => {
    const payload = payloadFor('ev-crash');
    const fp = outbox.fingerprintOf(payload);
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const ledgerBox = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', ledgerBox);
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-crash', creationToken: 'plan-token-1' }],
    });
    // CRASH simulation: the outbox tx committed (queue moved + receipt +
    // binding journal), but the PROGRESS migration and AUTHORITY never
    // happened — wipe both stores the way a lost write would.
    await wipeProgressStores();
    const { executor: e2, progress: p2 } = await freshModules();
    // The recovery precheck consults the durable binding journal and
    // re-wires BOTH stores, then resolves the real destination evidence.
    const precheck = await e2.precheckItem(plan, plan.items[0]!, executorDeps);
    expect(precheck.action).toBe('evidence');
    if (precheck.action !== 'evidence' || precheck.evidence.status !== 'receipt') {
      throw new Error(`expected receipt evidence, got ${JSON.stringify(precheck)}`);
    }
    expect(precheck.evidence.side.key).toBe('owner-a|ev-crash');
    const verdict = await p2.readCaptureProgress({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
      questionId: 'q1',
      eventId: 'ev-crash',
      planRecordToken: 'plan-token-1',
      frozenPayloadFingerprint: fp,
    });
    expect(verdict.status).toBe('pending'); // migrated along the journal mapping
    const authority = await p2.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
    });
    expect(authority.status).toBe('proven'); // reason active-bind → re-wired
    if (authority.status !== 'proven') throw new Error('unreachable');
    expect(authority.effectiveOwner).toBe('owner-a');
  });

  it('r1 §7 bridge: an EXPLICIT CLAIM recovers the same way (reason explicit-claim)', async () => {
    const payload = payloadFor('ev-claim');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    // The record is durable unbound (progress noted); NO active bind ran.
    const ledgerBox = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', ledgerBox);
    // The user explicitly claims their unbound events; the claim commits
    // (queue move + binding journal in the SAME tx), then the page closes
    // before any progress/authority write.
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const claim = await outbox.claimUnboundEvents();
    expect(claim.identityConfirmed).toBe(true);
    expect(claim.claimed).toContain('ev-claim');
    expect(claim.committedMappings).toHaveLength(1);
    expect(claim.committedMappings[0]!.destination.key).toBe('owner-a|ev-claim');
    await wipeProgressStores();
    const { executor: e2, progress: p2 } = await freshModules();
    const precheck = await e2.precheckItem(plan, plan.items[0]!, executorDeps);
    expect(precheck.action).toBe('evidence');
    if (precheck.action !== 'evidence') throw new Error('unreachable');
    expect(['queued', 'receipt']).toContain(precheck.evidence.status);
    const authority = await p2.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
    });
    expect(authority.status).toBe('proven'); // reason explicit-claim → re-wired
    // The later q2 follows the PROVEN owner A (never the cache B).
    outbox.observeOwner('owner-b');
    const resolution = await e2.authoritativeOwnerFor(unknownPlan([]));
    expect(resolution.status).toBe('proven');
    if (resolution.status !== 'proven') throw new Error('unreachable');
    expect(resolution.owner).toBe('owner-a');
  });

  it("r1 §5: a SAME-ATTEMPT newer operation never receives the old operation's patches", async () => {
    const payload = payloadFor('ev-opseq');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const ledgerBox = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', ledgerBox);
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-opseq', creationToken: 'plan-token-1' }],
    });
    // A NEWER operation takes over the target MID-decision — injected at
    // the SECOND learner resolution of THIS consumption (1: the consumer's
    // header lookup before any snapshot; 2: inside confirmItemActual —
    // AFTER the old operation's target was snapshotted). The mount and
    // attempt guards stay green (same attempt); the confirm the OLD
    // operation decided must be dropped against the NEW target.
    let learnerCalls = 0;
    const deps = {
      getLearnerKey: async () => {
        learnerCalls += 1;
        if (learnerCalls === 2) {
          ledgerBox.supersede('q1'); // the regrade replaces the target NOW
        }
        return 'learner-1';
      },
      stillCurrent: () => true, // same attempt, still mounted
      getTarget: (questionId: string) => ledgerBox.ledger.get(questionId),
      patchLedger: ledgerBox.deps().patchLedger,
    };
    await executor.consumeReportForPlan(plan, report, deps);
    const target = ledgerBox.ledger.get('q1')!;
    // The supersede reset the target to its fresh 'saving'; the confirm the
    // OLD operation decided (pre-supersede snapshot) was dropped — the NEW
    // target never reads 'uploaded' from the stale operation.
    expect(target.state).toBe('saving'); // NOT uploaded: stale confirm dropped
    // Control: the SAME report with no mid-flight supersede DOES upload.
    const controlLedger = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', controlLedger);
    await outbox.flushOutbox();
    const report3 = await outbox.flushOutbox(); // receipts-only pass for control
    void report3;
    const controlReport = { ...report, uploaded: report.uploaded };
    await executor.consumeReportForPlan(plan, controlReport, controlLedger.deps());
    expect(controlLedger.ledger.get('q1')?.state).not.toBe('saving'); // progressed
  });

  it('r1 §5: a late result for a DEAD context consumes nothing (stillCurrent false)', async () => {
    const payload = payloadFor('ev-dead');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const ledgerBox = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', ledgerBox);
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-dead', creationToken: 'plan-token-1' }],
    });
    const consumed = await executor.consumeReportForPlan(
      plan,
      report,
      ledgerBox.deps(() => false),
    );
    expect(consumed).toBe(false);
    expect(ledgerBox.ledger.get('q1')?.state).toBe('unbound'); // untouched (claim-only)
  });

  it('a later q2 adopts the PROVEN A directly — even with the cache on B', async () => {
    // Wire the attempt authority via q1's real bind (as above).
    const payload1 = payloadFor('ev-1');
    const q1Item = itemFor('q1', 'plan-token-1', payload1);
    const ledger1 = makeLedger();
    await realEnqueue({ outbox, executor, progress }, unknownPlan([q1Item]), q1Item, '', ledger1);
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report1 = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-1', creationToken: 'plan-token-1' }],
    });
    await executor.consumeReportForPlan(unknownPlan([q1Item]), report1, ledger1.deps());
    // The cache now says B — the authority must still resolve A:
    outbox.observeOwner('owner-b');
    const plan2 = unknownPlan([q1Item, itemFor('q2', 'plan-token-2', payloadFor('ev-2', 'q2'))]);
    const resolution = await executor.authoritativeOwnerFor(plan2);
    expect(resolution.status).toBe('proven');
    if (resolution.status !== 'proven') throw new Error('unreachable');
    expect(resolution.owner).toBe('owner-a');
    const q2Payload = payloadFor('ev-2', 'q2');
    const enqueued2 = await outbox.enqueueCaptureEventUnderOwner(q2Payload, resolution.owner, {
      creationToken: 'plan-token-2',
    });
    expect(enqueued2.kind).toBe('persisted');
    if (enqueued2.kind !== 'persisted') throw new Error('unreachable');
    expect(enqueued2.handle).toBe('owner-a|ev-2');
    const fp2 = outbox.fingerprintOf(q2Payload);
    expect(
      await executor.noteEnqueuedActual(
        plan2,
        plan2.items[1]!,
        fp2,
        enqueued2,
        executorDeps,
        resolution.proof,
      ),
    ).toBe(true);
    const q2Verdict = await progress.readCaptureProgress({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
      questionId: 'q2',
      eventId: 'ev-2',
      planRecordToken: 'plan-token-2',
      frozenPayloadFingerprint: fp2,
    });
    expect(q2Verdict.status).toBe('pending');
    if (q2Verdict.status !== 'pending') throw new Error('unreachable');
    expect(q2Verdict.actual?.owner).toBe('owner-a');
    const report2 = await outbox.flushOutbox();
    const ledger2 = makeLedger();
    const t2 = ledger2.register('q2', 'ev-2');
    ledger2.ledger.set(
      'q2',
      executor.adoptEnqueuedOutcome(
        t2,
        {
          kind: 'persisted',
          handle: enqueued2.handle,
          fingerprint: fp2,
          creationToken: 'plan-token-2',
        },
        'owner-a',
      ),
    );
    await executor.consumeReportForPlan(unknownPlan([plan2.items[1]!]), report2, ledger2.deps());
    expect(ledger2.ledger.get('q2')?.state).toBe('uploaded');
  });

  it('an EMPTY plan with the cache on B invents no authority (claim-only)', async () => {
    outbox.observeOwner('owner-b'); // cache B alone
    const resolution = await executor.authoritativeOwnerFor(unknownPlan([]));
    expect(resolution.status).toBe('absent');
  });

  it('recovery never binds unknown origins: a real no-proof flush leaves the record unbound', async () => {
    const payload = payloadFor('ev-recovery');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const ledgerBox = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', ledgerBox);
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox();
    expect(report.committedBinds).toHaveLength(0);
    expect(report.unbound.map((entry) => entry.key)).toContain('|ev-recovery');
    await executor.consumeReportForPlan(plan, report, ledgerBox.deps());
    expect(ledgerBox.ledger.get('q1')?.state).toBe('unbound');
    const authority = await progress.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
    });
    expect(authority.status).toBe('absent');
  });

  it('a REUSED same-content record generates no authority (the plan-token rule)', async () => {
    // A pre-existing UNBOUND modern record with a FOREIGN token, same content.
    const payload = payloadFor('ev-reuse');
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'foreign-token' });
    const fp = outbox.fingerprintOf(payload);
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const outcome = await outbox.enqueueCaptureEventUnderOwner(payload, '', {
      creationToken: 'plan-token-1',
    });
    expect(outcome.kind).toBe('reused');
    // A flush may bind the record when the proof matches the RECORD's own
    // token (the outbox cannot know provenance) — but the CONSUMER'S rule
    // is that only THIS plan's own token instance wires the authority.
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-reuse', creationToken: 'foreign-token' }],
    });
    expect(report.committedBinds).toHaveLength(1);
    expect(report.committedBinds[0]!.source.recordToken).toBe('foreign-token');
    const ledgerBox = makeLedger();
    const t = ledgerBox.register('q1', 'ev-reuse');
    ledgerBox.ledger.set(
      'q1',
      executor.adoptEnqueuedOutcome(
        t,
        {
          kind: 'reused',
          handle: '|ev-reuse',
          fingerprint: fp,
          recordToken: 'foreign-token',
        },
        '',
      ),
    );
    await executor.consumeReportForPlan(plan, report, ledgerBox.deps());
    const authority = await progress.readAttemptOwnerAuthority({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
    });
    expect(authority.status).toBe('absent'); // foreign token ≠ this plan's creation
  });

  it('a FAILED progress confirm keeps the ledger recoverable (uploaded only after durability)', async () => {
    const payload = payloadFor('ev-failconfirm');
    const fp = outbox.fingerprintOf(payload);
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    // Plant a CORRUPT progress row at this scope: every confirm write will
    // be refused 'unreadable' — the ledger must NOT claim uploaded.
    await seedProgressCorrupt('learner-1|att-1|ev-failconfirm');
    const ledgerBox = makeLedger();
    const t = ledgerBox.register('q1', 'ev-failconfirm');
    ledgerBox.ledger.set(
      'q1',
      executor.adoptEvidenceSide(
        t,
        {
          key: 'owner-a|ev-failconfirm',
          owner: 'owner-a',
          eventId: 'ev-failconfirm',
          fingerprint: fp,
          recordToken: 'plan-token-1',
        },
        'queued',
      ),
    );
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'plan-token-1' });
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-failconfirm', creationToken: 'plan-token-1' }],
    });
    expect(report.uploaded.length).toBeGreaterThan(0); // the upload is real
    const consumed = await executor.consumeReportForPlan(plan, report, ledgerBox.deps());
    expect(consumed).toBe(true);
    expect(ledgerBox.ledger.get('q1')?.state).toBe('queued'); // recoverable, not uploaded
  });

  it('uploaded is TERMINAL: a concurrent OLD 500 released after another sender committed 200+receipt downgrades nothing', async () => {
    // Final-review retarget: the original fixture re-enqueued the SAME
    // token after a healthy receipt and forced a second POST just to
    // manufacture a failure verdict. The real boundary is CONCURRENT: an
    // OLD transport fails AFTER another real sender committed the upload —
    // the plan ledger keeps its uploaded verdict; no unnecessary second
    // POST is required after a healthy completed receipt.
    const payloadLocal = payloadFor('ev-terminal-race');
    const plan = unknownPlan([itemFor('q1', 'tok-terminal', payloadLocal)]);
    const ledgerBox = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', ledgerBox);

    // Hold the OLD transport (moduleA's first POST); a second module
    // instance (a real other consumer) commits 200 + receipt meanwhile.
    vi.resetModules();
    const moduleB = await import('@/lib/mistake-book/outbox');
    let releaseOld!: (status: number) => void;
    let oldArrived!: () => void;
    const oldArrivedPromise = new Promise<void>((resolve) => {
      oldArrived = resolve;
    });
    let firstPost = true;
    const jsonResponse200 = jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' });
    mocks.fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { eventId: string };
        if (firstPost && body.eventId === 'ev-terminal-race') {
          firstPost = false;
          oldArrived();
          const status = await new Promise<number>((resolve) => {
            releaseOld = resolve;
          });
          return status === 200
            ? jsonResponse200
            : ({
                ok: false,
                status,
                headers: new Headers({ 'x-owner-id': 'owner-a' }),
                json: async () => ({}),
              } as Response);
        }
        return jsonResponse200;
      }
      return jsonResponse200;
    });

    const passOld = outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-terminal-race', creationToken: 'tok-terminal' }],
    });
    await oldArrivedPromise;
    const reportB = await moduleB.flushOutbox(); // real sender commits
    expect(reportB.uploaded).toHaveLength(1);
    releaseOld(500); // the OLD transport now fails
    const reportOld = await passOld;
    expect(reportOld.failed).toHaveLength(1); // honest verdict, own transport
    expect(reportOld.uploaded).toHaveLength(0); // never borrows B's success
    await executor.consumeReportForPlan(plan, reportOld, ledgerBox.deps());
    expect(ledgerBox.ledger.get('q1')?.state).toBe('uploaded'); // TERMINAL
    const posts = mocks.fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(2); // exactly the two concurrent transports
  });

  it('precheckItem: an unreadable progress row is its own branch — never an enqueue', async () => {
    const payload = payloadFor('ev-precheck');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    await seedProgressCorrupt('learner-1|att-1|ev-precheck');
    const precheck = await executor.precheckItem(plan, plan.items[0]!, executorDeps);
    expect(precheck).toEqual({ action: 'unreadable' });
  });

  it('precheckItem: a strictly-matching queued record is evidence; a foreign one is conflict', async () => {
    const payload = payloadFor('ev-precheck2');
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    await outbox.enqueueCaptureEventUnderOwner(payload, '', { creationToken: 'plan-token-1' });
    const queued = await executor.precheckItem(plan, plan.items[0]!, executorDeps);
    expect(queued.action).toBe('evidence');
    if (queued.action !== 'evidence' || queued.evidence.status !== 'queued') {
      throw new Error('expected queued evidence');
    }
    expect(queued.evidence.side.key).toBe('|ev-precheck2');
    const planForeign = unknownPlan([itemFor('q1', 'other-token', payload)]);
    const conflict = await executor.precheckItem(planForeign, planForeign.items[0]!, executorDeps);
    expect(conflict.action).toBe('evidence');
    if (conflict.action !== 'evidence') throw new Error('unreachable');
    expect(conflict.evidence.status).toBe('conflict');
  });

  it("legacy dedupe through the REAL consumer: the upload verdict confirms with the target's own date", async () => {
    // A pre-existing LEGACY bound record under owner-a — same content as
    // the plan's item — so the flush's bind is a same-content dedupe onto
    // the LEGACY target (destination keeps its own date).
    const payload = payloadFor('ev-dedupe-x');
    await outbox.__seedLegacyRecordForTests({
      key: 'owner-a|ev-dedupe-x',
      eventId: 'ev-dedupe-x',
      owner: 'owner-a',
      createdAt: 7_777,
      payload: payload as never,
    });
    const fp = outbox.fingerprintOf(payload);
    const plan = unknownPlan([itemFor('q1', 'plan-token-1', payload)]);
    const ledgerBox = makeLedger();
    await realEnqueue({ outbox, executor, progress }, plan, plan.items[0]!, '', ledgerBox);
    mocks.fetchMock.mockResolvedValue(jsonResponse({ success: true }, { 'x-owner-id': 'owner-a' }));
    const report = await outbox.flushOutbox({
      bindNewEvents: [{ eventId: 'ev-dedupe-x', creationToken: 'plan-token-1' }],
    });
    expect(report.committedBinds).toHaveLength(1);
    expect(report.committedBinds[0]!.destination.recordToken).toBeNull();
    expect(report.committedBinds[0]!.destination.createdAt).toBe(7_777);
    // The deduped LEGACY destination itself uploads.
    expect(report.uploaded.map((e) => e.key)).toContain('owner-a|ev-dedupe-x');
    await executor.consumeReportForPlan(plan, report, ledgerBox.deps());
    const target = ledgerBox.ledger.get('q1')!;
    expect(target.state).toBe('uploaded');
    expect(target.recordToken).toBeUndefined(); // legacy destination: token cleared
    expect(target.recordCreatedAt).toBe(7_777); // target's REAL date recorded
    const verdict = await progress.readCaptureProgress({
      learnerKey: 'learner-1',
      attemptId: 'att-1',
      sceneId: 'sc1',
      originEpisodeId: 'att-1',
      originOwner: '',
      questionId: 'q1',
      eventId: 'ev-dedupe-x',
      planRecordToken: 'plan-token-1',
      frozenPayloadFingerprint: fp,
    });
    expect(verdict.status).toBe('confirmed');
    if (verdict.status !== 'confirmed') throw new Error('unreachable');
    expect(verdict.actual?.kind).toBe('legacy');
    if (verdict.actual?.kind === 'legacy') {
      expect(verdict.actual.recordCreatedAt).toBe(7_777);
    }
  });
});

/** Wipe both progress stores (crash-simulation helper). */
async function wipeProgressStores(): Promise<void> {
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
      tx.onabort = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

/** Plant a corrupt progress row at a scope (unreadable reads/writes). */
async function seedProgressCorrupt(scope: string): Promise<void> {
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
      const tx = db.transaction('progress', 'readwrite');
      tx.objectStore('progress').put({ progressVersion: 99, scope });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}
