/**
 * Mistake-capture outbox (R8) — the ONE reliable capture path every entry
 * point funnels through (quiz review, grading recovery, in-place retry).
 *
 * Contract (per remediation + C early review):
 * - The COMPLETE event payload is frozen and PERSISTED (IndexedDB) BEFORE the
 *   first send; failure/lost-response/reload replays it verbatim.
 * - Owner binding is the SERVER owner, confirmed against the live API on
 *   EVERY flush (never a cached module variable alone): each flush first
 *   re-observes the current owner, then ships events whose creator owner
 *   matches, carrying `expectedOwnerId` so the SERVER rejects the write if
 *   the cookie switched between confirmation and POST. Events from another
 *   owner stay parked (fail closed, never re-attributed); events created
 *   while NO owner was ever confirmed stay unbound until an explicit user
 *   claim — no silent background rebinding.
 * - Persistence honesty: writes resolve only on TRANSACTION completion
 *   (oncomplete, not request.onsuccess); a late abort is reported as
 *   not-persisted. Read failures surface as an explicit local-read-error
 *   status — an unreadable queue is never "empty". Local IDs are keyed by
 *   (owner, eventId) so a new owner can never overwrite another owner's
 *   queued event.
 * - A dedicated IndexedDB (name+version our own) avoids upgrade interference
 *   with the app's Dexie database; the app DB and its data stay untouched.
 */

import { createLogger } from '@/lib/logger';
import type { MistakeCapturePayload } from '@/lib/mistake-book/client';

/**
 * Canonical serialization for content identity (C1 gate #3/#4): key order in
 * the builder's object literals must never decide whether two frozen payloads
 * are "the same event". Keys are sorted recursively; array order is data.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function payloadsIdentical(a: MistakeCapturePayload, b: MistakeCapturePayload): boolean {
  return stableStringify(a) === stableStringify(b);
}

const log = createLogger('MistakeOutbox');

const DB_NAME = 'MAIC-mistake-outbox';
const DB_VERSION = 3;
/**
 * Bounded wait for one openDb() call: an open queued behind a blocked
 * upgrade may never receive its own `blocked` event (the real IndexedDB
 * open-request queue), so a wait past this deadline fails honestly as
 * storage-unavailable instead of hanging the caller.
 */
const OPEN_WAIT_DEADLINE_MS = 2_000;
const STORE = 'events';
/**
 * Committed-upload receipts (C2 design): EVERY successful upload — from ANY
 * flush — records its record key here before the record leaves the queue.
 * A capture whose own flush raced a background flush that already uploaded
 * AND deleted the record (empty read) still finds its confirmation here;
 * a missing receipt is never proof of failure, and a bare eventId never
 * counts. A receipt matches only the EXACT record instance that earned it:
 * key + frozen content fingerprint + the record's creation token (closing
 * gate #2 addendum) — a later, same-looking record at the same key can
 * never borrow it.
 */
const RECEIPTS = 'receipts';
/**
 * Durable binding journal (P3-r1 §7 + r2 §3): the COMPLETE source→destination
 * binding evidence of every committed unbound→owner move — written in the
 * SAME IndexedDB transaction as the move itself (flush bind or explicit
 * claim), so a crash between the queue move and the progress/authority
 * commits still leaves an exact, recoverable bridge. Rows are keyed by the
 * raw source QUEUE key but hold an APPEND-ONLY list of full-instance
 * records: two instances sharing a key/event but differing in token or
 * legacy date keep INDEPENDENT proofs, and the same instance's proof is
 * never overwritten by a later contradictory destination (append-once,
 * exact replay idempotent, contradiction refused without moving the
 * queue). Never pruned — a binding is the only surviving fact for an
 * unfinished plan's recovery and must not be confused with (or trimmed
 * like) upload receipts. v1/v2 events/receipts are untouched by the v3
 * upgrade; r1's flat single-record rows are read compatibly.
 */
const BINDINGS = 'bindings';

/** One durable committed binding (the crash-recovery bridge). */
export interface DurableBindingRecord {
  bindingVersion: 1;
  /** The source instance's owner-scoped key (unbound moves: `|eventId`). */
  sourceKey: string;
  /** Why the move committed: the ACTIVE operation's bind, or a user claim. */
  reason: 'active-bind' | 'explicit-claim';
  source: QueueSideIdentity;
  destination: QueueSideIdentity;
  recordedAt: number;
}

/**
 * The stored journal row (r2 §3): a composite value under the existing
 * `sourceKey` keyPath so no DB version bump is needed. Multiple source
 * instances at one queue key coexist as independent entries.
 */
interface BindingJournalRow {
  sourceKey: string;
  entries: DurableBindingRecord[];
}

/** Exactly-one-plane instance shape for journal matching. */
interface FullSourceInstance {
  key: string;
  eventId: string;
  fingerprint: string;
  recordToken: string | null;
  recordCreatedAt?: number;
}

/** Full-instance equality: queue key + event + fingerprint + the exactly-one
 * modern-token-or-legacy-date plane (r2 §3 — never the bare queue key). */
function fullSourceInstanceEquals(side: QueueSideIdentity, query: FullSourceInstance): boolean {
  if (
    side.key !== query.key ||
    side.eventId !== query.eventId ||
    side.fingerprint !== query.fingerprint
  ) {
    return false;
  }
  const sideToken = side.recordToken ?? null;
  if (sideToken !== null) return sideToken === query.recordToken;
  // Legacy side: token null + its date is the plane; the query must carry
  // the SAME date (a query without one cannot equal a legacy instance).
  return query.recordToken === null && side.createdAt === query.recordCreatedAt;
}

function fullDestinationEquals(a: QueueSideIdentity, b: QueueSideIdentity): boolean {
  return (
    a.key === b.key &&
    a.owner === b.owner &&
    a.eventId === b.eventId &&
    a.fingerprint === b.fingerprint &&
    (a.recordToken ?? null) === (b.recordToken ?? null) &&
    (a.recordToken === null ? a.createdAt === b.createdAt : true)
  );
}

/**
 * Structural validation of ONE journal record's both sides (r2 §3 + r3
 * group 3). TOTAL over `unknown`: null, scalars, arrays, and malformed
 * shapes return false — this function NEVER throws, so no request/tx
 * callback can hang on an unresolved promise.
 */
function bindingRecordIsValid(record: unknown, expectedSourceKey: string): boolean {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  const candidate = record as Partial<DurableBindingRecord>;
  if (candidate.bindingVersion !== 1) return false;
  if (candidate.reason !== 'active-bind' && candidate.reason !== 'explicit-claim') return false;
  if (typeof candidate.sourceKey !== 'string' || candidate.sourceKey !== expectedSourceKey) {
    return false; // row/entry scope association
  }
  if (typeof candidate.recordedAt !== 'number' || !Number.isFinite(candidate.recordedAt)) {
    return false;
  }
  const source = candidate.source;
  const destination = candidate.destination;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  if (destination === null || typeof destination !== 'object' || Array.isArray(destination)) {
    return false;
  }
  if (typeof source.owner !== 'string' || source.owner !== '') return false;
  if (typeof destination.owner !== 'string' || destination.owner === '') return false;
  if (typeof source.eventId !== 'string' || source.eventId === '') return false;
  if (typeof destination.eventId !== 'string' || destination.eventId === '') return false;
  if (typeof source.fingerprint !== 'string' || source.fingerprint === '') return false;
  if (source.eventId !== destination.eventId) return false;
  if (source.fingerprint !== destination.fingerprint) return false;
  if (typeof source.key !== 'string' || source.key !== eventKey('', source.eventId)) return false;
  if (
    typeof destination.key !== 'string' ||
    destination.key !== eventKey(destination.owner, destination.eventId)
  ) {
    return false;
  }
  // Each side carries EXACTLY ONE complete instance plane.
  for (const side of [source, destination]) {
    const token = side.recordToken ?? null;
    if (token !== null) {
      if (typeof token !== 'string' || token === '') return false;
      if (side.createdAt !== undefined) return false; // modern sides carry no date
    } else {
      if (typeof side.createdAt !== 'number' || !Number.isFinite(side.createdAt)) {
        return false; // legacy sides REQUIRE the real date
      }
    }
  }
  return true;
}

/**
 * Normalize a stored journal row to its entry list. r1's flat single-record
 * rows ({bindingVersion, sourceKey, reason, source, destination}) are
 * conservatively accepted as one-entry lists; anything malformed is null
 * (corrupt — the reader must treat it as unreadable, never as absence).
 */
function normalizeJournalRow(
  row: unknown,
  expectedSourceKey: string,
): DurableBindingRecord[] | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const candidate = row as Partial<BindingJournalRow> & Partial<DurableBindingRecord>;
  if (Array.isArray(candidate.entries)) {
    if (typeof candidate.sourceKey !== 'string' || candidate.sourceKey !== expectedSourceKey) {
      return null; // row scope association
    }
    // TOTAL over the entry list: null/scalar/malformed entries corrupt the row.
    for (const entry of candidate.entries) {
      if (!bindingRecordIsValid(entry, expectedSourceKey)) return null;
    }
    return candidate.entries as DurableBindingRecord[];
  }
  // Flat r1 row: valid as a single entry (its own sourceKey scope).
  if (!bindingRecordIsValid(candidate, expectedSourceKey)) return null;
  return [candidate as DurableBindingRecord];
}

interface OutboxEvent {
  /** Row key: `${owner}|${eventId}` — owner-scoped, no cross-owner overwrite. */
  key: string;
  /**
   * Creation token (delivery addendum): present ONLY on events this SESSION
   * persisted itself. Automatic owner binding on identity confirmation is
   * restricted to matching tokens — an unknown offline event from an earlier
   * session has no token and can only be adopted by the explicit claim.
   */
  creationToken?: string;
  eventId: string;
  /** Server owner observed at creation ('' = created before any confirmation). */
  owner: string;
  payload: MistakeCapturePayload;
  createdAt: number;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
  status: 'pending' | 'failed' | 'rejected';
}

function eventKey(owner: string, eventId: string): string {
  return `${owner}|${eventId}`;
}

/**
 * Open the dedicated outbox DB with the same safe lifecycle as the progress
 * DB: open errors AND blocked opens both REJECT — an upgrade held back by
 * another connection is an observable storage failure, never a silent "no
 * store", an empty queue, or a pretend enqueue/upload. A success that
 * arrives AFTER a blocked rejection closes its late connection instead of
 * leaking it (single settlement), and every live connection closes on
 * versionchange so future upgrades are never blocked by us. Upgrade only
 * ever ADDS missing stores — existing rows are never cleared or rebuilt.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // Single settlement across success/error/blocked AND a bounded wait
    // deadline. The deadline covers a REAL open-request queue boundary: an
    // open queued behind another upgrade that is itself blocked may never
    // receive its own `blocked` event — consecutive retries and cross-module
    // reads must fail honestly within the bound instead of hanging. Late
    // successes after any settlement close their connection; the timer is
    // always cleared on first settlement.
    let settled = false;
    const settle = (settleFn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleFn();
    };
    // Registered synchronously before any IndexedDB event can fire, so every
    // settlement path sees an armed timer to clear.
    const timer = setTimeout(() => {
      settle(() => {
        log.warn('Outbox db open timed out waiting behind another connection');
        reject(new Error('outbox db open timed out'));
      });
    }, OPEN_WAIT_DEADLINE_MS);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(RECEIPTS)) {
        db.createObjectStore(RECEIPTS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(BINDINGS)) {
        db.createObjectStore(BINDINGS, { keyPath: 'sourceKey' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close(); // the open already failed honestly — don't leak this
        return;
      }
      settle(() => {
        db.onversionchange = () => db.close(); // never block future upgrades
        resolve(db);
      });
    };
    request.onerror = () =>
      settle(() => reject(request.error ?? new Error('outbox db open failed')));
    request.onblocked = () =>
      settle(() => {
        log.warn('Outbox db open blocked by another connection');
        reject(new Error('outbox db open blocked'));
      });
  });
}

/**
 * Run work in one transaction and resolve ONLY on transaction completion.
 * request.onsuccess fires before commit: resolving there would claim
 * persistence for a transaction that can still abort (quota, version
 * change). onabort/onerror map to an honest rejection.
 */
function txCompletes(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
  storeName: string = STORE,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    work(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
  });
}

export type LocalReadResult = { ok: true; events: OutboxEvent[] } | { ok: false; error: string };

// ── Per-instance send coordination (C2 concurrent-flush design) ─────────────

/** The full instance identity a send slot is scoped to (never the bare key). */
function instanceIdOf(event: OutboxEvent): string {
  return [
    event.key,
    event.owner,
    event.eventId,
    fingerprintOf(event.payload),
    event.creationToken ?? `legacy:${event.createdAt}`,
  ].join('|');
}

/**
 * In-flight send slots per instance, same-context only. The slot promise is
 * a plain gate (never rejects); the sender's work happens outside it.
 */
const sendSlots = new Map<string, Promise<void>>();

/**
 * Acquire THIS instance's send slot: the next same-context caller for the
 * exact same instance waits for the previous sender, then re-reads live
 * durable facts — it never reuses the previous snapshot or borrows its
 * verdict. Returns the release hook (call in finally).
 */
async function acquireSendSlot(instanceId: string): Promise<() => void> {
  const prior = sendSlots.get(instanceId);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  sendSlots.set(instanceId, held);
  if (prior !== undefined) await prior;
  return () => {
    release();
    if (sendSlots.get(instanceId) === held) sendSlots.delete(instanceId);
  };
}

/**
 * TOTAL strict receipt validation over UNKNOWN persisted data: null,
 * scalars, arrays, and torn objects return false — this function NEVER
 * throws (a malformed row in tx.oncomplete must never leave a flush
 * promise unresolved). A completed-upload proof requires the COMPLETE
 * committed metadata: the receipt's OWN key and eventId (never filled from
 * the query), the frozen-content fingerprint, the instance plane (a non-empty modern token, or token null WITH a
 * finite legacy createdAt), and — for the modern plane — the finite
 * upload-commit `at` stamp. A matching fingerprint/token alone with missing or invalid commit
 * metadata is NOT completed proof.
 */
function receiptProvesCompletedUpload(row: unknown, event: OutboxEvent): boolean {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
  const receipt = row as {
    key?: unknown;
    eventId?: unknown;
    fingerprint?: unknown;
    recordToken?: unknown;
    createdAt?: unknown;
    at?: unknown;
  };
  if (typeof receipt.key !== 'string' || receipt.key !== event.key) return false;
  if (typeof receipt.eventId !== 'string' || receipt.eventId === '') return false;
  if (receipt.eventId !== event.eventId) return false;
  if (typeof receipt.fingerprint !== 'string') return false;
  if (receipt.fingerprint !== fingerprintOf(event.payload)) return false;
  const rowToken = receipt.recordToken ?? null;
  const eventToken = event.creationToken ?? null;
  if (rowToken !== null) {
    // Modern plane: non-empty token AND the finite upload-commit stamp —
    // Modern plane: a non-empty token (the row's informational createdAt
    // may ride along — commitUpload stamps it even for modern rows; it is
    // not a plane marker) AND the finite upload-commit `at` stamp.
    if (typeof rowToken !== 'string' || rowToken === '') return false;
    if (typeof receipt.at !== 'number' || !Number.isFinite(receipt.at)) return false;
    return rowToken === eventToken;
  }
  if (rowToken === null) {
    // Legacy plane: token-less AND the finite real date. `at` is optional
    // on legacy v1/v2 rows; when PRESENT it must still be a finite number.
    if (event.creationToken !== undefined) return false; // plane mismatch
    if (typeof receipt.createdAt !== 'number' || !Number.isFinite(receipt.createdAt)) {
      return false;
    }
    if (
      receipt.at !== undefined &&
      (typeof receipt.at !== 'number' || !Number.isFinite(receipt.at))
    ) {
      return false;
    }
    return receipt.createdAt === event.createdAt;
  }
  return false;
}

/**
 * Live-row send revalidation (concurrent-flush design §3): the candidate may
 * only POST when the LIVE committed row is still exactly this instance and
 * eligible. The matching-receipt refusal is layered on top via
 * receiptProvesInstanceUploaded (complete-identity proof).
 */
async function liveInstanceStillSendable(event: OutboxEvent): Promise<boolean> {
  // The matching-receipt refusal (receiptProvesInstanceUploaded, checked by
  // the caller right after this) completes the guard: an exact-instance
  // committed receipt refuses the send — a re-enqueued replay of the SAME
  // once-minted token is not new send authority. A genuinely NEW token/date
  // instance has no matching receipt and remains sendable; crash/no-receipt
  // replays stay retryable (server idempotence remains the backstop).
  try {
    const db = await openDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        let row: OutboxEvent | undefined;
        const getRow = tx.objectStore(STORE).get(event.key);
        getRow.onsuccess = () => {
          row = getRow.result as OutboxEvent | undefined;
        };
        tx.oncomplete = () => {
          if (row === undefined) return resolve(false); // uploaded+deleted / gone
          if (row.owner !== event.owner) return resolve(false);
          if (row.status === 'rejected') return resolve(false); // quarantined
          if ((row.creationToken ?? null) !== (event.creationToken ?? null)) {
            return resolve(false); // replaced instance
          }
          if (
            row.creationToken === undefined &&
            event.creationToken === undefined &&
            row.createdAt !== event.createdAt
          ) {
            return resolve(false); // replaced legacy instance (new timestamp)
          }
          if (!payloadsIdentical(row.payload, event.payload)) return resolve(false);
          resolve(true);
        };
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    return false; // unreadable live facts are never a green light
  }
}

async function receiptProvesInstanceUploaded(event: OutboxEvent): Promise<boolean> {
  try {
    const db = await openDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(RECEIPTS, 'readonly');
        let receipt:
          | {
              key?: string;
              eventId?: string;
              fingerprint?: string;
              recordToken?: string | null;
              createdAt?: number;
            }
          | undefined;
        const getReceipt = tx.objectStore(RECEIPTS).get(event.key);
        getReceipt.onsuccess = () => {
          receipt = getReceipt.result as typeof receipt;
        };
        tx.oncomplete = () => resolve(receiptProvesCompletedUpload(receipt, event));
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    return false; // unreadable receipts are never a refusal either — the
    // caller's queue-row checks above already gate the send.
  }
}

/**
 * Conditional failure/quarantine write (design §4): committed-only on the
 * LIVE instance — atomically refusing absent/deleted rows (no
 * resurrection), replaced token/date/content rows (no overwrite), and rows
 * whose completed receipt already proves the upload. Genuine recoverable
 * failures stay retryable (the caller reports its own verdict either way).
 */
async function putFailureWrite(event: OutboxEvent): Promise<boolean> {
  const db = await openDb();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([STORE, RECEIPTS], 'readwrite');
      const store = tx.objectStore(STORE);
      const receipts = tx.objectStore(RECEIPTS);
      let written = false;
      const current = store.get(event.key);
      current.onsuccess = () => {
        const record = current.result as OutboxEvent | undefined;
        const sameInstance =
          record !== undefined &&
          record.key === event.key &&
          record.eventId === event.eventId &&
          record.owner === event.owner &&
          (record.creationToken ?? null) === (event.creationToken ?? null) &&
          (record.creationToken === undefined ? record.createdAt === event.createdAt : true) &&
          payloadsIdentical(record.payload, event.payload);
        if (!sameInstance) return; // absent/replaced/torn: never resurrect/overwrite
        if (record.status === 'rejected') return; // quarantined facts are terminal
        const receiptGet = receipts.get(event.key);
        receiptGet.onsuccess = () => {
          if (receiptProvesCompletedUpload(receiptGet.result, event)) return; // uploaded
          store.put(event);
          written = true;
        };
      };
      tx.oncomplete = () => resolve(written);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    });
  } finally {
    db.close();
  }
}

async function readAll(): Promise<LocalReadResult> {
  try {
    const db = await openDb();
    try {
      return await new Promise<LocalReadResult>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).getAll();
        request.onsuccess = () =>
          resolve({ ok: true, events: (request.result ?? []) as OutboxEvent[] });
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch (error) {
    // An unreadable queue is NOT an empty queue — surface the failure.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type EnqueueOutcome =
  | { kind: 'persisted'; eventId: string; handle: string; creationToken: string }
  /**
   * Same owner+event with the SAME frozen payload: reuse the REAL record.
   * `recordToken` is the EXISTING record's own creation token — NOT a new
   * proof; callers must match it against proofs they actually hold.
   * `recordCreatedAt` identifies legacy v1 token-less records (the instance
   * identity plane for receipts) — recognition metadata, never a bind proof.
   */
  | {
      kind: 'reused';
      eventId: string;
      handle: string;
      recordToken?: string;
      recordCreatedAt?: number;
    }
  /** Same owner+event with a DIFFERENT payload: the frozen original is kept. */
  | { kind: 'local-conflict'; eventId: string }
  | { kind: 'local-write-failed' };

/** Last owner id CONFIRMED from a live API response ('' = never). */
let confirmedOwner = '';

export function currentConfirmedOwner(): string {
  return confirmedOwner;
}

/** Record the server-observed owner echo from an API response. */
export function observeOwner(ownerId: string | null | undefined): void {
  if (typeof ownerId === 'string' && ownerId) confirmedOwner = ownerId;
}

/**
 * Owner-frozen enqueue outcome with the REAL instance identity (C2-P2):
 * 'persisted' carries the creation token this call wrote; 'reused' carries
 * the EXISTING record's own token (modern) or createdAt (legacy v1) — and
 * its OWN fingerprint — the actual queue identity a progress record must
 * be built from, never the plan's freshly minted token or the caller's
 * expected content stamped over a different record.
 */
export type FrozenOwnerEnqueueOutcome =
  | {
      kind: 'persisted';
      eventId: string;
      handle: string;
      creationToken: string;
      fingerprint: string;
    }
  | {
      kind: 'reused';
      eventId: string;
      handle: string;
      /** The EXISTING record's own fingerprint (identical content by reuse). */
      fingerprint: string;
      recordToken?: string;
      recordCreatedAt?: number;
    }
  | { kind: 'conflict'; eventId: string }
  | { kind: 'local-failed' };

/**
 * Owner-frozen enqueue (Codex intent-design §4): a recovered capture plan
 * enqueues under its FROZEN originOwner — never re-derived from the current
 * cache/cookie. `options.creationToken` carries the plan's ONCE-minted
 * identity so the record's creation proof is the plan's (never re-minted).
 * An '' owner means explicitly-unknown: the record persists UNBOUND
 * (claim-only). No auto-bind proof is issued for unknown origins.
 */
export async function enqueueCaptureEventUnderOwner(
  payload: MistakeCapturePayload,
  frozenOwner: string,
  options: { creationToken?: string } = {},
): Promise<FrozenOwnerEnqueueOutcome> {
  const eventId = payload.eventId;
  if (!eventId) throw new Error('outbox events require a stable eventId');
  const key = eventKey(frozenOwner, eventId);
  const token = options.creationToken ?? `${frozenOwner}|${eventId}|plan`;
  const event: OutboxEvent = {
    key,
    eventId,
    owner: frozenOwner,
    payload: JSON.parse(JSON.stringify(payload)) as MistakeCapturePayload,
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending',
    creationToken: token,
  };
  try {
    const db = await openDb();
    try {
      const verdict = await new Promise<
        | 'stored'
        | 'conflict'
        | { reusedToken: string }
        | { reusedLegacyCreatedAt: number; reusedFingerprint: string }
      >((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        let outcome:
          | 'stored'
          | 'conflict'
          | { reusedToken: string }
          | { reusedLegacyCreatedAt: number; reusedFingerprint: string } = 'stored';
        const existing = store.get(key);
        existing.onsuccess = () => {
          const record = existing.result as OutboxEvent | undefined;
          if (record === undefined) {
            store.put(event);
            return;
          }
          outcome = payloadsIdentical(record.payload, event.payload)
            ? record.creationToken !== undefined
              ? { reusedToken: record.creationToken }
              : {
                  reusedLegacyCreatedAt: record.createdAt,
                  reusedFingerprint: fingerprintOf(record.payload),
                }
            : 'conflict';
        };
        tx.oncomplete = () => resolve(outcome);
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
      if (verdict === 'stored') {
        return {
          kind: 'persisted',
          eventId,
          handle: key,
          creationToken: token,
          fingerprint: fingerprintOf(event.payload),
        };
      }
      if (verdict === 'conflict') return { kind: 'conflict', eventId };
      if (typeof verdict === 'object') {
        if ('reusedToken' in verdict) {
          return {
            kind: 'reused',
            eventId,
            handle: key,
            fingerprint: fingerprintOf(event.payload),
            recordToken: verdict.reusedToken,
          };
        }
        return {
          kind: 'reused',
          eventId,
          handle: key,
          fingerprint: verdict.reusedFingerprint,
          recordCreatedAt: verdict.reusedLegacyCreatedAt,
        };
      }
      return { kind: 'local-failed' };
    } finally {
      db.close();
    }
  } catch {
    log.warn('Outbox owner-frozen enqueue failed');
    return { kind: 'local-failed' };
  }
}

/**
 * Freeze and persist one capture event BEFORE any send (C1 gate #3). One IDB
 * transaction classifies the already-existing cases by CONTENT, never by
 * "key occupied":
 * - key free → the new record is stored ('persisted', with creation proof);
 * - same owner+event with the IDENTICAL frozen payload → 'reused': the REAL
 *   existing record's handle is returned so the caller can follow THIS exact
 *   record through the flush — a 500→200 same-content retransmit must pass,
 *   not be blanket-reported as a conflict;
 * - same owner+event with a DIFFERENT payload → 'local-conflict': the frozen
 *   original is never overwritten and the new content is not persisted.
 * 'reused' never carries a creation token: an already-queued record is not a
 * fresh creation and must not auto-bind to a newly confirmed owner.
 */
export async function enqueueCaptureEvent(payload: MistakeCapturePayload): Promise<EnqueueOutcome> {
  const eventId = payload.eventId;
  if (!eventId) throw new Error('outbox events require a stable eventId');
  const owner = confirmedOwner;
  const key = eventKey(owner, eventId);
  const creationToken = `${owner}|${eventId}|${Date.now().toString(36)}|${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const event: OutboxEvent = {
    key,
    eventId,
    owner,
    payload: JSON.parse(JSON.stringify(payload)) as MistakeCapturePayload,
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending',
    creationToken,
  };
  try {
    const db = await openDb();
    try {
      let reusedCreatedAt: number | undefined;
      const verdict = await new Promise<
        'stored' | 'reused' | 'conflict' | { reusedWithToken: string; reusedCreatedAt?: number }
      >((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        let outcome:
          | 'stored'
          | 'reused'
          | 'conflict'
          | { reusedWithToken: string; reusedCreatedAt?: number } = 'stored';
        const existing = store.get(key);
        existing.onsuccess = () => {
          const record = existing.result as OutboxEvent | undefined;
          if (record === undefined) {
            store.put(event);
            return;
          }
          // Same (owner,eventId): content decides reuse vs conflict. The
          // frozen original is kept either way — never overwritten.
          if (payloadsIdentical(record.payload, event.payload)) {
            if (record.creationToken !== undefined) {
              outcome = { reusedWithToken: record.creationToken };
            } else {
              outcome = 'reused';
              reusedCreatedAt = record.createdAt; // legacy v1 instance identity
            }
          } else {
            outcome = 'conflict';
          }
        };
        tx.oncomplete = () => resolve(outcome);
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
      if (verdict === 'stored') return { kind: 'persisted', eventId, handle: key, creationToken };
      if (verdict === 'reused') {
        return {
          kind: 'reused',
          eventId,
          handle: key,
          ...(reusedCreatedAt !== undefined ? { recordCreatedAt: reusedCreatedAt } : {}),
        };
      }
      if (typeof verdict === 'object' && verdict !== null) {
        return {
          kind: 'reused',
          eventId,
          handle: key,
          recordToken: verdict.reusedWithToken,
          ...(verdict.reusedCreatedAt !== undefined
            ? { recordCreatedAt: verdict.reusedCreatedAt }
            : {}),
        };
      }
      return { kind: 'local-conflict', eventId };
    } finally {
      db.close();
    }
  } catch (error) {
    log.warn('Outbox local persistence failed:', error);
    return { kind: 'local-write-failed' };
  }
}

export interface OutboxStatus {
  pending: number;
  failed: number;
  rejected: number;
  parked: number; // events whose creator owner ≠ currently confirmed owner
  unbound: number; // created before any owner was ever confirmed
  /** Local queue unreadable — honest error, never reported as empty. */
  localError?: string;
  /** Deployment answers 503 on the mistakes route (no server persistence). */
  unconfigured: boolean;
  /** Network unreachable while probing configuration (unknown, not unconfigured). */
  networkUnknown: boolean;
}

const IDENTITY_PROBE_TIMEOUT_MS = 8_000;

export type IdentityProbeOutcome =
  | { kind: 'confirmed'; owner: string }
  | { kind: 'unconfigured' }
  | { kind: 'offline' };

/**
 * Bounded identity probe (C review): only a 200-range response carrying a
 * VALID owner echo counts as confirmation. A 5xx, a missing header, or a
 * network failure is explicitly NOT a confirmation — the module cache is
 * never allowed to claim an identity the server did not actually echo.
 */
export async function probeOwnerIdentity(): Promise<IdentityProbeOutcome> {
  try {
    const response = await fetch('/api/mistakes?count=unmastered', {
      signal: AbortSignal.timeout(IDENTITY_PROBE_TIMEOUT_MS),
    });
    if (response.status === 503) return { kind: 'unconfigured' };
    // A DB error or a missing echo is NOT an identity: nothing is confirmed
    // and the caller must not proceed on any cached owner (delivery review #1).
    if (!response.ok) return { kind: 'offline' };
    const echo = response.headers.get('x-owner-id');
    if (typeof echo === 'string' && echo) {
      observeOwner(echo);
      return { kind: 'confirmed', owner: echo };
    }
    return { kind: 'offline' }; // no echo: identity NOT confirmed
  } catch {
    return { kind: 'offline' };
  }
}

export async function outboxStatus(): Promise<OutboxStatus> {
  const read = await readAll();
  const probe = await probeOwnerIdentity();
  const status: OutboxStatus = {
    pending: 0,
    failed: 0,
    rejected: 0,
    parked: 0,
    unbound: 0,
    unconfigured: probe.kind === 'unconfigured',
    networkUnknown: probe.kind === 'offline',
  };
  if (!read.ok) {
    status.localError = read.error;
    return status;
  }
  const liveOwner = probe.kind === 'confirmed' ? probe.owner : null;
  for (const event of read.events) {
    if (event.status === 'failed') status.failed += 1;
    else if (event.status === 'rejected') status.rejected += 1;
    else status.pending += 1;
    if (event.owner === '') status.unbound += 1;
    else if (liveOwner === null || event.owner !== liveOwner) status.parked += 1;
  }
  return status;
}

/** One reported queue record — identified by its FULL identity, never key alone. */
export interface FlushEntry {
  /** Row key `${owner}|${eventId}` — the real record handle (C1 gate #5). */
  key: string;
  eventId: string;
  /**
   * The handle this record was known by BEFORE this pass's bind moved it
   * (unbound `|eventId` → `owner|eventId`). Callers that persisted the
   * record unbound correlate through this field — a key change on adoption
   * must never orphan their handle.
   */
  boundFrom?: string;
  /** Frozen-content fingerprint of the record this verdict describes. */
  fingerprint?: string;
  /** The record instance's creation token (identity plane of verdicts). */
  recordToken?: string | null;
  /** Legacy token-less records: createdAt is the instance identity. */
  createdAt?: number;
}

/**
 * One queue/report side's COMPLETE real identity (P3 §1): every plane comes
 * from the record itself inside the same transaction — owner, owner-scoped
 * key, event, frozen-content fingerprint, and the modern creation token or
 * the legacy createdAt. Consumers match strictly against ALL planes and
 * never stamp expected values over a foreign record.
 */
export interface QueueSideIdentity {
  /** Row key `${owner}|${eventId}` — the real record handle. */
  key: string;
  owner: string;
  eventId: string;
  fingerprint: string;
  /** The record's creation token, or null for legacy v1 token-less rows. */
  recordToken: string | null;
  /** Legacy token-less records: createdAt is the instance identity. */
  createdAt?: number;
}

/**
 * A COMMITTED bind's source→destination identity mapping (gate line 29):
 * published only after the move transaction completes, carrying BOTH sides'
 * FULL identities re-read inside that transaction. Consumers migrate a
 * source handle only when the source side (key + token, legacy createdAt)
 * matches their proof, then adopt the destination identity — so a background
 * flush that already uploaded and deleted the destination still leaves the
 * caller a consumable trail even when this report's other lists are empty.
 */
export interface CommittedBindMapping {
  source: QueueSideIdentity;
  destination: QueueSideIdentity;
}

export interface FlushReport {
  uploaded: FlushEntry[];
  /** Transient failures (5xx / network): the record stays queued, retried. */
  failed: FlushEntry[];
  /** Permanently refused (400 / EVENT_PAYLOAD_CONFLICT): quarantined. */
  rejected: FlushEntry[];
  /**
   * Bind conflicts (implementation review): the caller's freshly persisted
   * record could not be attributed because the target (owner,eventId)
   * already holds DIFFERENT frozen content. Reported by the source's own
   * key — explicitly a conflict, never silently "just unbound".
   */
  conflicts: FlushEntry[];
  parked: FlushEntry[];
  unbound: FlushEntry[];
  /** Bind moves COMMITTED by this pass (source→destination full identity). */
  committedBinds: CommittedBindMapping[];
}

/**
 * Flush under the CURRENT server owner, re-confirmed live at the start of
 * every flush: unbound events are never auto-bound here (they need an
 * explicit claim), foreign-owner events stay parked, matching events ship
 * with `expectedOwnerId` so the server's guard rejects any cookie switch
 * that happened after our confirmation. Every entry is reported by its full
 * owner-scoped key so a caller can only ever correlate results with the
 * exact frozen record it submitted (C1 gate #5) — two sessions sharing an
 * eventId under different owners can never borrow each other's success.
 *
 * Concurrent-flush coordination (C2 design): each caller keeps its OWN
 * probe, binding options, committed mappings, and report — passes are
 * never coalesced. The only shared state is a per-INSTANCE send slot:
 * same-context callers sending the exact same record instance (key +
 * owner + fingerprint + token-or-legacy-date) serialize on that instance,
 * and a waiting caller RE-READS the live durable facts after the previous
 * sender settles — it never re-POSTs a deleted/uploaded instance and never
 * borrows the previous sender's uploaded verdict (its consumer confirms
 * through the durable receipt instead). Server event-id idempotence
 * remains the cross-tab/crash backstop; the slot is same-context only.
 */
export async function flushOutbox(
  options: { bindNewEvents?: ReadonlyArray<{ eventId: string; creationToken: string }> } = {},
): Promise<FlushReport> {
  const report: FlushReport = {
    uploaded: [],
    failed: [],
    rejected: [],
    conflicts: [],
    parked: [],
    unbound: [],
    committedBinds: [],
  };
  // ONE identity contract for every caller (delivery review #1): only a
  // healthy response with a valid echo opens the flush, and the owner is
  // FROZEN for the whole pass — 500 / missing echo / offline mean no POST at
  // all, never "configured + cached owner".
  const probe = await probeOwnerIdentity();
  if (probe.kind !== 'confirmed') return report;
  const flushOwner = probe.owner; // immutable snapshot for this pass
  /**
   * Pre-bind handles of records this pass adopted (target key → source key).
   * EMPTY until the bind transaction COMMITS — an aborted move publishes no
   * alias (implementation review).
   */
  const bindAdoptions = new Map<string, string>();
  const entryFor = (event: OutboxEvent): FlushEntry => {
    const boundFrom = bindAdoptions.get(event.key);
    const identity = {
      fingerprint: fingerprintOf(event.payload),
      recordToken: event.creationToken ?? null,
      ...(event.creationToken === undefined ? { createdAt: event.createdAt } : {}),
    };
    return boundFrom === undefined
      ? { key: event.key, eventId: event.eventId, ...identity }
      : { key: event.key, eventId: event.eventId, boundFrom, ...identity };
  };

  // Bind THIS call's newly persisted events to the freshly confirmed owner
  // (delivery review #3, C1 gate #4): persist-first means they were created
  // unbound; a live confirmation now atomically adopts exactly the records
  // the caller can PROVE it created (same creation token, still unbound).
  // Every source is RE-READ inside the one move transaction — a stale
  // readAll snapshot never decides a move — then the target is checked:
  // absent → put-new + delete-old commit together; same content → the
  // record already exists under this owner (stray twin dropped); different
  // content → explicit conflict, the frozen target wins and the source
  // stays unbound for the explicit claim. Pre-existing unknown events are
  // NEVER adopted here.
  if (options.bindNewEvents && options.bindNewEvents.length > 0) {
    const candidates = options.bindNewEvents;
    /**
     * targetKey → pre-bind source key: keeps caller handles valid across the
     * move. STAGED inside the transaction and PUBLISHED ONLY on
     * tx.oncomplete (implementation review): a late abort must not leave an
     * uncommitted alias — especially with a same-content target, where the
     * target's later upload must never read as the still-unbound source's
     * success.
     */
    const stagedAdoptions = new Map<string, string>();
    /** Bind conflicts (target holds DIFFERENT content), also committed-only. */
    const stagedConflicts: FlushEntry[] = [];
    /** Full source→destination identities, published on commit only. */
    const stagedMappings: CommittedBindMapping[] = [];
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        // The queue move AND its durable binding journal entry commit in
        // the SAME transaction (P3-r1 §7): a crash after tx.complete
        // leaves the exact recoverable bridge, never a moved record with
        // no evidence.
        const tx = db.transaction([STORE, BINDINGS], 'readwrite');
        const store = tx.objectStore(STORE);
        const bindings = tx.objectStore(BINDINGS);
        const step = (index: number) => {
          if (index >= candidates.length) return;
          const candidate = candidates[index]!;
          // Source re-get INSIDE this transaction (C1 gate #4): the record
          // must still exist, still be unbound, and still carry THIS call's
          // creation proof at move time — not at snapshot time.
          const source = store.get(eventKey('', candidate.eventId));
          source.onsuccess = () => {
            const record = source.result as OutboxEvent | undefined;
            if (
              !record ||
              record.owner !== '' ||
              record.creationToken !== candidate.creationToken
            ) {
              step(index + 1);
              return;
            }
            const targetKey = eventKey(flushOwner, record.eventId);
            const target = store.get(targetKey);
            target.onsuccess = () => {
              const existingTarget = target.result as OutboxEvent | undefined;
              // P3 §1: both mapping sides carry the records' COMPLETE real
              // identity (owner/key/event/fingerprint/token-or-date), read
              // inside THIS transaction — never caller expectations.
              const sideOf = (row: OutboxEvent, key: string, owner: string): QueueSideIdentity => ({
                key,
                owner,
                eventId: row.eventId,
                fingerprint: fingerprintOf(row.payload),
                recordToken: row.creationToken ?? null,
                ...(row.creationToken === undefined ? { createdAt: row.createdAt } : {}),
              });
              const sourceIdentity = sideOf(record, record.key, '');
              let moved: CommittedBindMapping | null = null;
              if (existingTarget === undefined) {
                moved = {
                  source: sourceIdentity,
                  // The moved record keeps its own payload/token; only the
                  // owner-scoped key/owner change.
                  destination: sideOf(record, targetKey, flushOwner),
                };
              } else if (payloadsIdentical(existingTarget.payload, record.payload)) {
                // Same-content dedupe: source and target are DIFFERENT
                // instances — the mapping carries each side's ACTUAL token
                // or legacy date (the target's own, never the source's).
                moved = {
                  source: sourceIdentity,
                  destination: sideOf(existingTarget, targetKey, flushOwner),
                };
              } else {
                // Different content: the frozen target wins — THIS source is
                // reported as an explicit conflict (not merely left unbound),
                // carrying the source's FULL identity for strict consumers.
                stagedConflicts.push({
                  key: record.key,
                  eventId: record.eventId,
                  fingerprint: fingerprintOf(record.payload),
                  recordToken: record.creationToken ?? null,
                  ...(record.creationToken === undefined ? { createdAt: record.createdAt } : {}),
                });
                step(index + 1);
                return;
              }
              // r2 §3 APPEND-ONCE durable evidence, decided INSIDE the same
              // transaction: read the journal row for this source QUEUE key
              // first. Another FULL instance at the same key coexists; the
              // SAME full instance with an IDENTICAL destination is an
              // idempotent replay; the same instance with a CONTRADICTORY
              // destination refuses the move entirely (the original proof is
              // never replaced, the queue is never moved inconsistently); a
              // corrupt row also refuses (corruption is never permission).
              const journalGet = bindings.get(moved.source.key);
              journalGet.onsuccess = () => {
                const existing =
                  journalGet.result === undefined
                    ? []
                    : normalizeJournalRow(journalGet.result, moved.source.key);
                if (existing === null) {
                  // Corrupt journal row at this key: fail closed — no move,
                  // no overwrite; reported as an explicit conflict.
                  stagedConflicts.push({
                    key: record.key,
                    eventId: record.eventId,
                    fingerprint: fingerprintOf(record.payload),
                    recordToken: record.creationToken ?? null,
                    ...(record.creationToken === undefined ? { createdAt: record.createdAt } : {}),
                  });
                  step(index + 1);
                  return;
                }
                const duplicate = existing.find((entry) =>
                  fullSourceInstanceEquals(entry.source, {
                    key: moved!.source.key,
                    eventId: moved!.source.eventId,
                    fingerprint: moved!.source.fingerprint,
                    recordToken: moved!.source.recordToken,
                    ...(moved!.source.recordToken === null
                      ? { recordCreatedAt: moved!.source.createdAt }
                      : {}),
                  }),
                );
                if (duplicate !== undefined) {
                  if (fullDestinationEquals(duplicate.destination, moved.destination)) {
                    // EXACT REPLAY (r3 group 3): the proof already stands.
                    // Queue/proof consistency — the source row still exists
                    // (it was re-created or the original move aborted after
                    // the journal committed). Restore the exact PROVEN
                    // destination transactionally when it is missing; never
                    // delete the source against an imagined destination row.
                    const provenDestinationGet = store.get(duplicate.destination.key);
                    provenDestinationGet.onsuccess = () => {
                      const provenDestination = provenDestinationGet.result as
                        | OutboxEvent
                        | undefined;
                      if (provenDestination === undefined) {
                        // Restore the destination ONLY when THIS source's
                        // frozen content is exactly the proven side's
                        // content — otherwise leave the source unbound and
                        // retryable, inventing no success.
                        if (duplicate.destination.fingerprint === fingerprintOf(record.payload)) {
                          // Re-materialize the proven destination from THIS
                          // identical frozen content, carrying the PROVEN
                          // side's own token/date identity, and complete the
                          // proven move (the source twin is consumed).
                          store.put({
                            ...record,
                            owner: duplicate.destination.owner,
                            key: duplicate.destination.key,
                            ...(duplicate.destination.recordToken === null
                              ? {
                                  creationToken: undefined,
                                  createdAt: duplicate.destination.createdAt,
                                }
                              : { creationToken: duplicate.destination.recordToken }),
                          });
                          store.delete(record.key);
                        }
                        // Content mismatch: the source stays unbound and
                        // retryable — nothing invented.
                      } else {
                        // Destination exists: the source twin is redundant.
                        store.delete(record.key);
                      }
                      stagedAdoptions.set(duplicate.destination.key, record.key);
                      step(index + 1);
                    };
                    return;
                  }
                  // Contradictory destination for the SAME instance: keep
                  // the original proof, refuse this move.
                  stagedConflicts.push({
                    key: record.key,
                    eventId: record.eventId,
                    fingerprint: fingerprintOf(record.payload),
                    recordToken: record.creationToken ?? null,
                    ...(record.creationToken === undefined ? { createdAt: record.createdAt } : {}),
                  });
                  step(index + 1);
                  return;
                }
                if (existingTarget === undefined) {
                  store.put({ ...record, owner: flushOwner, key: targetKey });
                }
                store.delete(record.key);
                stagedAdoptions.set(targetKey, record.key);
                stagedMappings.push(moved);
                bindings.put({
                  sourceKey: moved.source.key,
                  entries: [
                    ...existing,
                    {
                      bindingVersion: 1,
                      sourceKey: moved.source.key,
                      reason: 'active-bind',
                      source: moved.source,
                      destination: moved.destination,
                      recordedAt: Date.now(),
                    } satisfies DurableBindingRecord,
                  ],
                } satisfies BindingJournalRow);
                step(index + 1);
              };
            };
          };
        };
        step(0);
        tx.oncomplete = () => {
          // Publish ONLY what committed: on abort both collections stay empty
          // and the records keep their pre-bind verdicts (source unbound).
          for (const [targetKey, sourceKey] of stagedAdoptions) {
            bindAdoptions!.set(targetKey, sourceKey);
          }
          report.committedBinds.push(...stagedMappings);
          report.conflicts.push(...stagedConflicts);
          resolve();
        };
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
    } catch {
      /* binding failure leaves the event unbound — claim can adopt it */
    } finally {
      db.close();
    }
  }

  const read = await readAll();
  if (!read.ok) return report; // read failures surface via outboxStatus()

  /** One candidate's send work (slot + revalidation + transport + verdict). */
  const processCandidate = async (event: OutboxEvent): Promise<void> => {
    // Per-instance send coordination (C2 concurrent-flush design §1/§3):
    // serialize same-context senders of THIS exact instance; after the
    // slot is acquired, REVALIDATE the live row — a waiting caller whose
    // instance was uploaded+deleted by the previous sender reports NOTHING
    // for it (its consumer confirms via the durable receipt), and a stale
    // candidate never POSTs on old authority. The slot always releases in
    // finally, including on transport failure/throw.
    let releaseSlot: (() => void) | null = null;
    try {
      releaseSlot = await acquireSendSlot(instanceIdOf(event));
      if (!(await liveInstanceStillSendable(event))) {
        return; // gone/quarantined/replaced — not ours to send
      }
      if (await receiptProvesInstanceUploaded(event)) {
        return; // exact instance already uploaded (complete receipt) — a
        // same-token re-enqueue inherits no new send authority
      }
      const response = await fetch('/api/mistakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...event.payload, expectedOwnerId: event.owner }),
      });
      observeOwner(response.headers.get('x-owner-id'));
      if (response.ok) {
        // Receipt + delete in ONE transaction, conditional on the record
        // still being THIS frozen content (receipt方案审查): an aborted
        // transaction keeps the record queued for an idempotent replay and
        // publishes NO local commit — a receipt without its delete, or a
        // delete without its receipt, can never exist.
        const committed = await commitUpload(event).catch(() => false);
        if (!committed) return; // stays queued; the next flush replays (server no-ops)
        report.uploaded.push(entryFor(event));
      } else if (response.status === 409) {
        // WHICH 409 decides the fate: an owner-mismatch refusal is an
        // identity switch (recoverable — the event stays pending under its
        // creator owner and will upload when that identity is confirmed
        // again); an event-payload conflict is permanent (quarantine).
        const code = (await response.json().catch(() => ({}))).errorCode;
        if (code === 'OWNER_MISMATCH') {
          report.parked.push(entryFor(event)); // recoverable, NOT rejected
          return;
        }
        await putFailureWrite({
          ...event,
          status: 'rejected',
          attempts: event.attempts + 1,
          lastAttemptAt: Date.now(),
          lastError: 'EVENT_PAYLOAD_CONFLICT',
        }).catch(() => {});
        report.rejected.push(entryFor(event));
      } else if (response.status === 400) {
        // Permanently malformed event: quarantine with the reason.
        await putFailureWrite({
          ...event,
          status: 'rejected',
          attempts: event.attempts + 1,
          lastAttemptAt: Date.now(),
          lastError: 'HTTP 400',
        }).catch(() => {});
        report.rejected.push(entryFor(event));
      } else {
        await putFailureWrite({
          ...event,
          status: 'failed',
          attempts: event.attempts + 1,
          lastAttemptAt: Date.now(),
          lastError: `HTTP ${response.status}`,
        }).catch(() => {});
        report.failed.push(entryFor(event));
      }
    } catch (error) {
      await putFailureWrite({
        ...event,
        status: 'failed',
        attempts: event.attempts + 1,
        lastAttemptAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
      report.failed.push(entryFor(event));
    } finally {
      releaseSlot?.();
    }
  };

  // Two-phase sweep (final review — unrelated-question transport liveness):
  // a candidate whose instance is CURRENTLY being sent by another caller is
  // DEFERRED, not awaited — unrelated candidates in the same pass send NOW
  // (independent work, no shared reports, no borrowed verdicts). The
  // deferred ones run afterwards, blocking on their slots as before.
  const deferred: OutboxEvent[] = [];
  for (const event of read.events) {
    if (event.status === 'rejected') {
      // permanently refused server-side — still reported so a caller holding
      // this exact record's handle learns its verdict (C1 gate #5)
      report.rejected.push(entryFor(event));
      continue;
    }
    if (event.owner === '') {
      // Created before ANY owner confirmation: keep parked until an explicit
      // claim action binds it — no background attribution.
      report.unbound.push(entryFor(event));
      continue;
    }
    if (event.owner !== flushOwner) {
      report.parked.push(entryFor(event)); // another owner's event: fail closed
      continue;
    }
    if (sendSlots.has(instanceIdOf(event))) {
      deferred.push(event); // another sender owns this instance right now
      continue;
    }
    await processCandidate(event);
  }
  for (const event of deferred) {
    await processCandidate(event);
  }
  return report;
}

export interface ClaimReport {
  claimed: string[];
  /**
   * Committed owner-scoped handles of THIS claim's successful moves
   * (claim结果消费补审): consumers intersect these with a flush's uploaded
   * keys — a GLOBAL upload count can never stand in for what THIS claim
   * actually synced. Same-content dedupe targets count too (the twin is
   * the claimed record's real identity now).
   */
  claimedHandles: Array<{ key: string; eventId: string }>;
  /**
   * FULL source→destination mappings of THIS claim's committed moves
   * (P3-r1 §7): each side carries its own complete real identity (the
   * dedupe target's own token/date/fingerprint — never the source's).
   */
  committedMappings: CommittedBindMapping[];
  /** Events whose target (owner,eventId) exists with DIFFERENT content — kept, not claimed. */
  conflicts: string[];
  /**
   * Whether the live identity probe confirmed an owner for this pass (C2):
   * an unconfirmed claim moved NOTHING — the UI must say so instead of
   * silently reading "nothing to claim".
   */
  identityConfirmed: boolean;
  /** The local queue could not be read — claimed/conflicts are meaningless. */
  storageError: boolean;
}

/**
 * Explicit user claim (data-management affordance): binds unbound events to
 * the CURRENTLY CONFIRMED server owner. The readAll snapshot only nominates
 * candidate KEYS — every source is RE-READ inside the one move transaction
 * (C1 gate #4): a record that moved, bound, or vanished after the snapshot
 * is skipped, never copied from stale memory. Per record: target absent →
 * put-new + delete-old commit together; target with the SAME content → the
 * record already exists under this owner (stray twin dropped, counted as
 * claimed); target with DIFFERENT content → explicit conflict — the frozen
 * target is never overwritten and the source stays for inspection.
 */
export async function claimUnboundEvents(): Promise<ClaimReport> {
  const report: ClaimReport = {
    claimed: [],
    claimedHandles: [],
    committedMappings: [],
    conflicts: [],
    identityConfirmed: false,
    storageError: false,
  };
  // Live-confirm the identity FIRST and freeze it for the whole claim pass
  // (delivery review #1): a stale module owner must never decide target keys,
  // and an unconfirmed identity claims nothing.
  const probe = await probeOwnerIdentity();
  if (probe.kind !== 'confirmed') return report;
  report.identityConfirmed = true;
  const claimOwner = probe.owner;

  const read = await readAll();
  if (!read.ok) {
    report.storageError = true;
    return report;
  }
  const sourceKeys = read.events.filter((event) => event.owner === '').map((event) => event.key);
  if (sourceKeys.length === 0) return report;

  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    report.storageError = true; // cannot even open the queue — never "success"
    return report;
  }
  try {
    const outcomes = await new Promise<
      Array<{ eventId: string; outcome: 'claimed' | 'conflict' | 'skipped' }>
    >((resolve, reject) => {
      // The claim move AND its durable binding journal entry commit in the
      // SAME transaction (P3-r1 §7) — the reason is the user's explicit
      // claim, and the full source→destination evidence survives crashes.
      const tx = db.transaction([STORE, BINDINGS], 'readwrite');
      const store = tx.objectStore(STORE);
      const bindings = tx.objectStore(BINDINGS);
      const collected: Array<{ eventId: string; outcome: 'claimed' | 'conflict' | 'skipped' }> = [];
      /** Handles published ONLY on tx completion (committed moves). */
      const committedHandles: Array<{ key: string; eventId: string }> = [];
      /** Full committed mappings, published ONLY on tx completion. */
      const committedMappings: CommittedBindMapping[] = [];
      const sideOf = (row: OutboxEvent, key: string, owner: string): QueueSideIdentity => ({
        key,
        owner,
        eventId: row.eventId,
        fingerprint: fingerprintOf(row.payload),
        recordToken: row.creationToken ?? null,
        ...(row.creationToken === undefined ? { createdAt: row.createdAt } : {}),
      });
      const step = (index: number) => {
        if (index >= sourceKeys.length) return;
        // Source re-get INSIDE this transaction (C1 gate #4): only a record
        // that still exists and is still unbound at move time is claimed.
        const source = store.get(sourceKeys[index]!);
        source.onsuccess = () => {
          const record = source.result as OutboxEvent | undefined;
          if (!record || record.owner !== '') {
            collected.push({ eventId: '', outcome: 'skipped' });
            step(index + 1);
            return;
          }
          const targetKey = eventKey(claimOwner, record.eventId);
          const target = store.get(targetKey);
          target.onsuccess = () => {
            const existingTarget = target.result as OutboxEvent | undefined;
            const sourceIdentity = sideOf(record, record.key, '');
            let moved: CommittedBindMapping;
            if (existingTarget === undefined) {
              moved = {
                source: sourceIdentity,
                destination: sideOf(record, targetKey, claimOwner),
              };
            } else if (payloadsIdentical(existingTarget.payload, record.payload)) {
              // The dedupe target IS the claimed record's new identity — its
              // OWN token/date/fp, and its handle counts as claimed (the
              // twin belongs to this owner now).
              moved = {
                source: sourceIdentity,
                destination: sideOf(existingTarget, targetKey, claimOwner),
              };
            } else {
              collected.push({ eventId: record.eventId, outcome: 'conflict' });
              step(index + 1);
              return;
            }
            // r2 §3 APPEND-ONCE, decided INSIDE the claim transaction: the
            // same full instance keeps its FIRST committed destination — an
            // exact replay is idempotent, a contradictory destination (e.g.
            // a later claim to B after A) is REFUSED without moving the
            // queue or replacing the original proof; a corrupt journal row
            // equally refuses.
            const journalGet = bindings.get(moved.source.key);
            journalGet.onsuccess = () => {
              const existing =
                journalGet.result === undefined
                  ? []
                  : normalizeJournalRow(journalGet.result, moved.source.key);
              const refuse = () => {
                collected.push({ eventId: record.eventId, outcome: 'conflict' });
                step(index + 1); // the ONLY cursor advance on this branch
              };
              if (existing === null) {
                refuse(); // corrupt journal: fail closed
                return;
              }
              const duplicate = existing.find((entry) =>
                fullSourceInstanceEquals(entry.source, {
                  key: moved.source.key,
                  eventId: moved.source.eventId,
                  fingerprint: moved.source.fingerprint,
                  recordToken: moved.source.recordToken,
                  ...(moved.source.recordToken === null
                    ? { recordCreatedAt: moved.source.createdAt }
                    : {}),
                }),
              );
              if (duplicate !== undefined) {
                if (!fullDestinationEquals(duplicate.destination, moved.destination)) {
                  refuse(); // contradictory destination — original proof wins
                  return;
                }
                // EXACT REPLAY (r4 group 3): the proof already stands. Do
                // NOT delete the source against an imagined destination —
                // transactionally restore the PROVEN destination when it is
                // missing (identical frozen content) and CONSUME the source
                // twin in the SAME transaction; when the destination exists,
                // the twin is redundant and is dropped. The claimed
                // handle/mapping/success publish ONLY on transaction
                // completion — a late abort restores both queue and journal
                // facts (staged collections are discarded by the catch).
                const provenGet = store.get(duplicate.destination.key);
                provenGet.onsuccess = () => {
                  const proven = provenGet.result as OutboxEvent | undefined;
                  let consistent = true;
                  if (proven === undefined) {
                    if (duplicate.destination.fingerprint === fingerprintOf(record.payload)) {
                      store.put({
                        ...record,
                        owner: duplicate.destination.owner,
                        key: duplicate.destination.key,
                        ...(duplicate.destination.recordToken === null
                          ? {
                              creationToken: undefined,
                              createdAt: duplicate.destination.createdAt,
                            }
                          : { creationToken: duplicate.destination.recordToken }),
                      });
                      store.delete(record.key); // the proven move completes
                    } else {
                      // Content mismatch: keep the source unbound retryable
                      // and report a conflict — restoration is unprovable.
                      consistent = false;
                    }
                  } else {
                    store.delete(record.key);
                  }
                  if (!consistent) {
                    collected.push({ eventId: record.eventId, outcome: 'conflict' });
                  } else {
                    committedHandles.push({
                      key: duplicate.destination.key,
                      eventId: record.eventId,
                    });
                    committedMappings.push(moved);
                    collected.push({ eventId: record.eventId, outcome: 'claimed' });
                  }
                  step(index + 1); // the ONLY cursor advance on this branch
                };
                return;
              }
              if (existingTarget === undefined) {
                // claimOwner (the frozen snapshot) binds the row and key alike.
                store.put({ ...record, owner: claimOwner, key: targetKey });
              }
              store.delete(record.key);
              committedHandles.push({ key: moved.destination.key, eventId: record.eventId });
              committedMappings.push(moved);
              bindings.put({
                sourceKey: moved.source.key,
                entries: [
                  ...existing,
                  {
                    bindingVersion: 1,
                    sourceKey: moved.source.key,
                    reason: 'explicit-claim',
                    source: moved.source,
                    destination: moved.destination,
                    recordedAt: Date.now(),
                  } satisfies DurableBindingRecord,
                ],
              } satisfies BindingJournalRow);
              collected.push({ eventId: record.eventId, outcome: 'claimed' });
              step(index + 1);
            };
          };
        };
      };
      step(0);
      tx.oncomplete = () => {
        report.claimedHandles = committedHandles;
        report.committedMappings = committedMappings;
        resolve(collected);
      };
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    });
    for (const entry of outcomes) {
      if (entry.outcome === 'claimed') report.claimed.push(entry.eventId);
      else if (entry.outcome === 'conflict') report.conflicts.push(entry.eventId);
    }
  } catch {
    // An aborted/failed move transaction moved NOTHING — the unbound events
    // stay claimable, and the UI is told the storage failed instead of
    // reading an empty success (C2 implementation review #4).
    report.claimed = [];
    report.claimedHandles = [];
    report.committedMappings = [];
    report.conflicts = [];
    report.storageError = true;
  } finally {
    db.close();
  }
  return report;
}

/**
 * Strict durable-binding lookup (P3-r1 §7 recovery bridge): the committed
 * binding journal entry for EXACTLY this source instance (full identity —
 * key, event, fingerprint, modern token or legacy date). Never scans other
 * owners or bare event ids: a foreign instance's binding recovers nothing.
 * Read failures are 'unreadable' — never 'absent'.
 */
export type BindingJournalStatus =
  | { status: 'absent' }
  | { status: 'found'; binding: DurableBindingRecord }
  | { status: 'unreadable' };

export async function readBindingJournal(source: {
  key: string;
  eventId: string;
  fingerprint: string;
  recordToken?: string | null;
  recordCreatedAt?: number;
}): Promise<BindingJournalStatus> {
  // The query must NAME its instance plane exactly (r2 §3): a modern token,
  // or legacy null WITH the real date — never an ambiguous permission.
  if (typeof source.recordToken === 'string' && source.recordToken !== '') {
    if (source.recordCreatedAt !== undefined) {
      return { status: 'unreadable' }; // malformed query — refuse honestly
    }
  } else if (source.recordToken === null) {
    if (typeof source.recordCreatedAt !== 'number') return { status: 'unreadable' };
  } else {
    return { status: 'unreadable' };
  }
  try {
    const db = await openDb();
    try {
      return await new Promise<BindingJournalStatus>((resolve, reject) => {
        const tx = db.transaction(BINDINGS, 'readonly');
        let staged: unknown;
        const request = tx.objectStore(BINDINGS).get(source.key);
        request.onsuccess = () => {
          staged = request.result;
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => {
          if (staged === undefined) {
            resolve({ status: 'absent' });
            return;
          }
          const entries = normalizeJournalRow(staged, source.key);
          if (entries === null) {
            // A corrupt row at this key is UNREADABLE — corruption is never
            // permission to enqueue or rebind (r2 §3).
            resolve({ status: 'unreadable' });
            return;
          }
          const matches = entries.filter((entry) =>
            fullSourceInstanceEquals(entry.source, {
              key: source.key,
              eventId: source.eventId,
              fingerprint: source.fingerprint,
              recordToken: source.recordToken ?? null,
              ...(source.recordCreatedAt !== undefined
                ? { recordCreatedAt: source.recordCreatedAt }
                : {}),
            }),
          );
          if (matches.length === 0) {
            resolve({ status: 'absent' }); // another INSTANCE's proof — not ours
            return;
          }
          const destinations = new Set(matches.map((entry) => JSON.stringify(entry.destination)));
          if (destinations.size > 1) {
            // Contradictory proofs for the SAME full instance: unreadable.
            resolve({ status: 'unreadable' });
            return;
          }
          resolve({ status: 'found', binding: matches[0]! });
        };
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    return { status: 'unreadable' };
  }
}

/** Bounded receipts retention: keep the most recent N upload receipts. */
let RECEIPT_RETENTION = 500;

/** Test-only: shrink the retention window to exercise the persisted trim. */
export function __setReceiptRetentionForTests(limit: number): void {
  RECEIPT_RETENTION = limit;
}

/**
 * Fingerprint of a frozen payload (stable key order) — the CONTENT identity
 * half of a receipt (receipt方案审查): a receipt matches only the exact
 * record content that earned it, never a same-key different-payload record.
 */
export function fingerprintOf(payload: MistakeCapturePayload): string {
  return stableStringify(payload);
}

/**
 * Commit one upload locally: write the receipt AND delete the queue record
 * in a SINGLE transaction, deleting only if the record still holds THIS
 * frozen content. Aborts roll both back (the record replays idempotently on
 * the next flush) and no local commit is published. Receipts are pruned to
 * a bounded window so the store cannot grow forever.
 */
async function commitUpload(event: OutboxEvent): Promise<boolean> {
  const fingerprint = fingerprintOf(event.payload);
  const db = await openDb();
  try {
    let receiptCommitted = false;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, RECEIPTS], 'readwrite');
      const events = tx.objectStore(STORE);
      const receipts = tx.objectStore(RECEIPTS);
      const current = events.get(event.key);
      current.onsuccess = () => {
        const record = current.result as OutboxEvent | undefined;
        const sameInstance =
          record !== undefined &&
          fingerprintOf(record.payload) === fingerprint &&
          (record.creationToken ?? null) === (event.creationToken ?? null) &&
          // Legacy token-less rows: createdAt is the only surviving instance
          // identity — a same-content re-enqueue has a different timestamp.
          (record.creationToken !== undefined || record.createdAt === event.createdAt);
        if (!sameInstance) {
          // Replaced/vanished (recordToken addendum): THIS instance did not
          // commit locally here — at most a STRICTLY-matching prior receipt
          // (key + fingerprint + token, legacy token both null AND the same
          // createdAt) can confirm it; two missing tokens alone prove
          // nothing about record identity.
          const prior = receipts.get(event.key);
          prior.onsuccess = () => {
            const row = prior.result as
              | { fingerprint?: string; recordToken?: string | null; createdAt?: number }
              | undefined;
            receiptCommitted =
              row !== undefined &&
              row.fingerprint === fingerprint &&
              (row.recordToken ?? null) === (event.creationToken ?? null) &&
              (event.creationToken !== undefined ||
                (row.createdAt === event.createdAt && event.creationToken === undefined));
          };
          return;
        }
        receipts.put({
          key: event.key,
          eventId: event.eventId,
          fingerprint,
          recordToken: record.creationToken ?? null,
          createdAt: record.createdAt,
          at: Date.now(),
        });
        events.delete(record.key);
        receiptCommitted = true;
        // Bounded retention from the REAL persisted count (closing-gate #2
        // addendum): the store is trimmed inside THIS transaction whenever it
        // exceeds the window — module-memory counters reset on every reload
        // and would let receipts grow forever.
        const total = receipts.count();
        total.onsuccess = () => {
          if (total.result <= RECEIPT_RETENTION) return;
          const all = receipts.getAll();
          all.onsuccess = () => {
            const rows = ((all.result ?? []) as Array<{ key: string; at: number }>)
              // NEVER trim the key committed in THIS transaction — filter
              // FIRST (a same-ms tie with this key sorting earliest would
              // otherwise leave the store above the window when sliced
              // after filtering).
              .filter((row) => row.key !== event.key)
              .sort((a, b) => a.at - b.at);
            const surplus = rows.length + 1 - RECEIPT_RETENTION;
            if (surplus > 0) {
              rows.slice(0, surplus).forEach((row) => receipts.delete(row.key));
            }
          };
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    });
    // True ONLY when a receipt for THIS exact content actually exists in the
    // committed transaction (written now, or strictly matched from before) —
    // an HTTP 200 alone is never reported as a local commit.
    if (!receiptCommitted) return false;
    return true;
  } finally {
    db.close();
  }
}

/**
 * Strict receipt replay (P3 §1): which of the given full identity queries
 * have a committed-upload receipt — from ANY flush, including one that
 * raced this caller's read. ALL identity planes must match: the
 * owner-scoped key, the frozen content fingerprint, AND the instance plane
 * (modern creation token, or both-token-less + the same legacy createdAt) —
 * a same-content record with a different token/date is a DIFFERENT instance
 * and cannot borrow the earlier one's success. The result carries the
 * receipt rows' OWN full identity (never the caller's expectations) so
 * progress consumers can confirm against real metadata; a failed read is
 * `ok: false` — honest, never a downgrade to "no receipts".
 */
export type StrictReceiptsResult =
  | { ok: true; matched: QueueSideIdentity[] }
  | { ok: false; error: string };

export async function readReceipts(
  entries: ReadonlyArray<{
    key: string;
    fingerprint: string;
    recordToken?: string | null;
    /** Legacy token-less records: createdAt is the instance identity. */
    createdAt?: number;
  }>,
): Promise<StrictReceiptsResult> {
  const matched: QueueSideIdentity[] = [];
  if (entries.length === 0) return { ok: true, matched };
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(RECEIPTS, 'readonly');
        const store = tx.objectStore(RECEIPTS);
        let pending = entries.length;
        for (const entry of entries) {
          const request = store.get(entry.key);
          request.onsuccess = () => {
            const row = request.result as
              | {
                  eventId?: string;
                  fingerprint?: string;
                  recordToken?: string | null;
                  createdAt?: number;
                }
              | undefined;
            const rowToken = row?.recordToken ?? null;
            const entryToken = entry.recordToken ?? null;
            const tokenProvesInstance = rowToken !== null && rowToken === entryToken;
            // Legacy token-less receipts: two missing tokens are NOT an
            // instance proof — the createdAt plane must match instead.
            const legacyProvesInstance =
              rowToken === null &&
              entryToken === null &&
              row?.createdAt !== undefined &&
              entry.createdAt === row.createdAt;
            if (
              row !== undefined &&
              row.fingerprint === entry.fingerprint &&
              (tokenProvesInstance || legacyProvesInstance)
            ) {
              // The matched side carries the RECEIPT ROW's own real values.
              matched.push({
                key: entry.key,
                owner: entry.key.slice(0, Math.max(0, entry.key.lastIndexOf('|'))),
                eventId: row.eventId ?? '',
                fingerprint: row.fingerprint,
                recordToken: rowToken,
                ...(rowToken === null && row.createdAt !== undefined
                  ? { createdAt: row.createdAt }
                  : {}),
              });
            }
            pending -= 1;
            if (pending === 0) return; // staged only — NEVER resolve here
          };
          request.onerror = () => reject(request.error);
        }
        // P3-r1 §4: matched rows are published ONLY on transaction
        // completion — a late abort (quota etc.) after the last request's
        // success must return ok:false, never a staged match list.
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
    } finally {
      db.close();
    }
    return { ok: true, matched };
  } catch (error) {
    /* unreadable receipts prove nothing — callers keep their current state */
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Drop every queued event (data-management affordance). Honest: throws on failure. */
export async function clearOutbox(): Promise<void> {
  const db = await openDb();
  try {
    await txCompletes(db, 'readwrite', (store) => {
      store.clear();
    });
  } finally {
    db.close();
  }
}

/** Test-only direct read of the queue (never used by production paths). */
export async function __readAllForTests(): Promise<LocalReadResult> {
  return readAll();
}

/** Test-only: seed a legacy v1 token-less record (no creationToken). */
export async function __seedLegacyRecordForTests(row: {
  key: string;
  eventId: string;
  owner: string;
  createdAt: number;
  payload: MistakeCapturePayload;
}): Promise<void> {
  const db = await openDb();
  try {
    await txCompletes(db, 'readwrite', (store) => {
      store.put({
        key: row.key,
        eventId: row.eventId,
        owner: row.owner,
        payload: row.payload,
        createdAt: row.createdAt,
        attempts: 0,
        status: 'pending',
      });
    });
  } finally {
    db.close();
  }
}

/**
 * Strict structured capture-evidence query (P3 §1 — replaces the removed
 * bare-eventId/any-owner `hasCaptureEvidence` shortcut): given ONE
 * instance's complete expected identity (frozen plan + adopted actual),
 * report what the queue and the receipt store REALLY hold for that exact
 * owner-scoped key. Every plane must match — owner/key/event/fingerprint
 * plus the modern token or the legacy createdAt — and the returned side
 * carries the stored row's OWN metadata, never the caller's expectations.
 * 'conflict' means something exists at the key for a DIFFERENT
 * instance/content; 'unreadable' means the read failed — never downgraded
 * to 'absent'. Resolves only on transaction completion.
 */
export interface CaptureEvidenceQuery {
  /** The frozen expected owner ('' = the unbound bucket). */
  owner: string;
  eventId: string;
  fingerprint: string;
  /** Modern instance plane; null queries the legacy token-less plane. */
  recordToken?: string | null;
  /** Legacy token-less instance plane. */
  recordCreatedAt?: number;
}

export type CaptureEvidenceStatus =
  | { status: 'absent' }
  | { status: 'queued'; side: QueueSideIdentity }
  | { status: 'receipt'; side: QueueSideIdentity }
  | { status: 'conflict' }
  | { status: 'unreadable' };

export async function readCaptureEvidence(
  query: CaptureEvidenceQuery,
): Promise<CaptureEvidenceStatus> {
  // P3-r1 §4: the query must NAME its instance plane explicitly — a modern
  // token, or legacy null WITH the real date. A missing/ambiguous plane is
  // a caller bug (never a permission to treat "no token" as legacy-null).
  if (typeof query.recordToken === 'string' && query.recordToken !== '') {
    if (query.recordCreatedAt !== undefined) {
      throw new TypeError('a modern-token query must not also carry a legacy date');
    }
  } else if (query.recordToken === null) {
    if (typeof query.recordCreatedAt !== 'number') {
      throw new TypeError("a legacy query requires the record's real createdAt");
    }
  } else {
    throw new TypeError('the query must name its instance plane (token, or null + date)');
  }
  const key = eventKey(query.owner, query.eventId);
  try {
    const db = await openDb();
    try {
      return await new Promise<CaptureEvidenceStatus>((resolve, reject) => {
        const tx = db.transaction([STORE, RECEIPTS], 'readonly');
        let queued: OutboxEvent | undefined;
        let receipt:
          | {
              eventId?: string;
              fingerprint?: string;
              recordToken?: string | null;
              createdAt?: number;
            }
          | undefined;
        const queuedRequest = tx.objectStore(STORE).get(key);
        queuedRequest.onsuccess = () => {
          queued = queuedRequest.result as OutboxEvent | undefined;
        };
        queuedRequest.onerror = () => reject(queuedRequest.error);
        const receiptRequest = tx.objectStore(RECEIPTS).get(key);
        receiptRequest.onsuccess = () => {
          receipt = receiptRequest.result as typeof receipt;
        };
        receiptRequest.onerror = () => reject(receiptRequest.error);
        tx.oncomplete = () => {
          const queryToken = query.recordToken ?? null;
          const planeMatches = (
            rowToken: string | null,
            rowCreatedAt: number | undefined,
          ): boolean => {
            if (queryToken !== null) return rowToken === queryToken;
            // Legacy query: token-less row AND the same real date.
            return rowToken === null && rowCreatedAt === query.recordCreatedAt;
          };
          // Queued record: verify the ROW's own identity against the store
          // key and the query (owner/key/event), classify rejected rows as
          // PERMANENT conflicts, and derive the fingerprint from the frozen
          // payload — never from the query.
          if (queued !== undefined) {
            if (
              queued.key !== key ||
              queued.owner !== query.owner ||
              queued.eventId !== query.eventId
            ) {
              resolve({ status: 'unreadable' }); // torn row vs its own store key
              return;
            }
            if (queued.status === 'rejected') {
              resolve({ status: 'conflict' }); // permanently refused — not queued
              return;
            }
            const queuedFingerprint = fingerprintOf(queued.payload);
            const queuedToken = queued.creationToken ?? null;
            if (
              queuedFingerprint === query.fingerprint &&
              planeMatches(queuedToken, queued.createdAt)
            ) {
              resolve({
                status: 'queued',
                side: {
                  key,
                  owner: queued.owner,
                  eventId: queued.eventId,
                  fingerprint: queuedFingerprint,
                  recordToken: queuedToken,
                  ...(queuedToken === null ? { createdAt: queued.createdAt } : {}),
                },
              });
              return;
            }
            resolve({ status: 'conflict' }); // the key holds a different instance
            return;
          }
          // Receipt row: its OWN required metadata must be present and
          // consistent — a torn/corrupt receipt is 'unreadable', and the
          // event id must be the row's REAL one (never filled from the query).
          if (receipt !== undefined) {
            if (
              typeof receipt.eventId !== 'string' ||
              receipt.eventId === '' ||
              receipt.eventId !== query.eventId ||
              typeof receipt.fingerprint !== 'string'
            ) {
              resolve({ status: 'unreadable' }); // corrupt receipt metadata
              return;
            }
            const receiptToken = receipt.recordToken ?? null;
            if (
              receipt.fingerprint === query.fingerprint &&
              planeMatches(receiptToken, receipt.createdAt)
            ) {
              resolve({
                status: 'receipt',
                side: {
                  key,
                  owner: query.owner,
                  eventId: receipt.eventId,
                  fingerprint: receipt.fingerprint,
                  recordToken: receiptToken,
                  ...(receiptToken === null && typeof receipt.createdAt === 'number'
                    ? { createdAt: receipt.createdAt }
                    : {}),
                },
              });
              return;
            }
            resolve({ status: 'conflict' });
            return;
          }
          resolve({ status: 'absent' });
        };
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    return { status: 'unreadable' }; // read failure is NOT absence
  }
}

/**
 * Production helper (gate group 5): the stable event id a capture for the
 * given attempt/question mints — used to check durable outbox evidence when
 * a review is restored after a crash between review commit and enqueue.
 */
export function captureEventIdFor(attemptId: string, questionId: string): string {
  const tuple = JSON.stringify([attemptId, questionId]);
  return tuple.length <= 200 ? tuple : `ev:${stableStringify(tuple).slice(0, 33)}`;
}
