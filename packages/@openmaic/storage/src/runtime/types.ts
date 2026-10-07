/**
 * RuntimeStore — the persistence contract for the learner-runtime layer
 * (#869): `RuntimeSession`s (identity + lifecycle, partitioned by
 * `(stageId, learnerKey)`) and their append-only `RuntimeRecord`s.
 *
 * The mirror of {@link DocumentStore} for the runtime quadrant of the storage
 * RFC, with the differences the envelope forces:
 *
 * - **Multi-tenant**: a document has ONE stored aggregate; a stage has MANY
 *   runtime sessions — one or more per `(learnerKey, kind)`. Every LISTING is
 *   therefore partition-scoped — there is deliberately no global listing;
 *   single-session operations are id-keyed, and {@link RuntimeStore.mergeLearner}
 *   is the one deliberate cross-stage sweep (the sign-in migration).
 * - **The store owns the version stamp.** The runtime line has no unversioned
 *   epoch, so `createSession` takes {@link RuntimeSessionInit} (no stamp) and
 *   the store stamps `RUNTIME_DSL_VERSION` itself. No code path persists an
 *   unstamped session.
 * - **Records are not independently versioned** — the version rides the parent
 *   session; records are ordered facts under it, `seq` assigned by the store.
 *
 * Payload internals are app-owned: per-kind validators are injected like
 * scene-content validators on DocumentStore, defaulting to the DSL skeleton
 * guards for the skeleton kinds (`chat`, `quizAttempt`).
 */
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
} from '@openmaic/dsl';

/**
 * The shape a caller hands to {@link RuntimeStore.createSession}: a full
 * session minus its version stamp. The store stamps `runtimeDslVersion`
 * itself — sessions are born stamped, and the stamp is the store's write
 * duty, never the caller's.
 */
export type RuntimeSessionInit = Omit<RuntimeSession, 'runtimeDslVersion'>;

/**
 * Validates one kind's record payload at the store's write boundary — the
 * runtime counterpart of `SceneValidator` (#860). Same result shape as the
 * DSL validators so implementations can return them directly.
 */
export type RuntimePayloadValidator = (
  payload: unknown,
) => { valid: true } | { valid: false; errors: { path: string; message: string }[] };

/** A compare-and-append precondition failed inside the store transaction. */
export class RuntimeAppendConflictError extends Error {
  override readonly name = 'RuntimeAppendConflictError';

  constructor(
    readonly sessionId: string,
    readonly expectedLastSeq: number | null,
    readonly actualLastSeq: number | null,
  ) {
    super(
      `@openmaic/storage: session ${JSON.stringify(sessionId)} last seq changed from ` +
        `${String(expectedLastSeq)} to ${String(actualLastSeq)}`,
    );
  }
}

/** Optional compare-and-swap guard against a session's current record tail. */
export interface RuntimeTailOptions {
  /**
   * Compare guard checked in the write transaction. `null` means
   * the caller observed no records; omitted means no precondition.
   */
  expectedLastSeq?: number | null;
}

/**
 * Options of {@link RuntimeStore.setSessionStatusIfLatest}: the tail guard
 * plus the RELEVANCE anchor of the lineage precondition.
 */
export interface RuntimeStatusIfLatestOptions extends RuntimeTailOptions {
  /**
   * When provided, a strictly newer same-kind sibling blocks the write ONLY
   * when the canonical quiz reader would ADOPT it over the target: the
   * sibling's envelope must survive the same migrate+validate gate
   * `listSessions` applies (corrupt envelopes are omitted, never blockers),
   * and the sibling's LATEST record anchored to this scene — never "any
   * anchored record" — must be a valid quiz payload (payloadVersion 1, a
   * real quiz phase, a plain answers record). Newer empty sessions,
   * malformed-payload tails (even over a valid older draft), and quizzes of
   * OTHER scenes never block a legitimate repair. When omitted, ANY strictly
   * newer same-kind sibling blocks (the conservative generic form).
   */
  relevantSceneId?: string;
}

/** Optional parent-session mutation committed with one appended record. */
export interface RuntimeAppendOptions extends RuntimeTailOptions {
  sessionTransition?: {
    status: RuntimeSessionStatus;
    updatedAt: string;
  };
}

/**
 * Persistence contract for runtime sessions + records. All reads migrate on
 * read (`migrateRuntime`); all writes validate the full envelope and stamp /
 * guard the runtime version line. Implementations MUST be safe against
 * version skew from other clients sharing the same storage:
 *
 * - a FUTURE-stamped stored session (written by a newer client) rejects
 *   `appendRecord` / `setSessionStatus` rather than downgrade or corrupt;
 * - an older-stamped stored session is migrated in place before the write
 *   (a documented divergence from `putScene`: records carry no version, so
 *   there are no unmigrated siblings to strand, and this interface has no
 *   full-session save for a caller-side "load and save" remedy).
 */
export interface RuntimeStore {
  /**
   * Persist a new session. Stamps `runtimeDslVersion: RUNTIME_DSL_VERSION`,
   * validates the completed envelope (`validateRuntimeSession`), and fails
   * loud if a session with the same `id` already exists — creating twice is
   * a caller bug, not an upsert.
   */
  createSession(init: RuntimeSessionInit): Promise<RuntimeSession>;

  /**
   * Load one session, migrated to the current runtime version. `undefined` if
   * absent. Fail-loud on a corrupt stored row — whether the corruption is the
   * version stamp (absent / malformed / sibling-stamped) or the rest of the
   * envelope (a session the store itself would refuse to write).
   */
  getSession(sessionId: string): Promise<RuntimeSession | undefined>;

  /**
   * All sessions of one learner on one stage (any status, any kind), migrated,
   * ordered by `createdAt` ascending — by the instant each timestamp denotes,
   * not by string order (ISO-8601 permits numeric zone offsets). The
   * `(stageId, learnerKey)` pair is the partition key of the runtime layer —
   * there is deliberately no global listing. Listings tolerate corrupt rows —
   * version or envelope corruption alike — by omission (one poison row must
   * not make the whole partition unenumerable — the `listDocuments`
   * precedent); a direct {@link getSession} on such an id stays fail-loud, and
   * the delete paths are the cleanup tool.
   */
  listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]>;

  /**
   * Update one session's lifecycle status. `updatedAt` is caller-supplied
   * (the store is clock-free). Throws if the session is absent, if the stored
   * copy is future-stamped, or if the envelope would become invalid — or
   * throws the runtime version line's own error when the stored row's stamp
   * is corrupt (absent / malformed / sibling-stamped). When
   * `expectedLastSeq` is supplied, the status changes only if the record tail
   * still matches, in the same transaction.
   */
  setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
    options?: RuntimeTailOptions,
  ): Promise<void>;

  /**
   * Status write whose lineage precondition is validated ATOMICALLY with the
   * write transaction: the write commits only when no RELEVANT strictly-newer
   * same-kind sibling exists in the `(stageId, learnerKey)` partition (see
   * `RuntimeStatusIfLatestOptions.relevantSceneId`; ordering by the createdAt
   * instant, tie-breaking on id — the `listSessions` order). Returns `true`
   * when the status write committed; `false` when a relevant newer sibling
   * exists — in that case NOTHING was written (an obsolete session is never
   * mutated). The `expectedLastSeq` tail guard keeps its `setSessionStatus`
   * semantics, including its version-validation behavior.
   *
   * This is the atomic "obsolete repair must not reopen the old root"
   * boundary: a read-then-write race across two transactions cannot
   * reactivate a lineage that a concurrent writer already advanced.
   */
  setSessionStatusIfLatest?(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
    options?: RuntimeStatusIfLatestOptions,
  ): Promise<boolean>;

  /** Delete one session and all its records. Idempotent. */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Append one record to an ACTIVE session. The store assigns the
   * per-session monotonic `seq` (starting at 0) inside the same transaction
   * that inserts, validates the completed envelope
   * (`validateRuntimeRecord`), and runs the parent session's kind payload
   * validator if one is configured. Throws if the parent session is absent,
   * not `active`, or future-stamped — or throws the runtime version line's
   * own error when the stored row's stamp is corrupt (absent / malformed /
   * sibling-stamped). When `expectedLastSeq` is supplied, a mismatch throws
   * {@link RuntimeAppendConflictError}. When `sessionTransition` is supplied,
   * the completed parent envelope and record are validated and committed
   * atomically in the same transaction; a conflict or validation failure
   * persists neither.
   */
  appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
    options?: RuntimeAppendOptions,
  ): Promise<RuntimeRecord<TPayload>>;

  /**
   * A session's records ordered by `seq` (the sole replay ordering key).
   * `sceneId` narrows to records anchored to that scene (best-effort anchors;
   * records without a `sceneId` are excluded when the filter is present).
   */
  listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]>;

  /**
   * Re-key every session of `fromLearnerKey` (across ALL stages) to
   * `toLearnerKey` — the anonymous-learner-signs-in migration, and the one
   * deliberate cross-stage sweep in the interface. Returns the number of
   * sessions moved. Idempotent (a second run — or a self-merge — moves 0) and
   * non-clobbering by construction (sessions are keyed by their own `id`).
   *
   * A merge is a write, so it takes the write gates: throws on an empty
   * learner key, on a future-stamped session (a newer client's data must not
   * be mutated), or with the runtime version line's own error when a stored
   * row's stamp is corrupt (absent / malformed / sibling-stamped); every
   * re-keyed envelope is validated before it is written. Any throw aborts the
   * WHOLE merge atomically — no partial move ever lands; delete the offending
   * session to unblock.
   *
   * Collapsing duplicate same-kind sessions after a merge (e.g. keeping one
   * playback session) is app read-policy, not store behavior.
   */
  mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number>;

  /** Delete one learner's sessions + records on one stage. Idempotent. */
  deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void>;

  /**
   * Delete ALL learners' runtime for a stage — the hook a document deletion
   * cascades through. Idempotent, deliberately version-agnostic.
   */
  deleteStageRuntime(stageId: string): Promise<void>;

  /** Delete every runtime session and record. Idempotent and version-agnostic. */
  deleteAllRuntime(): Promise<void>;
}
