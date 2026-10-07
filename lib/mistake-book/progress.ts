/**
 * Capture-plan confirmation progress (C2-P2 progress design + early review):
 * durable, transactional per-(learner, attempt, event) facts about a plan
 * item's ACTUAL queue identity and completion — plus the attempt-owner
 * authority boundary that P3 consumers submit real bind proofs through.
 *
 * Contract:
 * - The immutable PLAN identity (every field required) is persisted
 *   separately from the ACTUAL queue identity a completion was proven
 *   under. Every actual is SEMANTICALLY tied to its plan: same event, same
 *   frozen-content fingerprint, the origin-owner plane (known owner A never
 *   confirms/migrates under B; unknown '' notes stay unbound and only legal
 *   committed binds move them to a real owner). An absent scope accepts a
 *   first confirm/migration only for the plan's OWN instance (modern, the
 *   plan record token); legacy or different-token instances need a durable
 *   adoption (enqueue-reused note or committed bind) FIRST.
 * - 'confirmed' requires a COMPLETE actual identity AND a confirmation
 *   basis ('upload' | 'receipt') — enqueue bases and basis-less records
 *   never read as confirmed; a fingerprint plus a boolean is never a proof;
 *   the superseded WIP localStorage rows prove nothing at all.
 * - Actual transitions happen ONLY along a committed source→destination
 *   bind mapping whose source is the plan's unbound instance (owner ''):
 *   a legal bind source is by construction unbound and hence never
 *   uploaded, so a CONFIRMED record never migrates — its state is never
 *   copied onto another actual/owner without that target's own strict
 *   upload/receipt confirmation.
 * - Every write reads, decides, and writes inside ONE readwrite
 *   transaction on the scope and reports success ONLY on transaction
 *   completion; a late abort returns a failure result with the previous
 *   state intact; a synchronously throwing put aborts safely. Reads stage
 *   the row and resolve on transaction completion, so a late-aborted read
 *   rejects instead of masquerading as 'absent'. There is no WebLocks
 *   dependency anywhere — IndexedDB's same-store readwrite serialization
 *   IS the atomicity boundary.
 * - Unreadable ≠ absent: corrupt rows, missing required fields, unknown
 *   versions, and semantically torn stored records read as 'unreadable';
 *   database-level failures reject so the caller handles them honestly.
 * - Attempt-owner authority is append-once per attempt and PROOF-TIED: the
 *   proof carries the full source plan identity whose five header fields
 *   must equal the header, its source/destination actuals must tie to that
 *   plan, the source must be the unbound instance (the active operation's
 *   own token, or any unbound instance for an explicit claim), and the
 *   destination owner is the effective owner (a known-origin header binds
 *   ONLY its own owner; an unproven unknown stays absent — claim-only).
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('CaptureProgress');

const DB_NAME = 'MAIC-capture-progress';
const DB_VERSION = 1;
const PROGRESS_STORE = 'progress';
const AUTHORITY_STORE = 'attempt-authority';

// ── Identity contracts ─────────────────────────────────────────────────────

/**
 * The immutable plan identity — every field REQUIRED. `originOwner` is the
 * owner fact frozen at plan build ('' = explicitly unknown); all other
 * fields must be non-empty.
 */
export interface PlanIdentity {
  learnerKey: string;
  attemptId: string;
  sceneId: string;
  originEpisodeId: string;
  /** '' = the origin owner was explicitly unknown at freeze time. */
  originOwner: string;
  questionId: string;
  eventId: string;
  /** The plan item's ONCE-minted creation token (never re-minted). */
  planRecordToken: string;
  /** stableStringify of the frozen per-question payload. */
  frozenPayloadFingerprint: string;
}

/** An actual queue-record instance with its own creation token. */
export interface ModernActualIdentity {
  kind: 'modern';
  /** Row key `${owner}|${eventId}` — the real record handle. */
  key: string;
  owner: string;
  eventId: string;
  fingerprint: string;
  recordToken: string;
}

/** A legacy v1 token-less record — createdAt is the instance identity. */
export interface LegacyActualIdentity {
  kind: 'legacy';
  key: string;
  owner: string;
  eventId: string;
  fingerprint: string;
  recordToken: null;
  recordCreatedAt: number;
}

export type ActualIdentity = ModernActualIdentity | LegacyActualIdentity;

/** How a stored actual identity was adopted (all caller-attested proofs). */
export type ActualAdoptionBasis =
  | 'enqueue-persisted'
  | 'enqueue-reused'
  | 'upload'
  | 'receipt'
  | 'committed-bind'
  | 'attempt-authority';

/**
 * The COMPLETE source→destination adoption evidence of a committed bind
 * (r2 review #2): persisted alongside the migrated record and RETAINED
 * through its later confirmation — the adoption basis string alone is
 * never a substitute for this full proof.
 */
export interface CommittedBindEvidence {
  source: ActualIdentity;
  destination: ActualIdentity;
}

/**
 * The persisted attempt-authority adoption evidence (P3 §2): how a later
 * item of an unknown-origin attempt came to sit directly under the PROVEN
 * attempt owner. Re-verified against the authority store on every read.
 */
export interface AuthorityAdoptionEvidence {
  header: AttemptHeaderIdentity;
  proof: AuthorityBindProof;
}

/** Bases that may legally hold the CONFIRMED state (early review #1). */
const CONFIRMATION_BASES: ActualAdoptionBasis[] = ['upload', 'receipt'];
/** Bases that may legally hold the PENDING state. */
const PENDING_BASES: ActualAdoptionBasis[] = [
  'enqueue-persisted',
  'enqueue-reused',
  'committed-bind',
  'attempt-authority',
];
/** Runtime whitelist of note bases (r2 review #1: fake bases never persist). */
const NOTE_BASES = ['enqueue-persisted', 'enqueue-reused', 'attempt-authority'] as const;
/** Runtime whitelist of confirm bases (r2 review #1). */
const CONFIRM_BASES = ['upload', 'receipt'] as const;
/** Runtime whitelist of authority proof kinds (r2 review #3). */
const AUTHORITY_PROOF_KINDS = ['active-operation-bind', 'explicit-claim'] as const;

/** The header identity an attempt's authority is proven under. */
export interface AttemptHeaderIdentity {
  learnerKey: string;
  attemptId: string;
  sceneId: string;
  originEpisodeId: string;
  /** The ORIGINAL frozen owner ('' stays '' — a bind never rewrites it). */
  originOwner: string;
}

/** A committed bind's full evidence (typed boundary; P3 submits real ones). */
export type AuthorityBindProof =
  | {
      /** The original ACTIVE operation's real commit bound the owner. */
      kind: 'active-operation-bind';
      /** The FULL plan identity the bound record belongs to. */
      sourcePlan: PlanIdentity;
      source: ActualIdentity;
      destination: ActualIdentity;
    }
  | {
      /** A user's explicit claim committed the move. */
      kind: 'explicit-claim';
      sourcePlan: PlanIdentity;
      source: ActualIdentity;
      destination: ActualIdentity;
    };

// ── Stored shapes ──────────────────────────────────────────────────────────

interface StoredProgressRecord {
  progressVersion: 1;
  scope: string;
  planIdentity: PlanIdentity;
  state: 'pending' | 'confirmed';
  actual?: ActualIdentity;
  adoption?: ActualAdoptionBasis;
  /** Full committed-bind evidence; retained through confirmation (r2 #2). */
  committedBind?: CommittedBindEvidence;
  /** Persisted attempt-authority adoption evidence (P3 §2). */
  authorityAdoption?: AuthorityAdoptionEvidence;
  updatedAt: number;
}

interface StoredAuthorityRecord {
  authorityVersion: 1;
  scope: string;
  header: AttemptHeaderIdentity;
  effectiveOwner: string;
  proof: AuthorityBindProof;
  recordedAt: number;
}

// ── Validation ─────────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Loud API-boundary validation: a caller that omits a required identity
 * plane fails HERE, synchronously — never by silently persisting less. */
function assertValidPlanIdentity(expected: PlanIdentity): void {
  const fields = [
    'learnerKey',
    'attemptId',
    'sceneId',
    'originEpisodeId',
    'questionId',
    'eventId',
    'planRecordToken',
    'frozenPayloadFingerprint',
  ] as const;
  for (const field of fields) {
    if (!isNonEmptyString(expected[field])) {
      throw new TypeError(`PlanIdentity.${field} must be a non-empty string`);
    }
  }
  if (typeof expected.originOwner !== 'string') {
    throw new TypeError('PlanIdentity.originOwner must be a string ("" = unknown)');
  }
}

function assertValidActualIdentity(actual: ActualIdentity): void {
  if (actual === null || typeof actual !== 'object') {
    throw new TypeError('actual identity must be an object');
  }
  const a = actual as Partial<ModernActualIdentity> & Partial<LegacyActualIdentity>;
  if (
    !isNonEmptyString(a.key) ||
    !isNonEmptyString(a.eventId) ||
    !isNonEmptyString(a.fingerprint)
  ) {
    throw new TypeError('actual identity requires key/eventId/fingerprint');
  }
  if (typeof a.owner !== 'string') {
    throw new TypeError('actual identity requires a string owner ("" = unbound)');
  }
  if (a.key !== `${a.owner}|${a.eventId}`) {
    throw new TypeError('actual identity key must be `${owner}|${eventId}`');
  }
  if (a.kind === 'modern') {
    if (!isNonEmptyString(a.recordToken)) {
      throw new TypeError('modern actual identity requires a non-empty recordToken');
    }
    return;
  }
  if (a.kind === 'legacy') {
    if (a.recordToken !== null) {
      throw new TypeError('legacy actual identity requires recordToken: null');
    }
    if (typeof a.recordCreatedAt !== 'number' || !Number.isFinite(a.recordCreatedAt)) {
      throw new TypeError('legacy actual identity requires a real recordCreatedAt');
    }
    return;
  }
  throw new TypeError('actual identity must be a modern/legacy discriminated member');
}

function assertValidHeaderIdentity(header: AttemptHeaderIdentity): void {
  const fields = ['learnerKey', 'attemptId', 'sceneId', 'originEpisodeId'] as const;
  for (const field of fields) {
    if (!isNonEmptyString(header[field])) {
      throw new TypeError(`AttemptHeaderIdentity.${field} must be a non-empty string`);
    }
  }
  if (typeof header.originOwner !== 'string') {
    throw new TypeError('AttemptHeaderIdentity.originOwner must be a string');
  }
}

/**
 * SEMANTIC association of an actual with its plan (early review #1): the
 * actual must be an instance OF this plan item — same event and the same
 * frozen content. Owner/token roles are enforced per update kind.
 */
function actualPlanTieViolation(actual: ActualIdentity, plan: PlanIdentity): string | null {
  if (actual.eventId !== plan.eventId) {
    return 'actual eventId does not belong to this plan item';
  }
  if (actual.fingerprint !== plan.frozenPayloadFingerprint) {
    return 'actual fingerprint does not match the frozen payload';
  }
  return null;
}

/**
 * note-actual admission: the enqueue we performed under the frozen owner —
 * or, for later items of an unknown-origin attempt, the direct creation
 * under the PROVEN attempt owner (P3 §2 'attempt-authority').
 */
function assertNoteActualTies(
  plan: PlanIdentity,
  actual: ActualIdentity,
  basis: 'enqueue-persisted' | 'enqueue-reused' | 'attempt-authority',
  authority?: AuthorityBindProof,
): void {
  if (!NOTE_BASES.includes(basis as (typeof NOTE_BASES)[number])) {
    throw new TypeError('note-actual basis must be a whitelisted enqueue basis');
  }
  const tie = actualPlanTieViolation(actual, plan);
  if (tie !== null) throw new TypeError(tie);
  if (basis === 'attempt-authority') {
    // A later item created directly under the PROVEN attempt owner: only an
    // unknown-origin plan adopts this way (known plans are created bound),
    // the actual must sit under that real owner, and the ADOPTED PROOF must
    // tie to this attempt's header and destination owner. The persisted
    // authority row itself is verified inside the write transaction.
    if (plan.originOwner !== '') {
      throw new TypeError('attempt-authority adoption applies only to unknown-origin plans');
    }
    if (actual.owner === '') {
      throw new TypeError('attempt-authority adoption requires the proven bound owner');
    }
    if (authority === undefined) {
      throw new TypeError('attempt-authority adoption requires its bind proof');
    }
    assertAuthorityProofTies(planHeaderOf(plan), authority);
    if (authority.destination.owner !== actual.owner) {
      throw new TypeError('attempt-authority adoption owner must equal the proof destination');
    }
    return;
  }
  if (authority !== undefined) {
    throw new TypeError('an authority proof applies only to the attempt-authority basis');
  }
  if (actual.owner !== plan.originOwner) {
    throw new TypeError('a noted actual sits under the plan origin owner ("" = unbound enqueue)');
  }
  if (basis === 'enqueue-persisted') {
    // A freshly persisted record is the plan's OWN modern instance — a
    // legacy actual can never be "newly created" by this plan (r2 #1).
    if (actual.kind !== 'modern') {
      throw new TypeError('an enqueue-persisted actual is the plan record (modern)');
    }
    if (actual.recordToken !== plan.planRecordToken) {
      throw new TypeError('an enqueue-persisted actual carries the plan record token');
    }
  }
}

/** confirm admission: the bound instance this plan's upload/receipt proved. */
function assertConfirmTies(
  plan: PlanIdentity,
  actual: ActualIdentity,
  basis: 'upload' | 'receipt',
): void {
  if (!CONFIRM_BASES.includes(basis as (typeof CONFIRM_BASES)[number])) {
    throw new TypeError('confirm basis must be a whitelisted confirmation basis');
  }
  const tie = actualPlanTieViolation(actual, plan);
  if (tie !== null) throw new TypeError(tie);
  if (plan.originOwner !== '') {
    if (actual.owner !== plan.originOwner) {
      throw new TypeError('a known-origin plan confirms only under its origin owner');
    }
  } else if (actual.owner === '') {
    throw new TypeError('a confirm requires the actual queue owner (non-empty)');
  }
}

/** migrate admission: a committed bind of THIS plan's unbound instance. */
function assertMigrateTies(
  plan: PlanIdentity,
  source: ActualIdentity,
  destination: ActualIdentity,
): void {
  // Entry-unified refusal (P3 §2, acceptance limitation): known-origin
  // plans create their records BOUND — a bind mapping for one is impossible
  // history, refused at the ENTRY so a write can never succeed and then
  // read back 'unreadable'.
  if (plan.originOwner !== '') {
    throw new TypeError('a known-origin plan never migrates — its records are created bound');
  }
  const sourceTie = actualPlanTieViolation(source, plan);
  if (sourceTie !== null) throw new TypeError(`mapping source: ${sourceTie}`);
  const destTie = actualPlanTieViolation(destination, plan);
  if (destTie !== null) throw new TypeError(`mapping destination: ${destTie}`);
  if (source.owner !== '') {
    throw new TypeError('a committed bind source is an unbound record (owner "")');
  }
  if (source.fingerprint !== destination.fingerprint) {
    throw new TypeError('migrate-actual requires source/destination of one payload');
  }
  if (destination.owner === '') {
    throw new TypeError('a bind destination requires the real bound owner');
  }
}

/** Field-exact actual-identity equality (kind and every identity plane). */
function actualIdentitiesEqual(a: ActualIdentity, b: ActualIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (
    a.key !== b.key ||
    a.owner !== b.owner ||
    a.eventId !== b.eventId ||
    a.fingerprint !== b.fingerprint ||
    (a.recordToken ?? null) !== (b.recordToken ?? null)
  ) {
    return false;
  }
  if (a.kind === 'legacy' && b.kind === 'legacy') {
    return a.recordCreatedAt === b.recordCreatedAt;
  }
  return true;
}

function planIdentitiesEqual(a: PlanIdentity, b: PlanIdentity): boolean {
  return (
    a.learnerKey === b.learnerKey &&
    a.attemptId === b.attemptId &&
    a.sceneId === b.sceneId &&
    a.originEpisodeId === b.originEpisodeId &&
    a.originOwner === b.originOwner &&
    a.questionId === b.questionId &&
    a.eventId === b.eventId &&
    a.planRecordToken === b.planRecordToken &&
    a.frozenPayloadFingerprint === b.frozenPayloadFingerprint
  );
}

function headerIdentitiesEqual(a: AttemptHeaderIdentity, b: AttemptHeaderIdentity): boolean {
  return (
    a.learnerKey === b.learnerKey &&
    a.attemptId === b.attemptId &&
    a.sceneId === b.sceneId &&
    a.originEpisodeId === b.originEpisodeId &&
    a.originOwner === b.originOwner
  );
}

/**
 * Authority-proof association (early review #3): the proof's plan must BE
 * this header's plan, its source the unbound instance being bound, and its
 * destination the bound instance under the effective owner.
 */
function assertAuthorityProofTies(header: AttemptHeaderIdentity, proof: AuthorityBindProof): void {
  // Runtime kind whitelist at the shared validator — the WRITER rejects a
  // fake kind here (scope stays absent) instead of persisting a row the
  // reader would only later find unreadable (r2 review #3).
  if (
    !AUTHORITY_PROOF_KINDS.includes(
      (proof as { kind?: unknown }).kind as (typeof AUTHORITY_PROOF_KINDS)[number],
    )
  ) {
    throw new TypeError('authority proof kind must be active-operation-bind or explicit-claim');
  }
  assertValidPlanIdentity(proof.sourcePlan);
  if (!headerIdentitiesEqual(planHeaderOf(proof.sourcePlan), header)) {
    throw new TypeError('authority proof sourcePlan does not belong to this attempt header');
  }
  assertValidActualIdentity(proof.source);
  const sourceTie = actualPlanTieViolation(proof.source, proof.sourcePlan);
  if (sourceTie !== null) throw new TypeError(`authority source: ${sourceTie}`);
  if (proof.source.owner !== '') {
    throw new TypeError('authority source is the unbound (owner "") instance');
  }
  if (
    proof.kind === 'active-operation-bind' &&
    (proof.source.kind !== 'modern' ||
      proof.source.recordToken !== proof.sourcePlan.planRecordToken)
  ) {
    throw new TypeError("active-operation-bind requires the plan record's own token");
  }
  assertValidActualIdentity(proof.destination);
  const destTie = actualPlanTieViolation(proof.destination, proof.sourcePlan);
  if (destTie !== null) throw new TypeError(`authority destination: ${destTie}`);
  if (proof.destination.owner === '') {
    throw new TypeError('authority bind destination requires a real owner');
  }
  if (header.originOwner !== '' && proof.destination.owner !== header.originOwner) {
    throw new TypeError('a known-origin header binds only its own origin owner');
  }
}

function planHeaderOf(plan: PlanIdentity): AttemptHeaderIdentity {
  return {
    learnerKey: plan.learnerKey,
    attemptId: plan.attemptId,
    sceneId: plan.sceneId,
    originEpisodeId: plan.originEpisodeId,
    originOwner: plan.originOwner,
  };
}

/**
 * Stored committed-bind evidence must stay INTACT (r2 review #2): both
 * sides fully shaped and tied to the plan, the source unbound, one payload
 * across the move, the destination under its legal owner, and the
 * destination field-exact EQUAL to the record's actual — the evidence
 * describes exactly the instance the record holds.
 */
function committedBindIsIntact(bind: unknown, plan: PlanIdentity, actual: ActualIdentity): boolean {
  if (bind === null || typeof bind !== 'object') return false;
  const candidate = bind as { source?: unknown; destination?: unknown };
  try {
    const source = candidate.source as ActualIdentity;
    const destination = candidate.destination as ActualIdentity;
    assertValidActualIdentity(source);
    assertValidActualIdentity(destination);
    if (actualPlanTieViolation(source, plan) !== null) return false;
    if (actualPlanTieViolation(destination, plan) !== null) return false;
    if (source.owner !== '') return false; // legal bind sources are unbound
    if (source.fingerprint !== destination.fingerprint) return false;
    if (plan.originOwner !== '') {
      if (destination.owner !== plan.originOwner) return false;
    } else if (destination.owner === '') return false;
    return actualIdentitiesEqual(destination, actual);
  } catch {
    return false;
  }
}

/**
 * Stored attempt-authority adoption evidence must stay INTACT (P3 §2): the
 * proof ties to the record's own plan header and its destination owner IS
 * the record's actual owner — and the PERSISTED authority row (read in the
 * same transaction) still proves that owner for this attempt's header.
 */
function authorityAdoptionIsIntact(
  adoption: unknown,
  plan: PlanIdentity,
  actual: ActualIdentity,
  authorityRow: unknown,
): boolean {
  if (adoption === null || typeof adoption !== 'object') return false;
  const candidate = adoption as { header?: unknown; proof?: unknown };
  try {
    const header = candidate.header as AttemptHeaderIdentity;
    const proof = candidate.proof as AuthorityBindProof;
    assertValidHeaderIdentity(header);
    if (!headerIdentitiesEqual(header, planHeaderOf(plan))) return false;
    assertAuthorityProofTies(header, proof);
    if (proof.destination.owner !== actual.owner) return false;
    // The persisted authority row must still carry the SAME proven owner.
    const record = validateStoredAuthority(authorityRow, authorityScope(header));
    return record !== null && headerIdentitiesEqual(record.header, header)
      ? record.effectiveOwner === proof.destination.owner
      : false;
  } catch {
    return false;
  }
}

/** Stored-shape validation for reads: anything malformed is 'unreadable'. */
function validateStoredProgress(
  row: unknown,
  scope: string,
  authorityRow?: unknown,
): StoredProgressRecord | null {
  if (row === null || typeof row !== 'object') return null;
  const record = row as Partial<StoredProgressRecord>;
  if (record.progressVersion !== 1 || record.scope !== scope) return null;
  const plan = record.planIdentity;
  if (plan === null || typeof plan !== 'object') return null;
  try {
    assertValidPlanIdentity(plan as PlanIdentity);
  } catch {
    return null;
  }
  if (record.state !== 'pending' && record.state !== 'confirmed') return null;
  const planRecord = plan as PlanIdentity;
  if (record.actual !== undefined) {
    try {
      assertValidActualIdentity(record.actual);
    } catch {
      return null;
    }
    // Semantic association survives storage (early review #1): a stored
    // actual that drifted from its plan — another event, another content,
    // or a foreign owner on a known-origin plan — is torn, not usable.
    const tie = actualPlanTieViolation(record.actual, planRecord);
    if (tie !== null) return null;
    if (planRecord.originOwner !== '' && record.actual.owner !== planRecord.originOwner) {
      return null;
    }
    if (record.adoption === undefined) return null; // a basis-less actual proves nothing
    // A CONFIRMED unbound actual is impossible history — nothing uploads
    // while unbound (r2 review #2); refuse instead of lending it weight.
    if (record.state === 'confirmed' && record.actual.owner === '') return null;
    // A BOUND actual on an unknown-origin plan requires its COMPLETE
    // adoption evidence — the per-question committed bind OR the verified
    // attempt-authority adoption (P3 §2) — never a bare token claim.
    if (planRecord.originOwner === '' && record.actual.owner !== '') {
      const bindOk = committedBindIsIntact(record.committedBind, planRecord, record.actual);
      const authorityOk =
        record.authorityAdoption === undefined
          ? false
          : authorityAdoptionIsIntact(
              record.authorityAdoption,
              planRecord,
              record.actual,
              authorityRow,
            );
      if (!bindOk && !authorityOk) return null;
    }
  }
  // Known-origin plans create their records BOUND — a committed-bind
  // mapping OR an authority adoption on one is impossible history.
  if (planRecord.originOwner !== '') {
    if (record.committedBind !== undefined) return null;
    if (record.authorityAdoption !== undefined) return null;
  }
  if (record.committedBind !== undefined) {
    if (record.actual === undefined) return null; // evidence without its instance
    if (!committedBindIsIntact(record.committedBind, planRecord, record.actual)) return null;
  }
  if (record.authorityAdoption !== undefined) {
    if (record.actual === undefined) return null;
    if (
      !authorityAdoptionIsIntact(record.authorityAdoption, planRecord, record.actual, authorityRow)
    ) {
      return null;
    }
  }
  if (record.state === 'confirmed') {
    if (record.actual === undefined) return null;
    if (record.adoption === undefined || !CONFIRMATION_BASES.includes(record.adoption)) {
      return null; // confirmed requires its own upload/receipt basis
    }
  } else if (record.adoption !== undefined && !PENDING_BASES.includes(record.adoption)) {
    return null; // pending never carries a confirmation basis
  }
  return record as StoredProgressRecord;
}

function validateStoredAuthority(row: unknown, scope: string): StoredAuthorityRecord | null {
  if (row === null || typeof row !== 'object') return null;
  const record = row as Partial<StoredAuthorityRecord>;
  if (record.authorityVersion !== 1 || record.scope !== scope) return null;
  const header = record.header;
  if (header === null || typeof header !== 'object') return null;
  try {
    assertValidHeaderIdentity(header as AttemptHeaderIdentity);
    if (record.scope !== authorityScope(header as AttemptHeaderIdentity)) return null;
    if (!isNonEmptyString(record.effectiveOwner)) return null;
    const proof = record.proof;
    if (
      proof === null ||
      typeof proof !== 'object' ||
      (proof.kind !== 'active-operation-bind' && proof.kind !== 'explicit-claim')
    ) {
      return null;
    }
    // The FULL stored proof must still tie to its own header (early
    // review #3): a torn or tampered record is never 'proven'.
    assertAuthorityProofTies(header as AttemptHeaderIdentity, proof);
    if (record.effectiveOwner !== proof.destination.owner) return null;
  } catch {
    return null;
  }
  return record as StoredAuthorityRecord;
}

// ── Database plumbing ──────────────────────────────────────────────────────

function progressScope(expected: PlanIdentity): string {
  return `${expected.learnerKey}|${expected.attemptId}|${expected.eventId}`;
}

function authorityScope(header: AttemptHeaderIdentity): string {
  return `${header.learnerKey}|${header.attemptId}`;
}

/**
 * Open the dedicated progress DB. open errors AND blocked opens reject —
 * both are observable failures, never a silent "no store". A success that
 * arrives AFTER a blocked rejection closes its late connection instead of
 * leaking it, and every live connection closes on versionchange so future
 * upgrades are never blocked by us (early review #5).
 */
function openProgressDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let rejectedBlocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: 'scope' });
      }
      if (!db.objectStoreNames.contains(AUTHORITY_STORE)) {
        db.createObjectStore(AUTHORITY_STORE, { keyPath: 'scope' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (rejectedBlocked) {
        db.close(); // the open already failed honestly — don't leak this
        return;
      }
      db.onversionchange = () => db.close(); // never block future upgrades
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('progress db open failed'));
    request.onblocked = () => {
      log.warn('Progress db open blocked by another connection');
      rejectedBlocked = true;
      reject(new Error('progress db open blocked'));
    };
  });
}

// ── Progress reads ─────────────────────────────────────────────────────────

export type CaptureProgressRead =
  | { status: 'absent' }
  | { status: 'unreadable' }
  | { status: 'conflict'; storedPlanIdentity: PlanIdentity }
  | {
      status: 'pending';
      actual?: ActualIdentity;
      adoption?: ActualAdoptionBasis;
      committedBind?: CommittedBindEvidence;
    }
  | {
      status: 'confirmed';
      actual: ActualIdentity;
      adoption?: ActualAdoptionBasis;
      committedBind?: CommittedBindEvidence;
    };

/**
 * Strict progress read. The expectation MUST be the complete plan identity;
 * every field is compared before anything stored may be adopted. Same scope
 * with a different plan is 'conflict' (no borrowed success), a corrupt,
 * forward-version, or semantically torn row is 'unreadable' (never
 * 'absent'), and database failures — including a transaction that aborts
 * after the row was fetched — REJECT so the caller handles them honestly.
 */
export async function readCaptureProgress(expected: PlanIdentity): Promise<CaptureProgressRead> {
  assertValidPlanIdentity(expected);
  const scope = progressScope(expected);
  const db = await openProgressDb();
  try {
    // Stage the row (and, for authority-adoption verification, the
    // attempt's authority row) on request success but resolve ONLY on
    // transaction completion: a late abort of the read transaction rejects
    // instead of resolving a possibly-torn row (early review #5).
    const { row, authorityRow } = await new Promise<{
      row: unknown;
      authorityRow: unknown;
    }>((resolve, reject) => {
      const tx = db.transaction([PROGRESS_STORE, AUTHORITY_STORE], 'readonly');
      let staged: unknown;
      let stagedAuthority: unknown;
      const request = tx.objectStore(PROGRESS_STORE).get(scope);
      request.onsuccess = () => {
        staged = request.result;
      };
      request.onerror = () => reject(request.error);
      const authorityRequest = tx
        .objectStore(AUTHORITY_STORE)
        .get(authorityScope(planHeaderOf(expected)));
      authorityRequest.onsuccess = () => {
        stagedAuthority = authorityRequest.result;
      };
      tx.oncomplete = () => resolve({ row: staged, authorityRow: stagedAuthority });
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    });
    if (row === undefined) return { status: 'absent' };
    const record = validateStoredProgress(row, scope, authorityRow);
    if (record === null) return { status: 'unreadable' };
    if (!planIdentitiesEqual(record.planIdentity, expected)) {
      return { status: 'conflict', storedPlanIdentity: record.planIdentity };
    }
    if (record.state === 'confirmed') {
      return {
        status: 'confirmed',
        actual: record.actual as ActualIdentity,
        ...(record.adoption !== undefined ? { adoption: record.adoption } : {}),
        ...(record.committedBind !== undefined ? { committedBind: record.committedBind } : {}),
      };
    }
    return {
      status: 'pending',
      ...(record.actual !== undefined ? { actual: record.actual } : {}),
      ...(record.adoption !== undefined ? { adoption: record.adoption } : {}),
      ...(record.committedBind !== undefined ? { committedBind: record.committedBind } : {}),
    };
  } finally {
    db.close();
  }
}

// ── Progress writes ────────────────────────────────────────────────────────

export type CaptureProgressUpdate =
  | {
      /** The queue instance is durably known but not yet upload-confirmed. */
      kind: 'note-actual';
      actual: ActualIdentity;
      basis: 'enqueue-persisted' | 'enqueue-reused' | 'attempt-authority';
      /**
       * Required for basis 'attempt-authority' (P3 §2): the committed bind
       * proof adopted from the PERSISTED attempt authority — verified
       * against the stored authority row inside the write transaction.
       */
      authority?: AuthorityBindProof;
    }
  | {
      /** Strict same-instance upload/receipt confirmation. */
      kind: 'confirm';
      actual: ActualIdentity;
      basis: 'upload' | 'receipt';
    }
  | {
      /** Transition the actual along a COMMITTED source→destination bind. */
      kind: 'migrate-actual';
      source: ActualIdentity;
      destination: ActualIdentity;
    };

export type CaptureProgressWriteResult =
  | { kind: 'written'; state: 'pending' | 'confirmed' }
  /** The scope holds a DIFFERENT plan (or an unreadable row) — never written. */
  | { kind: 'conflict-plan' }
  /** Same plan, an actual this update cannot legally adopt or become. */
  | { kind: 'conflict-actual' }
  | { kind: 'unreadable' }
  /** Transaction aborted / database failure — the previous state survives. */
  | { kind: 'write-failed' };

/**
 * Transactional progress write. The current record for the scope is read,
 * matched against the FULL expected plan identity, and merged — all inside
 * ONE readwrite transaction whose completion is the ONLY success signal:
 * a late abort returns 'write-failed' with the old state intact. Same
 * plan + same actual is monotonic (confirmed never downgrades); a
 * different plan, an unproven instance, or a confirmed record's mapping
 * never borrows or overwrites.
 */
export async function writeCaptureProgress(
  expected: PlanIdentity,
  update: CaptureProgressUpdate,
): Promise<CaptureProgressWriteResult> {
  assertValidPlanIdentity(expected);
  if (update.kind === 'migrate-actual') {
    assertValidActualIdentity(update.source);
    assertValidActualIdentity(update.destination);
    assertMigrateTies(expected, update.source, update.destination);
  } else {
    assertValidActualIdentity(update.actual);
    if (update.kind === 'note-actual') {
      assertNoteActualTies(expected, update.actual, update.basis, update.authority);
    } else {
      assertConfirmTies(expected, update.actual, update.basis);
    }
  }
  const scope = progressScope(expected);
  const headerScope = authorityScope(planHeaderOf(expected));
  let db: IDBDatabase;
  try {
    db = await openProgressDb();
  } catch {
    return { kind: 'write-failed' };
  }
  try {
    return await new Promise<CaptureProgressWriteResult>((resolve, reject) => {
      // Both stores in ONE transaction: the persisted authority row is read
      // IN-transaction for attempt-authority adoption (P3 §2) and for
      // re-verifying existing rows' adoption evidence.
      const tx = db.transaction([PROGRESS_STORE, AUTHORITY_STORE], 'readwrite');
      const store = tx.objectStore(PROGRESS_STORE);
      let authorityRow: unknown;
      const authorityGet = tx.objectStore(AUTHORITY_STORE).get(headerScope);
      authorityGet.onsuccess = () => {
        authorityRow = authorityGet.result;
      };
      // Decision + write stay INSIDE the transaction: a concurrent same-
      // scope writer serializes behind it and observes this commit.
      let decision: CaptureProgressWriteResult = { kind: 'written', state: 'pending' };
      const current = store.get(scope);
      current.onsuccess = () => {
        try {
          const row = current.result;
          if (row === undefined) {
            if (update.kind === 'migrate-actual') {
              // Absent scope: adopt ONLY a mapping whose source IS this
              // plan's own unbound instance (modern, plan token) — any
              // other source is an adoption we cannot prove (early
              // review #2) and is refused without writing. The COMPLETE
              // mapping is persisted as the adoption evidence (r2 #2).
              if (
                update.source.kind !== 'modern' ||
                update.source.recordToken !== expected.planRecordToken
              ) {
                decision = { kind: 'conflict-actual' };
                return;
              }
              store.put({
                progressVersion: 1,
                scope,
                planIdentity: expected,
                state: 'pending',
                actual: update.destination,
                adoption: 'committed-bind',
                committedBind: { source: update.source, destination: update.destination },
                updatedAt: Date.now(),
              });
              decision = { kind: 'written', state: 'pending' };
              return;
            }
            if (update.kind === 'confirm') {
              // Unknown-origin plans NEVER confirm an absent scope: the
              // record's owner binding must be evidenced by a PERSISTED
              // committed mapping or attempt authority first — a plan
              // token alone cannot masquerade as the binding proof (r2 #1).
              if (expected.originOwner === '') {
                decision = { kind: 'conflict-actual' };
                return;
              }
              // Known-origin absent-scope first confirm: the plan's OWN
              // modern instance (plan token, bound at creation) — a legacy
              // or different-token instance needs a durable adoption
              // (reused note) first.
              if (
                update.actual.kind !== 'modern' ||
                update.actual.recordToken !== expected.planRecordToken
              ) {
                decision = { kind: 'conflict-actual' };
                return;
              }
              store.put({
                progressVersion: 1,
                scope,
                planIdentity: expected,
                state: 'confirmed',
                actual: update.actual,
                adoption: update.basis,
                updatedAt: Date.now(),
              });
              decision = { kind: 'written', state: 'confirmed' };
              return;
            }
            if (update.basis === 'attempt-authority') {
              // In-transaction verification against the PERSISTED
              // authority row (P3 §2): the attempt's proven owner must BE
              // the actual's owner — no invented authority, no cache B.
              const authority = validateStoredAuthority(authorityRow, headerScope);
              if (
                authority === null ||
                !headerIdentitiesEqual(authority.header, planHeaderOf(expected)) ||
                authority.effectiveOwner !== update.actual.owner
              ) {
                decision = { kind: 'conflict-actual' };
                return;
              }
              store.put({
                progressVersion: 1,
                scope,
                planIdentity: expected,
                state: 'pending',
                actual: update.actual,
                adoption: 'attempt-authority',
                authorityAdoption: {
                  header: planHeaderOf(expected),
                  proof: update.authority as AuthorityBindProof,
                },
                updatedAt: Date.now(),
              });
              decision = { kind: 'written', state: 'pending' };
              return;
            }
            store.put({
              progressVersion: 1,
              scope,
              planIdentity: expected,
              state: 'pending',
              actual: update.actual,
              adoption: update.basis,
              updatedAt: Date.now(),
            });
            decision = { kind: 'written', state: 'pending' };
            return;
          }
          const record = validateStoredProgress(row, scope, authorityRow);
          if (record === null) {
            // Unreadable row: cannot prove this scope is the same plan —
            // never overwrite possibly-foreign data.
            decision = { kind: 'unreadable' };
            return;
          }
          if (!planIdentitiesEqual(record.planIdentity, expected)) {
            decision = { kind: 'conflict-plan' };
            return;
          }
          if (update.kind === 'migrate-actual') {
            if (record.state === 'confirmed') {
              // A legal bind source is unbound and hence never uploaded:
              // confirmed state is never copied onto another actual/owner
              // without that target's own strict confirmation (review #2).
              decision = { kind: 'conflict-actual' };
              return;
            }
            if (
              record.actual === undefined ||
              !actualIdentitiesEqual(record.actual, update.source)
            ) {
              decision = { kind: 'conflict-actual' }; // rejected mapping, no downgrade
              return;
            }
            store.put({
              ...record,
              state: 'pending',
              actual: update.destination,
              adoption: 'committed-bind',
              committedBind: { source: update.source, destination: update.destination },
              updatedAt: Date.now(),
            });
            decision = { kind: 'written', state: 'pending' };
            return;
          }
          const actual = update.actual;
          if (record.actual !== undefined && !actualIdentitiesEqual(record.actual, actual)) {
            decision = { kind: 'conflict-actual' }; // different instance: no inheritance
            return;
          }
          if (record.state === 'confirmed') {
            // Monotonic same-instance: a later pending note must never
            // downgrade, and a re-confirm changes nothing durable.
            decision = { kind: 'written', state: 'confirmed' };
            return;
          }
          if (update.kind === 'note-actual' && update.basis === 'attempt-authority') {
            const authority = validateStoredAuthority(authorityRow, headerScope);
            if (
              authority === null ||
              !headerIdentitiesEqual(authority.header, planHeaderOf(expected)) ||
              authority.effectiveOwner !== update.actual.owner
            ) {
              decision = { kind: 'conflict-actual' };
              return;
            }
          }
          const state = update.kind === 'confirm' ? 'confirmed' : 'pending';
          store.put({
            ...record,
            state,
            actual,
            adoption: update.basis,
            ...(update.kind === 'note-actual' && update.basis === 'attempt-authority'
              ? {
                  authorityAdoption: {
                    header: planHeaderOf(expected),
                    proof: update.authority as AuthorityBindProof,
                  },
                }
              : {}),
            updatedAt: Date.now(),
          });
          decision = { kind: 'written', state };
        } catch (error) {
          // A synchronously throwing put (or decision path) must never
          // escape as an uncaught exception inside the request callback:
          // abort this transaction so the write resolves 'write-failed'
          // with the previous state intact (early review #5).
          try {
            tx.abort();
          } catch {
            /* transaction already finished — the rejection below stands */
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      tx.oncomplete = () => resolve(decision);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    });
  } catch {
    return { kind: 'write-failed' }; // late abort / db failure: old state kept
  } finally {
    db.close();
  }
}

// ── Attempt-owner authority boundary ───────────────────────────────────────

export type AttemptAuthorityRead =
  | { status: 'absent' }
  | { status: 'unreadable' }
  | { status: 'conflict' }
  | {
      status: 'proven';
      effectiveOwner: string;
      header: AttemptHeaderIdentity;
      proof: AuthorityBindProof;
    };

export type AttemptAuthorityWriteResult =
  | { kind: 'written' }
  | { kind: 'conflict-header' }
  /** A is recorded: a later B write never rewrites it. */
  | { kind: 'conflict-owner' }
  | { kind: 'unreadable' }
  | { kind: 'write-failed' };

/**
 * Read the attempt's PROVEN effective owner under its original header
 * identity (originOwner stays as frozen — a binding never rewrites the
 * header). Unproven unknowns read 'absent'; the authority is not revoked
 * by later progress writes or older-instance failures.
 */
export async function readAttemptOwnerAuthority(
  header: AttemptHeaderIdentity,
): Promise<AttemptAuthorityRead> {
  assertValidHeaderIdentity(header);
  const scope = authorityScope(header);
  const db = await openProgressDb();
  try {
    const row = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(AUTHORITY_STORE, 'readonly');
      let staged: unknown;
      const request = tx.objectStore(AUTHORITY_STORE).get(scope);
      request.onsuccess = () => {
        staged = request.result;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(staged);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    });
    if (row === undefined) return { status: 'absent' };
    const record = validateStoredAuthority(row, scope);
    if (record === null) return { status: 'unreadable' };
    if (!headerIdentitiesEqual(record.header, header)) return { status: 'conflict' };
    return {
      status: 'proven',
      effectiveOwner: record.effectiveOwner,
      header: record.header,
      proof: record.proof,
    };
  } finally {
    db.close();
  }
}

/**
 * Append-once authority write. The proof must be a committed bind carrying
 * the FULL source plan identity (whose header fields must equal `header`),
 * an unbound source instance tied to that plan (the plan's own token for an
 * active-operation bind; any unbound same-content instance for an explicit
 * claim), and a bound destination under the effective owner — a known-origin
 * header binds ONLY its own owner. There is no "assume" kind to fabricate
 * an owner from a stored token. Once owner A is recorded for the header,
 * the same header + owner is idempotent and any different owner is refused
 * — never rewritten.
 */
export async function recordAttemptOwnerAuthority(
  header: AttemptHeaderIdentity,
  proof: AuthorityBindProof,
): Promise<AttemptAuthorityWriteResult> {
  assertValidHeaderIdentity(header);
  assertAuthorityProofTies(header, proof);
  const scope = authorityScope(header);
  let db: IDBDatabase;
  try {
    db = await openProgressDb();
  } catch {
    return { kind: 'write-failed' };
  }
  try {
    return await new Promise<AttemptAuthorityWriteResult>((resolve, reject) => {
      const tx = db.transaction(AUTHORITY_STORE, 'readwrite');
      const store = tx.objectStore(AUTHORITY_STORE);
      let decision: AttemptAuthorityWriteResult = { kind: 'written' };
      const current = store.get(scope);
      current.onsuccess = () => {
        try {
          const row = current.result;
          if (row === undefined) {
            store.put({
              authorityVersion: 1,
              scope,
              header,
              effectiveOwner: proof.destination.owner,
              proof,
              recordedAt: Date.now(),
            });
            decision = { kind: 'written' };
            return;
          }
          const record = validateStoredAuthority(row, scope);
          if (record === null) {
            decision = { kind: 'unreadable' }; // corrupt row: never overwritten
            return;
          }
          if (!headerIdentitiesEqual(record.header, header)) {
            decision = { kind: 'conflict-header' };
            return;
          }
          // A→A is idempotent (first proof kept); A→B is refused outright.
          decision =
            record.effectiveOwner === proof.destination.owner
              ? { kind: 'written' }
              : { kind: 'conflict-owner' };
        } catch (error) {
          try {
            tx.abort();
          } catch {
            /* transaction already finished */
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      tx.oncomplete = () => resolve(decision);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    });
  } catch {
    return { kind: 'write-failed' };
  } finally {
    db.close();
  }
}

// ── Consumer-side identity builder ─────────────────────────────────────────

/**
 * Build a full actual identity from one side of a queue report (an upload
 * entry or a committed-bind mapping side). The side must carry its OWN
 * eventId and fingerprint and BOTH must strictly equal the expected values
 * — a side for other content can never be washed into this plan's identity
 * by stamping the caller's fingerprint on it (early review #4). Returns
 * null when the side lacks a real instance identity (no token AND no
 * legacy createdAt, a key that is not this event's handle, or missing/
 * mismatched event/fingerprint metadata) — callers then stay honest
 * instead of fabricating one.
 */
export function actualIdentityFromQueueSide(
  side: {
    key: string;
    eventId?: string;
    fingerprint?: string;
    recordToken?: string | null;
    createdAt?: number;
  },
  eventId: string,
  fingerprint: string,
): ActualIdentity | null {
  if (
    !isNonEmptyString(side.key) ||
    !isNonEmptyString(side.eventId) ||
    !isNonEmptyString(side.fingerprint)
  ) {
    return null;
  }
  if (side.eventId !== eventId || side.fingerprint !== fingerprint) return null;
  if (!side.key.endsWith(`|${eventId}`)) return null;
  const owner = side.key.slice(0, side.key.length - eventId.length - 1);
  if (isNonEmptyString(side.recordToken)) {
    return {
      kind: 'modern',
      key: side.key,
      owner,
      eventId,
      fingerprint,
      recordToken: side.recordToken,
    };
  }
  if (typeof side.createdAt === 'number' && Number.isFinite(side.createdAt)) {
    return {
      kind: 'legacy',
      key: side.key,
      owner,
      eventId,
      fingerprint,
      recordToken: null,
      recordCreatedAt: side.createdAt,
    };
  }
  return null;
}
