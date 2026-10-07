'use client';

/**
 * `/mistake-book` — the owner's mistake book (错题本).
 *
 * Mistakes are grouped into a subject → grade/semester → course tree (the
 * curriculum taxonomy inferred at generation time, editable per course), with
 * in-place retry: choice questions are graded locally (the correct answer is
 * part of the captured snapshot), short answers get the reference answer plus
 * self-assessment. One correct retry marks the question mastered; a wrong
 * retry re-captures (wrong_count+1, back to the unmastered pool).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BookX,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { MistakeRecordView } from '@/lib/persistence/mistake-book';
import type { QuizQuestion } from '@/lib/types/stage';
import {
  buildRetryPayload,
  classifyStage,
  deleteMistakeRecord,
  fetchMistakes,
  reportRetryWrong,
  setMistakeMastered,
} from '@/lib/mistake-book/client';
import { gradeChoiceSubmission, resolveChoiceKey } from '@/lib/quiz/grading';
import { gradeShortAnswerQuestion } from '@/lib/quiz/ai-grade';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { MathText } from '@/components/quiz/math-text';
import { createLogger } from '@/lib/logger';

const log = createLogger('MistakeBook');
import {
  createRetryUploadController,
  type RetryUploadController,
} from '@/lib/mistake-book/retry-controller';
import { encodeEventId } from '@/lib/mistake-book/client';
import type { MistakeCapturePayload } from '@/lib/mistake-book/client';

type MistakeRetryPayload = MistakeCapturePayload;
import {
  COURSE_SUBJECTS,
  GRADE_SEMESTERS,
  normalizeCourseSubject,
  normalizeGradeSemester,
  gradeSemesterLabelKey,
  groupMistakesByCurriculum,
  subjectLabelKey,
} from '@/lib/curriculum/taxonomy';

type Filter = 'all' | 'unmastered' | 'mastered';
type RetryState =
  | { kind: 'idle' }
  | { kind: 'answered'; correct: boolean; uploaded: 'ok' | 'failed' | 'pending' }
  | { kind: 'ungraded' }
  | { kind: 'revealed' };

function optionList(options: unknown): Array<{ label: string; value: string }> {
  return Array.isArray(options)
    ? (options as Array<{ label: string; value: string }>).filter(
        (option) => option && typeof option.label === 'string' && typeof option.value === 'string',
      )
    : [];
}

function answerText(answer: unknown): string {
  if (typeof answer === 'string') return answer;
  if (Array.isArray(answer)) return answer.map((part) => String(part)).join('、');
  return '—';
}

/**
 * Canonical retry grading — the SAME fail-closed resolver the classroom uses
 * (R5): the snapshotted key resolves against the snapshotted options by exact
 * unique value/label alignment; an unverifiable key (missing/unknown/
 * ambiguous/duplicate) is returned as 'ungraded', never guessed.
 */
function gradeRetry(
  record: MistakeRecordView,
  picked: string[],
): 'correct' | 'incorrect' | 'ungraded' {
  // No String() coercion: a JSONB snapshot may hold [null]/[0], and coerced
  // they could masquerade as labels. The resolver itself rejects non-string
  // entries; a legacy bare-string key is the one accepted older shape.
  const rawKey: unknown[] = Array.isArray(record.correctAnswer)
    ? record.correctAnswer
    : typeof record.correctAnswer === 'string'
      ? [record.correctAnswer]
      : [];
  const key = resolveChoiceKey(
    optionList(record.options),
    rawKey,
    record.questionType === 'multiple' ? 'multiple' : 'single',
  );
  return gradeChoiceSubmission(key, picked);
}

export default function MistakeBookPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [mistakes, setMistakes] = useState<MistakeRecordView[]>([]);
  const [filter, setFilter] = useState<Filter>('unmastered');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [reloadToken, setReloadToken] = useState(0);
  /** POST committed but the refresh failed — offer a re-read, never a resend. */
  const [refreshFailed, setRefreshFailed] = useState(false);
  /** Last mutation failure copy key ('delete' | 'clear' | 'mastered'). */
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Request generation (R11): only the NEWEST in-flight response may land; a
  // slow older filter response can never overwrite a newer one.
  const requestGeneration = useRef(0);
  // Latest filter for post-mutation refreshes — a mutation completing while
  // the user switched filters must refresh what is SELECTED NOW, not the
  // filter captured when the mutation started.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const mistakesRef = useRef(mistakes);
  mistakesRef.current = mistakes;
  const configuredLoadedRef = useRef(false);
  // The filter whose data is CURRENTLY on screen (delivery addendum): the
  // stale banner must label the records' own filter, not the one that just
  // failed to load.
  const shownFilterRef = useRef<Filter>('unmastered');
  // REAL cancellation for reload (C2 page gate): a newer generation aborts
  // the older request's fetch — a superseded GET cannot resolve into state
  // at all (AbortError is supersession, never a load failure).
  const requestAbortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async (nextFilter: Filter) => {
    const generation = ++requestGeneration.current;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    // Background re-reads keep the current cards mounted (inputs, retry
    // state, open dialogs survive); the full-screen loader is for the FIRST
    // load of a session with nothing on screen yet.
    const isInitial =
      mistakesRef.current.length === 0 && loadError === false && !configuredLoadedRef.current;
    const isBackground = configuredLoadedRef.current;
    if (isInitial) setLoading(true);
    setLoadError(false);
    try {
      const result = await fetchMistakes(nextFilter, { signal: controller.signal });
      if (requestGeneration.current !== generation) return; // superseded
      setConfigured(result.configured);
      setMistakes(result.mistakes);
      setRefreshFailed(false);
      configuredLoadedRef.current = true;
      shownFilterRef.current = nextFilter; // records on screen now belong to this filter
    } catch (error) {
      if (requestGeneration.current !== generation) return;
      if (error instanceof DOMException && error.name === 'AbortError') return; // superseded
      setLoadError(true);
      log.warn('Failed to load mistake book:', error);
      return false;
    } finally {
      if (requestGeneration.current === generation) {
        if (isBackground) configuredLoadedRef.current = true;
        setLoading(false);
      }
    }
    return true;
    // Generation bookkeeping is deliberately NOT reverted on early return:
    // every issued request increments once; late arrivals simply mismatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + setters only; re-running reload on state changes is not wanted
  }, []);
  /** Latest reload for stable callbacks (onDelete must not re-create per render). */
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    void reload(filter);
  }, [filter, reload, reloadToken]);

  // Queue status UI (R8/R11): a real consumer of outboxStatus — pending /
  // failed / parked / unbound counts, local storage errors, and the explicit
  // claim affordance for unbound events. Re-read on every flush cycle.
  const [queue, setQueue] = useState<{
    pending: number;
    failed: number;
    rejected: number;
    parked: number;
    unbound: number;
    localError?: string;
    unconfigured: boolean;
  } | null>(null);
  // Claim affordance state (C2 page gate): in-flight guard + the REAL claim
  // outcome. `uploaded` counts ONLY this claim's committed owner-scoped
  // handles found in the follow-up flush's uploaded entries — never a global
  // flush total (claim结果消费补审).
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimOutcome, setClaimOutcome] = useState<{
    confirmed: boolean;
    storageError: boolean;
    claimed: number;
    conflicts: number;
    uploaded: number;
    /** Some of this claim's records stayed queued (e.g. identity switched). */
    unsynced: boolean;
  } | null>(null);
  const refreshQueue = useCallback(async () => {
    try {
      const { outboxStatus } = await import('@/lib/mistake-book/outbox');
      setQueue(await outboxStatus());
    } catch {
      setQueue(null);
    }
  }, []);
  useEffect(() => {
    void refreshQueue();
    const onChanged = () => void refreshQueue();
    window.addEventListener('openmaic:mistakes-changed', onChanged);
    return () => window.removeEventListener('openmaic:mistakes-changed', onChanged);
  }, [refreshQueue, reloadToken]);

  // Outbox lifecycle wiring (R8): retry queued captures when this page opens
  // and whenever the browser reports connectivity restored. The flush is
  // self-guarding (identity re-confirmed, parked events untouched); a
  // committed upload re-reads the list so the UI matches the server.
  useEffect(() => {
    let cancelled = false;
    const flushAndSync = async () => {
      if (cancelled) return;
      try {
        const { flushOutbox } = await import('@/lib/mistake-book/outbox');
        const report = await flushOutbox();
        if (report.uploaded.length > 0) {
          // See app/page.tsx: a cancelled caller's pass may be the uploader;
          // the durable event reaches the LIVE listeners either way.
          window.dispatchEvent(new CustomEvent('openmaic:mistakes-changed'));
          if (!cancelled) void reload(filterRef.current);
        }
        if (!cancelled) void refreshQueue();
      } catch {
        /* offline flushes retry on the next trigger */
      }
    };
    void flushAndSync();
    window.addEventListener('online', flushAndSync);
    return () => {
      cancelled = true;
      window.removeEventListener('online', flushAndSync);
    };
  }, [reload, refreshQueue]);

  const filtered = useMemo(
    () =>
      mistakes.filter((record) => {
        // Same normalization as grouping: an invalid/empty legacy code reads
        // as unclassified here too — the two views cannot disagree.
        const subject = normalizeCourseSubject(record.subject ?? '') ?? 'unclassified';
        const grade = normalizeGradeSemester(record.gradeSemester ?? '') ?? 'unclassified';
        return (
          (subjectFilter === 'all' || subject === subjectFilter) &&
          (gradeFilter === 'all' || grade === gradeFilter)
        );
      }),
    [mistakes, subjectFilter, gradeFilter],
  );

  const tree = useMemo(() => groupMistakesByCurriculum(filtered), [filtered]);

  const onMastered = useCallback(
    async (record: MistakeRecordView, mastered: boolean): Promise<boolean> => {
      let ok = false;
      try {
        ok = await setMistakeMastered(record, mastered);
      } catch (error) {
        log.warn('Mistake mastery save failed:', error);
      }
      if (!ok) setMutationError('mastered');
      if (ok) {
        setMutationError(null);
        const nowMastered = mastered ? new Date().toISOString() : null;
        const matches = (item: MistakeRecordView) =>
          item.stageId === record.stageId &&
          item.sceneId === record.sceneId &&
          item.questionId === record.questionId;
        // Exact merge by the CURRENT selection and the NEW mastered value
        // (C review): what the user is LOOKING at decides the outcome —
        //   mastered=true  + mastered-view  → the card belongs here NOW
        //   mastered=true  + unmastered-view → the card leaves this view
        //   unmaster=false + unmastered-view → the card belongs here NOW
        //   unmaster=false + mastered-view   → the card leaves this view
        // 'all' always keeps the card, with its state updated in place. When
        // the card should appear but the list does not carry it (switched
        // filters mid-PATCH), a canonical re-read fetches it.
        const current = filterRef.current;
        setMistakes((prev) => {
          const present = prev.some(matches);
          if (current === 'all') {
            return present
              ? prev.map((item) => (matches(item) ? { ...item, masteredAt: nowMastered } : item))
              : prev;
          }
          const belongsHere = current === 'mastered' ? mastered : !mastered;
          if (belongsHere) {
            if (present) return prev; // already listed
            // Insert the canonical state; a full reload follows anyway.
            return [...prev, { ...record, masteredAt: nowMastered }];
          }
          return prev.filter((item) => !matches(item));
        });
        // EVERY successful mutation invalidates in-flight reads (C2 early
        // review): reload bumps requestGeneration and aborts the older GET,
        // so a stale list (old mastery/old membership) can never land after
        // the mutation committed — in ANY view, 'all' included.
        void reload(filterRef.current);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('openmaic:mistakes-changed'));
        }
      }
      return ok;
    },
    [reload],
  );

  const onDelete = useCallback(async (record: MistakeRecordView) => {
    setMutationError(null);
    let ok = false;
    try {
      ok = await deleteMistakeRecord({
        kind: 'one',
        stageId: record.stageId,
        sceneId: record.sceneId,
        questionId: record.questionId,
      });
    } catch (error) {
      // fetch() THROWS on network abort — that is a failure too, never an
      // unhandled rejection (delivery review #5).
      log.warn('Mistake delete failed:', error);
    }
    if (ok) {
      // Key-based removal: a background GET may have replaced the record
      // object; identity (`!==`) would leave the deleted row on screen.
      const matches = (item: MistakeRecordView) =>
        item.stageId === record.stageId &&
        item.sceneId === record.sceneId &&
        item.questionId === record.questionId;
      setMistakes((prev) => prev.filter((item) => !matches(item)));
      // Same generation discipline as mastery: a canonical re-read supersedes
      // any in-flight older GET that still carries the deleted record.
      void reloadRef.current(filterRef.current);
      window.dispatchEvent(new CustomEvent('openmaic:mistakes-changed'));
    } else {
      setMutationError('delete'); // honest failure, the card stays retryable
    }
  }, []);

  const onClearStage = useCallback(
    async (stageId: string) => {
      if (!window.confirm(t('mistakeBook.clearStageConfirm'))) return;
      setMutationError(null);
      let ok = false;
      try {
        ok = await deleteMistakeRecord({ kind: 'stage', stageId });
      } catch (error) {
        log.warn('Mistake clear failed:', error);
      }
      if (ok) {
        setReloadToken((token) => token + 1);
        window.dispatchEvent(new CustomEvent('openmaic:mistakes-changed'));
      } else {
        setMutationError('clear');
      }
    },
    [t],
  );

  const onClassify = useCallback(
    async (
      stageId: string,
      current: { subject: string | null; gradeSemester: string | null },
      next: { subject: string; gradeSemester: string },
    ): Promise<boolean> => {
      // Tri-state per field, diffed against the CURRENT values: picking the
      // same code as now is an omission (keep); picking 未分类 clears only
      // when a value exists; a different code sets it.
      const field = (pick: string, now: string | null): { v?: string | null } => {
        if (pick === 'unclassified') return now === null ? {} : { v: null };
        return pick === now ? {} : { v: pick };
      };
      const subjectPatch = field(next.subject, current.subject);
      const gradePatch = field(next.gradeSemester, current.gradeSemester);
      if (!('v' in subjectPatch) && !('v' in gradePatch)) return true; // no-op

      const ok = await classifyStage(stageId, {
        ...('v' in subjectPatch ? { subject: subjectPatch.v } : {}),
        ...('v' in gradePatch ? { gradeSemester: gradePatch.v } : {}),
      });
      if (ok) setReloadToken((token) => token + 1);
      return ok;
    },
    [],
  );

  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'unmastered', label: t('mistakeBook.filterUnmastered') },
    { id: 'mastered', label: t('mistakeBook.filterMastered') },
    { id: 'all', label: t('mistakeBook.filterAll') },
  ];

  const groupLabel = (code: string): string =>
    code === 'unclassified' ? t('mistakeBook.unclassified') : t(subjectLabelKey(code));
  const gradeLabel = (code: string): string =>
    code === 'unclassified' ? t('mistakeBook.unclassified') : t(gradeSemesterLabelKey(code));

  // The card tree, extracted so the background-error branch can keep it
  // mounted under a staleness banner instead of unmounting it.
  const treeContent = (
    <div className="space-y-6">
      {tree.map((subjectNode) => (
        <section key={subjectNode.key}>
          <h2 className="text-sm font-bold text-gray-800 dark:text-gray-100 mb-3 flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-md bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
              {groupLabel(subjectNode.subject)}
            </span>
            <span className="text-xs font-normal text-gray-400">
              {subjectNode.grades.reduce(
                (sum, grade) =>
                  sum + grade.stages.reduce((s, stage) => s + stage.records.length, 0),
                0,
              )}
            </span>
          </h2>
          <div className="space-y-5">
            {subjectNode.grades.map((gradeNode) => (
              <div key={gradeNode.key}>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2 pl-1">
                  {gradeLabel(gradeNode.grade)}
                </h3>
                <div className="space-y-3">
                  {gradeNode.stages.map((stageNode) => (
                    <div key={stageNode.key}>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <span className="text-xs font-medium text-gray-600 dark:text-gray-300 truncate">
                          {stageNode.stageName}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {stageNode.records.length}
                        </span>
                        <div className="flex-1" />
                        <ClassifyControl
                          stageId={stageNode.stageId}
                          subject={stageNode.records[0]?.subject ?? null}
                          gradeSemester={stageNode.records[0]?.gradeSemester ?? null}
                          onClassify={onClassify}
                        />
                        <button
                          onClick={() => onClearStage(stageNode.stageId)}
                          className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                          {t('mistakeBook.clearStage')}
                        </button>
                      </div>
                      {stageNode.records.map((record) => (
                        <MistakeCard
                          key={`${record.stageId}:${record.sceneId}:${record.questionId}`}
                          record={record}
                          onMastered={onMastered}
                          onDelete={onDelete}
                          onRetryWrong={async (payload) => {
                            const ok = await reportRetryWrong(payload);
                            if (ok) {
                              // POST committed; the refresh outcome is a
                              // SEPARATE fact. A failed re-read shows the
                              // "saved, refresh failed" notice with a
                              // re-read (never a resend of the committed
                              // event). filterRef: refresh what is
                              // selected NOW even if the user switched
                              // filters while the POST was in flight.
                              const refreshed = await reload(filterRef.current);
                              if (!refreshed) setRefreshFailed(true);
                            }
                            return ok;
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => router.push('/')}
            className="p-2 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label={t('generation.backToHome')}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <BookX className="w-5 h-5 text-violet-500" />
            {t('mistakeBook.title')}
          </h1>
          <div className="flex-1" />
          <div className="flex items-center gap-1 bg-white/70 dark:bg-gray-800/70 rounded-full p-1">
            {filters.map((item) => (
              <button
                key={item.id}
                onClick={() => setFilter(item.id)}
                className={cn(
                  'px-3 py-1 text-xs rounded-full transition-colors',
                  filter === item.id
                    ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-medium'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Curriculum filters */}
        <div className="flex items-center gap-2 mb-6">
          <select
            value={subjectFilter}
            onChange={(event) => setSubjectFilter(event.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/70 text-gray-600 dark:text-gray-300"
            aria-label={t('mistakeBook.subjectFilter')}
          >
            <option value="all">
              {t('mistakeBook.subjectFilter')}: {t('mistakeBook.filterAll')}
            </option>
            {COURSE_SUBJECTS.map((code) => (
              <option key={code} value={code}>
                {t(subjectLabelKey(code))}
              </option>
            ))}
            <option value="unclassified">{t('mistakeBook.unclassified')}</option>
          </select>
          <select
            value={gradeFilter}
            onChange={(event) => setGradeFilter(event.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/70 text-gray-600 dark:text-gray-300"
            aria-label={t('mistakeBook.gradeFilter')}
          >
            <option value="all">
              {t('mistakeBook.gradeFilter')}: {t('mistakeBook.filterAll')}
            </option>
            {GRADE_SEMESTERS.map((code) => (
              <option key={code} value={code}>
                {t(gradeSemesterLabelKey(code))}
              </option>
            ))}
            <option value="unclassified">{t('mistakeBook.unclassified')}</option>
          </select>
          <span className="text-xs text-gray-400">{filtered.length}</span>
        </div>

        {mutationError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-xs text-red-600 dark:text-red-300">
            {t(`mistakeBook.mutationFailed_${mutationError}`)}
          </div>
        )}
        {queue &&
          (queue.pending > 0 ||
            queue.failed > 0 ||
            queue.rejected > 0 ||
            queue.parked > 0 ||
            queue.unbound > 0 ||
            queue.localError) && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 px-4 py-2 text-xs text-amber-700 dark:text-amber-300 space-y-1">
              {queue.localError && (
                <p>
                  {t('mistakeBook.queueLocalError')}: {queue.localError}
                </p>
              )}
              {(queue.pending > 0 ||
                queue.failed > 0 ||
                queue.parked > 0 ||
                queue.rejected > 0) && (
                <p>
                  {t('mistakeBook.queuePending', {
                    pending: queue.pending + queue.failed,
                    parked: queue.parked,
                    rejected: queue.rejected,
                  })}
                </p>
              )}
              {queue.unbound > 0 && (
                <div className="flex items-center gap-2">
                  <span>{t('mistakeBook.queueUnbound', { n: queue.unbound })}</span>
                  <button
                    onClick={async () => {
                      setClaimBusy(true);
                      try {
                        const { claimUnboundEvents, flushOutbox } =
                          await import('@/lib/mistake-book/outbox');
                        const { strictInstanceMatches } =
                          await import('@/lib/mistake-book/plan-executor');
                        // Claim, then IMMEDIATELY and safely flush what was
                        // just bound (C2 page gate). The synced count is the
                        // strict full-identity INTERSECTION of this claim's
                        // committed mappings (key + fingerprint + token-or-
                        // date) with the flush's uploaded entries — a global
                        // upload total, or an independently-uploaded old
                        // event at the same key, can never stand in for
                        // what THIS claim synced (P3-r1 §7).
                        const claim = await claimUnboundEvents();
                        const flush = claim.identityConfirmed ? await flushOutbox() : null;
                        const destinations = claim.committedMappings.map((m) => m.destination);
                        const uploaded = flush
                          ? flush.uploaded.filter((entry) =>
                              destinations.some((destination) =>
                                strictInstanceMatches(entry, {
                                  handle: destination.key,
                                  fingerprint: destination.fingerprint,
                                  ...(destination.recordToken != null
                                    ? { recordToken: destination.recordToken }
                                    : { recordCreatedAt: destination.createdAt }),
                                }),
                              ),
                            ).length
                          : 0;
                        setClaimOutcome({
                          confirmed: claim.identityConfirmed,
                          storageError: claim.storageError,
                          claimed: claim.claimed.length,
                          conflicts: claim.conflicts.length,
                          uploaded,
                          unsynced: claim.claimed.length > uploaded,
                        });
                        if (claim.claimed.length > 0 || (flush && flush.uploaded.length > 0)) {
                          void reload(filterRef.current);
                        }
                        void refreshQueue();
                      } catch {
                        // Unexpected module/flush failure: honest error, the
                        // events stay claimable — never an unhandled rejection
                        // and never a fabricated success.
                        setClaimOutcome({
                          confirmed: true,
                          storageError: true,
                          claimed: 0,
                          conflicts: 0,
                          uploaded: 0,
                          unsynced: false,
                        });
                      } finally {
                        setClaimBusy(false);
                      }
                    }}
                    disabled={claimBusy}
                    className="underline underline-offset-2 font-medium disabled:opacity-50"
                  >
                    {t('mistakeBook.queueClaim')}
                  </button>
                </div>
              )}
            </div>
          )}
        {/* Claim outcomes live OUTSIDE the queue banner (claim结果消费补审):
            a successful claim EMPTIES the banner — its verdict must survive. */}
        {claimOutcome &&
          claimOutcome.confirmed &&
          !claimOutcome.storageError &&
          (claimOutcome.claimed > 0 || claimOutcome.uploaded > 0) && (
            <p data-testid="claim-outcome" className="mb-4 text-xs text-gray-500">
              {t('mistakeBook.claimDone', {
                claimed: claimOutcome.claimed,
                uploaded: claimOutcome.uploaded,
              })}
            </p>
          )}
        {claimOutcome &&
          claimOutcome.confirmed &&
          !claimOutcome.storageError &&
          claimOutcome.conflicts > 0 && (
            <p data-testid="claim-conflicts" className="mb-4 text-xs text-gray-500">
              {t('mistakeBook.claimConflicts', { n: claimOutcome.conflicts })}
            </p>
          )}
        {claimOutcome && !claimOutcome.confirmed && (
          <p data-testid="claim-outcome" className="mb-4 text-xs text-gray-500">
            {t('mistakeBook.claimUnconfirmed')}
          </p>
        )}
        {claimOutcome && claimOutcome.confirmed && claimOutcome.storageError && (
          <p data-testid="claim-outcome" className="mb-4 text-xs text-gray-500">
            {t('mistakeBook.claimStorageError')}
          </p>
        )}
        {claimOutcome?.unsynced && (
          <p data-testid="claim-unsynced" className="mb-4 text-xs text-gray-500">
            {t('mistakeBook.claimUnsynced', {
              claimed: claimOutcome.claimed,
              pending: claimOutcome.claimed - claimOutcome.uploaded,
            })}
          </p>
        )}
        {refreshFailed && !loading && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            <span>{t('mistakeBook.savedRefreshFailed')}</span>
            <button
              onClick={() => {
                setRefreshFailed(false);
                void reload(filter);
              }}
              className="underline underline-offset-2"
            >
              {t('mistakeBook.refreshNow')}
            </button>
          </div>
        )}
        {loadError && !loading && mistakes.length > 0 && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
            <span>
              {t('mistakeBook.staleList', {
                filter: t(
                  `mistakeBook.filter${shownFilterRef.current === 'all' ? 'All' : shownFilterRef.current === 'mastered' ? 'Mastered' : 'Unmastered'}`,
                ),
              })}
            </span>
            <button
              onClick={() => setReloadToken((token) => token + 1)}
              className="underline underline-offset-2"
            >
              {t('mistakeBook.retryLoad')}
            </button>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : loadError && mistakes.length === 0 ? (
          <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-10 text-center">
            <p className="text-sm text-red-600 dark:text-red-300">{t('mistakeBook.loadFailed')}</p>
            <button
              onClick={() => setReloadToken((token) => token + 1)}
              className="mt-3 px-4 py-1.5 rounded-full bg-red-500 text-white text-xs hover:bg-red-600 transition-colors"
            >
              {t('mistakeBook.retryLoad')}
            </button>
          </div>
        ) : loadError ? (
          // Background re-read failed: the banner above already says so; this
          // branch keeps the card tree mounted in the SAME position as the
          // normal branch so component state (picked inputs, retry
          // controllers, dialogs) survives the failed re-read.
          treeContent
        ) : !configured ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 px-4 py-6 text-sm text-amber-700 dark:text-amber-300 text-center">
            {t('mistakeBook.notConfigured')}
          </div>
        ) : tree.length === 0 ? (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/60 px-4 py-16 text-center text-sm text-gray-400">
            {t(filter === 'unmastered' ? 'mistakeBook.emptyUnmastered' : 'mistakeBook.empty')}
          </div>
        ) : (
          treeContent
        )}
      </div>
    </div>
  );
}

interface ClassifyControlProps {
  stageId: string;
  subject: string | null;
  gradeSemester: string | null;
  onClassify: (
    stageId: string,
    current: { subject: string | null; gradeSemester: string | null },
    next: { subject: string; gradeSemester: string },
  ) => Promise<boolean>;
}

function ClassifyControl({ stageId, subject, gradeSemester, onClassify }: ClassifyControlProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pickSubject, setPickSubject] = useState(subject ?? 'unclassified');
  const [pickGrade, setPickGrade] = useState(gradeSemester ?? 'unclassified');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((prev) => {
            const next = !prev;
            if (next) {
              // Re-seed the pickers from the current values on every open.
              setPickSubject(subject ?? 'unclassified');
              setPickGrade(gradeSemester ?? 'unclassified');
              setError(false);
            }
            return next;
          });
        }}
        className="text-xs text-gray-400 hover:text-violet-500 transition-colors"
      >
        {t('mistakeBook.classify')}
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-30 w-56 rounded-xl border border-border bg-popover shadow-lg p-3 space-y-2 text-xs">
          <div>
            <p className="text-gray-400 mb-1">{t('mistakeBook.subjectFilter')}</p>
            <select
              value={pickSubject}
              onChange={(event) => {
                setPickSubject(event.target.value);
                setError(false);
              }}
              className="w-full px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-transparent"
            >
              {COURSE_SUBJECTS.map((code) => (
                <option key={code} value={code}>
                  {t(subjectLabelKey(code))}
                </option>
              ))}
              <option value="unclassified">{t('mistakeBook.unclassified')}</option>
            </select>
          </div>
          <div>
            <p className="text-gray-400 mb-1">{t('mistakeBook.gradeFilter')}</p>
            <select
              value={pickGrade}
              onChange={(event) => {
                setPickGrade(event.target.value);
                setError(false);
              }}
              className="w-full px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-transparent"
            >
              {GRADE_SEMESTERS.map((code) => (
                <option key={code} value={code}>
                  {t(gradeSemesterLabelKey(code))}
                </option>
              ))}
              <option value="unclassified">{t('mistakeBook.unclassified')}</option>
            </select>
          </div>
          {error && <p className="text-red-500 text-[11px]">{t('mistakeBook.classifyFailed')}</p>}
          <button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                // On failure the dialog STAYS OPEN with the picks intact so
                // the choice can be retried; closing means it committed.
                const ok = await onClassify(
                  stageId,
                  { subject, gradeSemester },
                  { subject: pickSubject, gradeSemester: pickGrade },
                );
                if (ok) setOpen(false);
                else setError(true);
              } finally {
                setSaving(false);
              }
            }}
            className="w-full py-1.5 rounded-full bg-violet-500 text-white disabled:opacity-40 hover:bg-violet-600 transition-colors"
          >
            {saving ? '…' : t('mistakeBook.classifySave')}
          </button>
        </div>
      )}
    </div>
  );
}

interface MistakeCardProps {
  record: MistakeRecordView;
  onMastered: (record: MistakeRecordView, mastered: boolean) => Promise<boolean>;
  onDelete: (record: MistakeRecordView) => Promise<void>;
  onRetryWrong: (payload: MistakeRetryPayload, eventId: string) => Promise<boolean>;
}

function MistakeCard({ record, onMastered, onDelete, onRetryWrong }: MistakeCardProps) {
  const { t } = useI18n();
  const [retry, setRetry] = useState<RetryState>({ kind: 'idle' });
  const [picked, setPicked] = useState<string[]>([]);
  const [showAnalysis, setShowAnalysis] = useState(false);
  // Same-point practice is the primary redo mode (a fresh question testing
  // the same knowledge point); redoing the original stays one click away.
  const [practiceMode, setPracticeMode] = useState<'similar' | 'original'>('similar');
  // The wrong-retry submission flow (stable event id, in-flight guard,
  // failure retention) lives in the tested controller; this component is its
  // driver. The controller is created once but always invokes the LATEST
  // onRetryWrong via the ref below — later re-renders (filter changes, record
  // refreshes) must not leave it holding a stale closure.
  const onRetryWrongRef = useRef(onRetryWrong);
  onRetryWrongRef.current = onRetryWrong;
  const recordRef = useRef(record);
  recordRef.current = record;
  const retryCtrlRef = useRef<RetryUploadController | null>(null);
  retryCtrlRef.current ??= createRetryUploadController({
    onWrong: (payload, eventId) => onRetryWrongRef.current(payload as MistakeRetryPayload, eventId),
    mintEventId: () =>
      encodeEventId([
        'retry',
        record.stageId,
        record.sceneId,
        record.questionId,
        Date.now().toString(36),
        Math.random().toString(36).slice(2, 8),
      ]),
    // The payload builder runs ONLY when a NEW event is minted; the record
    // it captures is frozen into that event, so retries replay it verbatim
    // even if the list refreshes a newer record in between.
    buildPayload: (picked, eventId) => buildRetryPayload(recordRef.current, picked, eventId),
  });
  const masteredInFlightRef = useRef(false);

  const isChoice = record.questionType === 'single' || record.questionType === 'multiple';
  const options = optionList(record.options);
  const mastered = record.masteredAt !== null;
  const correctValues = resolveChoiceKey(
    options,
    Array.isArray(record.correctAnswer)
      ? record.correctAnswer
      : typeof record.correctAnswer === 'string'
        ? [record.correctAnswer]
        : [],
    record.questionType === 'multiple' ? 'multiple' : 'single',
  );

  // A failed upload keeps the answered state open for the retry-upload
  // button; everything else answered locks picking.
  const failedUpload = retry.kind === 'answered' && !retry.correct && retry.uploaded === 'failed';

  const pick = (value: string) => {
    if (retry.kind === 'answered' || failedUpload) return;
    if (record.questionType === 'multiple') {
      setPicked((prev) =>
        prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
      );
    } else {
      setPicked([value]);
    }
  };

  const submitChoice = async () => {
    if (picked.length === 0) return;
    if (retry.kind === 'answered' && !failedUpload) return;
    if (masteredInFlightRef.current) return;
    const outcome = gradeRetry(record, picked);
    if (outcome === 'ungraded') {
      // The snapshot's answer key cannot be verified: no verdict, no upload,
      // nothing lost — the data stays for manual review.
      setRetry({ kind: 'ungraded' });
      return;
    }
    if (outcome === 'correct') {
      masteredInFlightRef.current = true;
      try {
        const saved = await onMastered(record, true);
        // Mastery save failure must not read as success: silently keep the
        // picks so the learner can press again.
        if (saved) setRetry({ kind: 'answered', correct: true, uploaded: 'ok' });
      } finally {
        masteredInFlightRef.current = false;
      }
      return;
    }
    // Wrong retry: ship THIS attempt's answer under the stable event id.
    // Re-entry with failedUpload re-sends the SAME submission (controller
    // keeps the id); 'busy' swallows double-clicks without a second request.
    setRetry({ kind: 'answered', correct: false, uploaded: 'pending' });
    const uploaded = await retryCtrlRef.current!.submitWrong(picked);
    if (uploaded === 'busy') return; // the in-flight submission owns the UI
    setRetry({ kind: 'answered', correct: false, uploaded: uploaded === 'ok' ? 'ok' : 'failed' });
  };

  return (
    <div
      className={cn(
        'rounded-xl border bg-white/80 dark:bg-gray-900/70 px-4 py-4 transition-colors',
        mastered
          ? 'border-emerald-200 dark:border-emerald-900/50'
          : 'border-gray-200 dark:border-gray-800',
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'shrink-0 mt-0.5 text-[10px] px-1.5 py-0.5 rounded font-medium',
            record.questionType === 'short_answer'
              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300'
              : 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300',
          )}
        >
          {t(`mistakeBook.type_${record.questionType}`)}
        </span>
        <p className="flex-1 text-sm font-medium leading-relaxed">
          <MathText text={record.question} allowDisplayMode />
        </p>
        <div className="flex items-center gap-1 shrink-0">
          {mastered && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-300 font-medium">
              {t('mistakeBook.masteredBadge')}
            </span>
          )}
          <button
            onClick={() => onDelete(record)}
            className="p-1.5 rounded-full text-gray-300 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label={t('mistakeBook.deleteOne')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {record.sceneTitle && (
        <p className="mt-1 text-xs text-gray-400">
          {record.sceneTitle}
          <span className="mx-1">·</span>
          {t('mistakeBook.wrongCount', { n: record.wrongCount })}
          <span className="mx-1">·</span>
          {new Date(record.lastWrongAt).toLocaleString()}
        </p>
      )}

      {/* Last attempt: my answer vs correct answer */}
      <div className="mt-3 space-y-1 text-xs">
        <p className="text-red-500 dark:text-red-400">
          {t('mistakeBook.myAnswer')}：{answerText(record.lastUserAnswer)}
        </p>
        {Array.isArray(record.correctAnswer) && (
          <p className="text-emerald-600 dark:text-emerald-400">
            {t('mistakeBook.correctAnswer')}：{record.correctAnswer.map(String).join('、')}
          </p>
        )}
      </div>

      {/* Retry zone */}
      <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
        <div className="mb-2.5 flex items-center gap-1 rounded-full bg-gray-100/80 dark:bg-gray-800/70 p-0.5 w-fit">
          <button
            onClick={() => setPracticeMode('similar')}
            className={cn(
              'px-2.5 py-1 text-xs rounded-full transition-colors',
              practiceMode === 'similar'
                ? 'bg-white dark:bg-gray-900 text-violet-600 dark:text-violet-300 font-medium shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
            )}
          >
            {t('mistakeBook.practiceTabSimilar')}
          </button>
          <button
            onClick={() => setPracticeMode('original')}
            className={cn(
              'px-2.5 py-1 text-xs rounded-full transition-colors',
              practiceMode === 'original'
                ? 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 font-medium shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
            )}
          >
            {t('mistakeBook.practiceTabOriginal')}
          </button>
        </div>
        {practiceMode === 'similar' && (
          <SimilarPractice record={record} onMastered={onMastered} onSimilarWrong={onRetryWrong} />
        )}
        {practiceMode === 'original' && isChoice && options.length > 0 ? (
          <>
            <div className="space-y-1.5">
              {options.map((option) => {
                const selected = picked.includes(option.value);
                const answered = retry.kind === 'answered';
                // Same fail-closed resolver as grading: an unverifiable key
                // highlights nothing.
                const isCorrectOption =
                  correctValues !== null && correctValues.includes(option.value);
                return (
                  <button
                    key={option.value}
                    onClick={() => pick(option.value)}
                    disabled={answered}
                    className={cn(
                      'w-full text-left text-xs px-3 py-2 rounded-lg border transition-colors',
                      answered && isCorrectOption
                        ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                        : answered && selected
                          ? 'border-red-300 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300'
                          : selected
                            ? 'border-violet-300 bg-violet-50 dark:bg-violet-900/30'
                            : 'border-gray-200 dark:border-gray-800 hover:border-violet-200 dark:hover:border-violet-800',
                    )}
                  >
                    <span className="font-medium mr-1.5">{option.value}.</span>
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 mt-2">
              {retry.kind === 'idle' && (
                <button
                  onClick={submitChoice}
                  disabled={picked.length === 0}
                  className="text-xs px-3 py-1.5 rounded-full bg-violet-500 text-white disabled:opacity-40 hover:bg-violet-600 transition-colors"
                >
                  {t('mistakeBook.submitRetry')}
                </button>
              )}
              {retry.kind === 'answered' && (
                <span
                  className={cn(
                    'flex items-center gap-1 text-xs font-medium',
                    retry.correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
                  )}
                >
                  {retry.correct ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {t('mistakeBook.retryCorrect')}
                    </>
                  ) : retry.uploaded === 'ok' ? (
                    // The count-increased claim is gated on the typed commit:
                    // pending says saving, a failed POST says save failed —
                    // neither may claim an increment that has not happened.
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      {t('mistakeBook.retryWrong')}
                    </>
                  ) : retry.uploaded === 'pending' ? (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      {t('mistakeBook.retrySaving')}
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      {t('mistakeBook.retrySaveFailed')}
                    </>
                  )}
                </span>
              )}
              {retry.kind === 'answered' && !retry.correct && retry.uploaded === 'failed' && (
                <>
                  <span className="text-xs text-amber-500">{t('mistakeBook.uploadFailed')}</span>
                  <button
                    onClick={submitChoice}
                    disabled={picked.length === 0}
                    className="text-xs px-2 py-1 rounded-full border border-amber-300 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-40 transition-colors"
                  >
                    {t('mistakeBook.retryUpload')}
                  </button>
                </>
              )}
              {retry.kind === 'ungraded' && (
                <span className="flex items-center gap-1 text-xs font-medium text-amber-500">
                  <XCircle className="w-3.5 h-3.5" />
                  {t('mistakeBook.retryUndetermined')}
                </span>
              )}
              {retry.kind === 'answered' && !retry.correct && retry.uploaded === 'ok' && (
                <button
                  onClick={() => {
                    setRetry({ kind: 'idle' });
                    setPicked([]);
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  {t('mistakeBook.retryAgain')}
                </button>
              )}
            </div>
          </>
        ) : practiceMode === 'original' ? (
          /* Short answer: reveal the reference answer, self-assess. */
          <div className="space-y-2">
            {retry.kind !== 'revealed' ? (
              <button
                onClick={() => setRetry({ kind: 'revealed' })}
                className="text-xs px-3 py-1.5 rounded-full bg-violet-500 text-white hover:bg-violet-600 transition-colors"
              >
                {t('mistakeBook.showReference')}
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap">
                  <MathText
                    text={record.analysis ?? answerText(record.correctAnswer)}
                    allowDisplayMode
                  />
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onMastered(record, true)}
                    className="text-xs px-3 py-1.5 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
                  >
                    {t('mistakeBook.selfMarkMastered')}
                  </button>
                  <button
                    onClick={() => setRetry({ kind: 'idle' })}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    {t('mistakeBook.closeReference')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Analysis (always available for choice questions too) */}
      {record.analysis && isChoice && (
        <div className="mt-2">
          <button
            onClick={() => setShowAnalysis((prev) => !prev)}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 flex items-center gap-1"
          >
            <ChevronDown
              className={cn('w-3 h-3 transition-transform', showAnalysis && 'rotate-180')}
            />
            {t('mistakeBook.showAnalysis')}
          </button>
          {showAnalysis && (
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap">
              <MathText text={record.analysis} allowDisplayMode />
            </p>
          )}
        </div>
      )}

      {/* Mastered toggle */}
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => onMastered(record, !mastered)}
          className="text-xs text-gray-400 hover:text-violet-500 transition-colors"
        >
          {mastered ? t('mistakeBook.unmaster') : t('mistakeBook.markMastered')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Same-point practice: one FRESH question for the same knowledge point.
// ---------------------------------------------------------------------------

type PracticePhase = 'idle' | 'generating' | 'active' | 'failed';
type PracticeVerdict =
  | { kind: 'idle' }
  | { kind: 'grading' }
  | { kind: 'answered'; correct: boolean; uploaded: 'ok' | 'failed' | 'pending' }
  | { kind: 'ungraded'; aiComment?: string };

interface SimilarPracticeProps {
  record: MistakeRecordView;
  onMastered: (record: MistakeRecordView, mastered: boolean) => Promise<boolean>;
  /**
   * A wrong practice attempt reuses the retry pipeline: the ORIGINAL question
   * snapshot ships under a fresh 'similar'-prefixed event id, so wrong_count
   * grows on the record of that knowledge point without overwriting it with
   * the ephemeral practice question.
   */
  onSimilarWrong: (payload: MistakeRetryPayload, eventId: string) => Promise<boolean>;
}

/**
 * Same-point practice block. Exported for component tests.
 *
 * Semantics (user-confirmed): a CORRECT answer on the fresh question marks
 * the record mastered — a new stem answered right proves the point better
 * than the original, whose answer the learner may have memorized. A WRONG
 * answer re-uses the retry upload pipeline under a 'similar' event id, so
 * wrong_count grows on the knowledge point's record while the stored
 * snapshot stays the ORIGINAL question (the practice question is ephemeral
 * and never persisted as a record).
 */
export function SimilarPractice({ record, onMastered, onSimilarWrong }: SimilarPracticeProps) {
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<PracticePhase>('idle');
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [textAnswer, setTextAnswer] = useState('');
  const [verdict, setVerdict] = useState<PracticeVerdict>({ kind: 'idle' });
  const [showReference, setShowReference] = useState(false);
  const [aiComment, setAiComment] = useState<string | null>(null);
  const masteredInFlightRef = useRef(false);

  const onWrongRef = useRef(onSimilarWrong);
  onWrongRef.current = onSimilarWrong;
  const recordRef = useRef(record);
  recordRef.current = record;
  const wrongCtrlRef = useRef<RetryUploadController | null>(null);
  wrongCtrlRef.current ??= createRetryUploadController({
    onWrong: (payload, eventId) => onWrongRef.current(payload as MistakeRetryPayload, eventId),
    mintEventId: () =>
      encodeEventId([
        'similar',
        record.stageId,
        record.sceneId,
        record.questionId,
        Date.now().toString(36),
        Math.random().toString(36).slice(2, 8),
      ]),
    // Freezes the ORIGINAL question snapshot with the practice attempt's
    // answer — same contract as an in-place retry, distinct event domain.
    buildPayload: (pickedAnswer, eventId) =>
      buildRetryPayload(recordRef.current, pickedAnswer, eventId),
  });

  const generate = async () => {
    if (phase === 'generating') return;
    setPhase('generating');
    setError(null);
    try {
      const config = getCurrentModelConfig();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-model': config.modelString || '',
        'x-api-key': config.apiKey || '',
        ...(config.baseUrl ? { 'x-base-url': config.baseUrl } : {}),
        ...(config.providerType ? { 'x-provider-type': config.providerType } : {}),
      };
      const response = await fetch('/api/generate/similar-question', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          questionType: record.questionType,
          question: record.question,
          ...(record.options !== null && record.options !== undefined
            ? { options: record.options }
            : {}),
          ...(record.correctAnswer !== null && record.correctAnswer !== undefined
            ? { correctAnswer: record.correctAnswer }
            : {}),
          ...(record.analysis ? { analysis: record.analysis } : {}),
          ...(record.knowledgePoint ? { knowledgePoint: record.knowledgePoint } : {}),
          language: locale,
        }),
      });
      const json = (await response.json().catch(() => null)) as {
        question?: QuizQuestion;
      } | null;
      const generated = json?.question;
      if (!response.ok || !generated || typeof generated.question !== 'string') {
        throw new Error(`HTTP ${response.status}`);
      }
      setQuestion(generated);
      setPicked([]);
      setTextAnswer('');
      setVerdict({ kind: 'idle' });
      setShowReference(false);
      setAiComment(null);
      setPhase('active');
    } catch (err) {
      log.warn('Similar question generation failed:', err);
      setError(t('mistakeBook.practiceGenerateFailed'));
      setPhase('failed');
    }
  };

  const submitWrong = async (answerForUpload: readonly string[]) => {
    setVerdict({ kind: 'answered', correct: false, uploaded: 'pending' });
    const uploaded = await wrongCtrlRef.current!.submitWrong(answerForUpload);
    if (uploaded === 'busy') return;
    setVerdict({ kind: 'answered', correct: false, uploaded: uploaded === 'ok' ? 'ok' : 'failed' });
  };

  const submitChoice = async () => {
    if (!question || picked.length === 0) return;
    if (verdict.kind === 'answered' && !verdict.correct && verdict.uploaded === 'failed') {
      // Failed-upload retry: the controller resends the frozen event.
      await submitWrong(picked);
      return;
    }
    if (verdict.kind !== 'idle' && verdict.kind !== 'ungraded') return;
    const key = resolveChoiceKey(
      question.options ?? [],
      question.answer ?? [],
      question.type === 'multiple' ? 'multiple' : 'single',
    );
    const outcome = gradeChoiceSubmission(key, picked);
    if (outcome === 'ungraded') {
      setVerdict({ kind: 'ungraded' });
      return;
    }
    if (outcome === 'correct') {
      // A correct answer on a FRESH question proves the point is mastered.
      masteredInFlightRef.current = true;
      try {
        const saved = await onMastered(recordRef.current, true);
        if (saved) setVerdict({ kind: 'answered', correct: true, uploaded: 'ok' });
      } finally {
        masteredInFlightRef.current = false;
      }
      return;
    }
    await submitWrong(picked);
  };

  const submitShortAnswer = async () => {
    if (!question || !textAnswer.trim() || verdict.kind === 'grading') return;
    setVerdict({ kind: 'grading' });
    const result = await gradeShortAnswerQuestion(question, textAnswer, locale);
    if (result.aiComment) setAiComment(result.aiComment);
    if (result.correct === null) {
      setVerdict({ kind: 'ungraded', aiComment: result.aiComment });
      return;
    }
    if (result.correct) {
      masteredInFlightRef.current = true;
      try {
        const saved = await onMastered(recordRef.current, true);
        if (saved) setVerdict({ kind: 'answered', correct: true, uploaded: 'ok' });
      } finally {
        masteredInFlightRef.current = false;
      }
      return;
    }
    await submitWrong([textAnswer]);
  };

  const knowledgePoint = question?.knowledgePoint ?? record.knowledgePoint ?? null;
  const isChoice = question?.type === 'single' || question?.type === 'multiple';
  const answered = verdict.kind === 'answered';
  const failedUpload =
    verdict.kind === 'answered' && !verdict.correct && verdict.uploaded === 'failed';
  const correctValues =
    question && isChoice
      ? resolveChoiceKey(
          question.options ?? [],
          question.answer ?? [],
          question.type === 'multiple' ? 'multiple' : 'single',
        )
      : null;

  return (
    <div className="space-y-2.5">
      {phase !== 'active' ? (
        <div className="flex flex-col gap-2">
          {record.knowledgePoint && phase !== 'generating' && (
            <p className="text-xs text-gray-400">
              {t('mistakeBook.practicePoint', { point: record.knowledgePoint })}
            </p>
          )}
          <button
            onClick={generate}
            disabled={phase === 'generating'}
            className="inline-flex w-fit items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 transition-colors"
          >
            {phase === 'generating' ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('mistakeBook.practiceGenerating')}
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                {t('mistakeBook.practiceGenerate')}
              </>
            )}
          </button>
          {phase === 'failed' && (
            <p className="text-xs text-amber-500">
              {error ?? t('mistakeBook.practiceGenerateFailed')}
            </p>
          )}
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            {t('mistakeBook.practiceHint')}
          </p>
        </div>
      ) : (
        question && (
          <div className="rounded-lg bg-violet-50/50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-900/30 px-3 py-2.5 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 font-medium shrink-0">
                {t(`mistakeBook.type_${question.type}`)}
              </span>
              {knowledgePoint && (
                <span className="text-[10px] text-gray-400 truncate">
                  {t('mistakeBook.practicePoint', { point: knowledgePoint })}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={generate}
                disabled={verdict.kind === 'grading'}
                className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-violet-500 transition-colors disabled:opacity-40"
                title={t('mistakeBook.practiceAnother')}
              >
                <RefreshCw className="w-3 h-3" />
                {t('mistakeBook.practiceAnother')}
              </button>
            </div>

            <p className="text-sm font-medium leading-relaxed">
              <MathText text={question.question} allowDisplayMode />
            </p>

            {isChoice && (
              <div className="space-y-1.5">
                {(question.options ?? []).map((option) => {
                  const selected = picked.includes(option.value);
                  const isCorrectOption =
                    correctValues !== null && correctValues.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      onClick={() => {
                        if (answered && !failedUpload) return;
                        if (verdict.kind === 'ungraded') return;
                        setPicked((prev) =>
                          question.type === 'multiple'
                            ? prev.includes(option.value)
                              ? prev.filter((v) => v !== option.value)
                              : [...prev, option.value]
                            : [option.value],
                        );
                      }}
                      className={cn(
                        'w-full text-left text-xs px-3 py-2 rounded-lg border transition-colors',
                        answered && isCorrectOption
                          ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                          : answered && selected
                            ? 'border-red-300 bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300'
                            : selected
                              ? 'border-violet-300 bg-white dark:bg-violet-900/20'
                              : 'border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-gray-900/40 hover:border-violet-200 dark:hover:border-violet-800',
                      )}
                    >
                      <span className="font-medium mr-1.5">{option.value}.</span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}

            {!isChoice && (
              <textarea
                value={textAnswer}
                onChange={(event) => setTextAnswer(event.target.value)}
                disabled={answered || verdict.kind === 'grading'}
                placeholder={t('mistakeBook.practiceShortAnswerPlaceholder')}
                rows={3}
                className="w-full text-xs px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-900/60 resize-none focus:outline-none focus:border-violet-300 dark:focus:border-violet-700 disabled:opacity-60"
              />
            )}

            {/* Verdict + actions */}
            <div className="flex flex-wrap items-center gap-2">
              {verdict.kind === 'idle' && isChoice && (
                <button
                  onClick={submitChoice}
                  disabled={picked.length === 0}
                  className="text-xs px-3 py-1.5 rounded-full bg-violet-500 text-white disabled:opacity-40 hover:bg-violet-600 transition-colors"
                >
                  {t('mistakeBook.practiceSubmit')}
                </button>
              )}
              {verdict.kind === 'idle' && !isChoice && (
                <button
                  onClick={submitShortAnswer}
                  disabled={!textAnswer.trim()}
                  className="text-xs px-3 py-1.5 rounded-full bg-violet-500 text-white disabled:opacity-40 hover:bg-violet-600 transition-colors"
                >
                  {t('mistakeBook.practiceSubmit')}
                </button>
              )}
              {verdict.kind === 'grading' && (
                <span className="flex items-center gap-1 text-xs text-gray-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('mistakeBook.practiceGrading')}
                </span>
              )}
              {verdict.kind === 'answered' && (
                <span
                  className={cn(
                    'flex items-center gap-1 text-xs font-medium',
                    verdict.correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
                  )}
                >
                  {verdict.correct ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {t('mistakeBook.practiceCorrect')}
                    </>
                  ) : verdict.uploaded === 'ok' ? (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      {t('mistakeBook.practiceWrong')}
                    </>
                  ) : verdict.uploaded === 'pending' ? (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      {t('mistakeBook.retrySaving')}
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      {t('mistakeBook.retrySaveFailed')}
                    </>
                  )}
                </span>
              )}
              {failedUpload && (
                <button
                  onClick={() => (isChoice ? submitChoice() : submitWrong([textAnswer]))}
                  className="text-xs px-2 py-1 rounded-full border border-amber-300 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-colors"
                >
                  {t('mistakeBook.retryUpload')}
                </button>
              )}
              {verdict.kind === 'ungraded' && (
                <span className="flex items-center gap-1 text-xs font-medium text-amber-500">
                  <XCircle className="w-3.5 h-3.5" />
                  {t('mistakeBook.retryUndetermined')}
                </span>
              )}
              {!isChoice && verdict.kind === 'ungraded' && (
                <button
                  onClick={submitShortAnswer}
                  className="text-xs text-gray-400 hover:text-violet-500 transition-colors"
                >
                  {t('mistakeBook.practiceRegrade')}
                </button>
              )}
              {answered && !verdict.correct && verdict.uploaded === 'ok' && (
                <button
                  onClick={generate}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  {t('mistakeBook.practiceAnother')}
                </button>
              )}
            </div>

            {/* AI comment + reference for short answers */}
            {aiComment && verdict.kind === 'answered' && (
              <p className="text-xs text-gray-500 dark:text-gray-400">{aiComment}</p>
            )}
            {!isChoice && (showReference || verdict.kind === 'ungraded') && (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap">
                  <MathText
                    text={question.analysis ?? t('mistakeBook.practiceNoReference')}
                    allowDisplayMode
                  />
                </p>
                {verdict.kind === 'ungraded' && (
                  <button
                    onClick={() => onMastered(recordRef.current, true)}
                    className="text-xs px-3 py-1.5 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
                  >
                    {t('mistakeBook.selfMarkMastered')}
                  </button>
                )}
              </div>
            )}
            {!isChoice && !showReference && verdict.kind === 'answered' && (
              <button
                onClick={() => setShowReference(true)}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                {t('mistakeBook.showReference')}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
