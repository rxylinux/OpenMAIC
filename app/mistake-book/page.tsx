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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BookX,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { MistakeRecordView } from '@/lib/persistence/mistake-book';
import {
  classifyStage,
  deleteMistakeRecord,
  fetchMistakes,
  reportRetryWrong,
  setMistakeMastered,
} from '@/lib/mistake-book/client';
import {
  COURSE_SUBJECTS,
  GRADE_SEMESTERS,
  gradeSemesterLabelKey,
  groupMistakesByCurriculum,
  subjectLabelKey,
} from '@/lib/curriculum/taxonomy';

type Filter = 'all' | 'unmastered' | 'mastered';
type RetryState = { kind: 'idle' } | { kind: 'answered'; correct: boolean } | { kind: 'revealed' };

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

function choiceCorrect(correctAnswer: unknown, picked: string[]): boolean {
  if (!Array.isArray(correctAnswer)) return false;
  const expected = [...correctAnswer].map(String).sort();
  const actual = [...picked].sort();
  return expected.length === actual.length && expected.every((value, i) => value === actual[i]);
}

export default function MistakeBookPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [mistakes, setMistakes] = useState<MistakeRecordView[]>([]);
  const [filter, setFilter] = useState<Filter>('unmastered');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(async (nextFilter: Filter) => {
    setLoading(true);
    try {
      const result = await fetchMistakes(nextFilter);
      setConfigured(result.configured);
      setMistakes(result.mistakes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(filter);
  }, [filter, reload, reloadToken]);

  const filtered = useMemo(
    () =>
      mistakes.filter(
        (record) =>
          (subjectFilter === 'all' || (record.subject ?? 'unclassified') === subjectFilter) &&
          (gradeFilter === 'all' || (record.gradeSemester ?? 'unclassified') === gradeFilter),
      ),
    [mistakes, subjectFilter, gradeFilter],
  );

  const tree = useMemo(() => groupMistakesByCurriculum(filtered), [filtered]);

  const replaceRecord = useCallback((next: MistakeRecordView) => {
    setMistakes((prev) =>
      prev.map((item) =>
        item.stageId === next.stageId &&
        item.sceneId === next.sceneId &&
        item.questionId === next.questionId
          ? next
          : item,
      ),
    );
  }, []);

  const onMastered = useCallback(
    async (record: MistakeRecordView, mastered: boolean) => {
      const ok = await setMistakeMastered(record, mastered);
      if (ok) {
        if (filter === 'all') {
          replaceRecord({ ...record, masteredAt: mastered ? new Date().toISOString() : null });
        } else {
          setMistakes((prev) => prev.filter((item) => item !== record));
        }
      }
    },
    [filter, replaceRecord],
  );

  const onDelete = useCallback(async (record: MistakeRecordView) => {
    const ok = await deleteMistakeRecord({
      kind: 'one',
      stageId: record.stageId,
      sceneId: record.sceneId,
      questionId: record.questionId,
    });
    if (ok) setMistakes((prev) => prev.filter((item) => item !== record));
  }, []);

  const onClearStage = useCallback(
    async (stageId: string) => {
      if (!window.confirm(t('mistakeBook.clearStageConfirm'))) return;
      const ok = await deleteMistakeRecord({ kind: 'stage', stageId });
      if (ok) setReloadToken((token) => token + 1);
    },
    [t],
  );

  const onClassify = useCallback(
    async (stageId: string, subject: string, gradeSemester: string) => {
      const ok = await classifyStage(stageId, {
        subject: subject === 'unclassified' ? null : subject,
        gradeSemester: gradeSemester === 'unclassified' ? null : gradeSemester,
      });
      if (ok) setReloadToken((token) => token + 1);
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

        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : !configured ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 px-4 py-6 text-sm text-amber-700 dark:text-amber-300 text-center">
            {t('mistakeBook.notConfigured')}
          </div>
        ) : tree.length === 0 ? (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/60 px-4 py-16 text-center text-sm text-gray-400">
            {t(filter === 'unmastered' ? 'mistakeBook.emptyUnmastered' : 'mistakeBook.empty')}
          </div>
        ) : (
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
                                onRetryWrong={async () => {
                                  await reportRetryWrong({
                                    stageId: record.stageId,
                                    stageName: record.stageName,
                                    sceneId: record.sceneId,
                                    ...(record.sceneTitle != null
                                      ? { sceneTitle: record.sceneTitle }
                                      : {}),
                                    ...(record.sceneOrder != null
                                      ? { sceneOrder: record.sceneOrder }
                                      : {}),
                                    ...(record.subject != null ? { subject: record.subject } : {}),
                                    ...(record.gradeSemester != null
                                      ? { gradeSemester: record.gradeSemester }
                                      : {}),
                                    items: [
                                      {
                                        questionId: record.questionId,
                                        questionType: record.questionType,
                                        question: record.question,
                                        ...(record.options ? { options: record.options } : {}),
                                        ...(record.correctAnswer
                                          ? { correctAnswer: record.correctAnswer as string[] }
                                          : {}),
                                        ...(record.analysis ? { analysis: record.analysis } : {}),
                                        userAnswer: record.lastUserAnswer,
                                      },
                                    ],
                                  });
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
        )}
      </div>
    </div>
  );
}

interface ClassifyControlProps {
  stageId: string;
  subject: string | null;
  gradeSemester: string | null;
  onClassify: (stageId: string, subject: string, gradeSemester: string) => Promise<void>;
}

function ClassifyControl({ stageId, subject, gradeSemester, onClassify }: ClassifyControlProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pickSubject, setPickSubject] = useState(subject ?? 'unclassified');
  const [pickGrade, setPickGrade] = useState(gradeSemester ?? 'unclassified');
  const [saving, setSaving] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
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
              onChange={(event) => setPickSubject(event.target.value)}
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
              onChange={(event) => setPickGrade(event.target.value)}
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
          <button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onClassify(stageId, pickSubject, pickGrade);
                setOpen(false);
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
  onMastered: (record: MistakeRecordView, mastered: boolean) => Promise<void>;
  onDelete: (record: MistakeRecordView) => Promise<void>;
  onRetryWrong: () => Promise<void>;
}

function MistakeCard({ record, onMastered, onDelete, onRetryWrong }: MistakeCardProps) {
  const { t } = useI18n();
  const [retry, setRetry] = useState<RetryState>({ kind: 'idle' });
  const [picked, setPicked] = useState<string[]>([]);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const isChoice = record.questionType === 'single' || record.questionType === 'multiple';
  const options = optionList(record.options);
  const mastered = record.masteredAt !== null;

  const pick = (value: string) => {
    if (retry.kind === 'answered') return;
    if (record.questionType === 'multiple') {
      setPicked((prev) =>
        prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
      );
    } else {
      setPicked([value]);
    }
  };

  const submitChoice = async () => {
    if (picked.length === 0 || retry.kind === 'answered') return;
    const correct = choiceCorrect(record.correctAnswer, picked);
    setRetry({ kind: 'answered', correct });
    if (correct) {
      await onMastered(record, true);
    } else {
      await onRetryWrong();
    }
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
        <p className="flex-1 text-sm font-medium leading-relaxed">{record.question}</p>
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
        {isChoice && options.length > 0 ? (
          <>
            <div className="space-y-1.5">
              {options.map((option) => {
                const selected = picked.includes(option.value);
                const answered = retry.kind === 'answered';
                const isCorrectOption =
                  Array.isArray(record.correctAnswer) &&
                  (record.correctAnswer as string[]).map(String).includes(option.value);
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
              {retry.kind !== 'answered' && (
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
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      {t('mistakeBook.retryWrong')}
                    </>
                  )}
                </span>
              )}
              {retry.kind === 'answered' && !retry.correct && (
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
        ) : (
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
                  {record.analysis ?? answerText(record.correctAnswer)}
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
        )}
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
              {record.analysis}
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
