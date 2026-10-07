'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  PieChart,
  CheckCircle2,
  HelpCircle,
  XCircle,
  RotateCcw,
  ChevronRight,
  Check,
  BookOpenText,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { useStageStore } from '@/lib/store';
import { gradeShortAnswerQuestion } from '@/lib/quiz/ai-grade';
import { MathText as QuizMathText } from '@/components/quiz/math-text';
import {
  answerIncludesOption,
  gradeChoiceQuestions,
  isShortAnswer,
  isUngradedResult,
  type QuestionResult,
} from '@/lib/quiz/grading';

const log = createLogger('QuizView');
import type { QuizQuestion } from '@/lib/types/stage';
import type { MistakeCapturePayload } from '@/lib/mistake-book/client';
import type { FrozenOwnerEnqueueOutcome } from '@/lib/mistake-book/outbox';
import type { QuizCapturePlan, QuizCapturePlanItem } from '@/lib/quiz/runtime';
import { encodeEventId } from '@/lib/mistake-book/client';
import { SpeechButton } from '@/components/audio/speech-button';
import { writeDraftRecovery } from '@/lib/quiz/persistence';
import {
  createQuizAttemptWriter,
  loadQuizAttemptState,
  QuizRetryProgressedError,
  type QuizAttemptWriter,
} from '@/lib/quiz/runtime';
import {
  createQuizViewLifetime,
  isQuizRuntimeReady,
  persistQuizReview,
  persistQuizRetry,
  persistQuizSubmission,
  quizViewStateFromAttempt,
  redeemCreationTicket,
  runQuizPersistenceTransition,
  type QuizRuntimeGate,
  type QuizViewLifetime,
} from '@/lib/quiz/view-state';

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = 'not_started' | 'answering' | 'submitting' | 'grading' | 'reviewing';

interface QuizViewProps {
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
  readonly stageId: string;
  /** Scene title/order for the mistake book's capture context (best effort). */
  readonly sceneTitle?: string;
  readonly sceneOrder?: number;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function QuizCover({
  questionCount,
  totalPoints,
  onStart,
}: {
  questionCount: number;
  totalPoints: number;
  onStart: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-6 opacity-[0.03]">
        <PieChart className="w-52 h-52 text-violet-500" />
      </div>
      <div className="absolute bottom-0 left-0 p-6 opacity-[0.02]">
        <BookOpenText className="w-40 h-40 text-violet-500 rotate-12" />
      </div>

      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        className="w-16 h-16 bg-gradient-to-br from-violet-100 to-purple-50 dark:from-violet-900/50 dark:to-purple-900/30 rounded-2xl flex items-center justify-center shadow-lg shadow-violet-100 dark:shadow-violet-900/30 ring-1 ring-violet-200/50 dark:ring-violet-700/50"
      >
        <PieChart className="w-8 h-8 text-violet-500" />
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="text-center z-10"
      >
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t('quiz.title')}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('quiz.subtitle')}</p>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="flex gap-5 text-sm z-10"
      >
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <BookOpenText className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {questionCount} {t('quiz.questionsCount')}
          </span>
        </div>
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <PieChart className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {t('quiz.totalPrefix')} {totalPoints} {t('quiz.pointsSuffix')}
          </span>
        </div>
      </motion.div>

      <motion.button
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onStart}
        className="mt-1 px-8 py-2.5 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-full font-medium shadow-lg shadow-violet-200/50 dark:shadow-violet-900/50 hover:shadow-violet-300/50 transition-shadow z-10 flex items-center gap-2"
      >
        {t('quiz.startQuiz')}
        <ChevronRight className="w-4 h-4" />
      </motion.button>
    </div>
  );
}

function SingleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;

  return (
    <QuestionCard question={question} index={index} result={result}>
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const selected = value === opt.value;
          const isCorrectOpt = isReview && answerIncludesOption(question, opt.value);
          // Only a CONFIRMED incorrect verdict paints a submission red — an ungraded
          // result (or a legacy null) must not show as wrong.
          const isWrong =
            isReview && selected && result?.status === 'incorrect' && result.correct !== null;

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                // Default state
                !isReview &&
                  !selected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  selected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                // Review states
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview &&
                  isWrong &&
                  !isCorrectOpt &&
                  'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && selected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && !isCorrectOpt && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !selected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && !isCorrectOpt && (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MultipleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const selected = value ?? [];

  const toggle = (optValue: string) => {
    if (disabled) return;
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue));
    } else {
      onChange([...selected, optValue]);
    }
  };

  const { t } = useI18n();

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
          {t('quiz.multipleChoiceHint')}
        </p>
      )}
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const isSelected = selected.includes(opt.value);
          const isCorrectOpt = isReview && answerIncludesOption(question, opt.value);
          const isWrong = isReview && isSelected && !isCorrectOpt;

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                !isReview &&
                  !isSelected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  isSelected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview && isWrong && 'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && isSelected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {!isReview && isSelected ? <Check className="w-3.5 h-3.5" /> : opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !isSelected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && <XCircle className="w-5 h-5 text-red-400 shrink-0" />}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function ShortAnswerQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const { t } = useI18n();
  // Ref to track latest value for voice transcription append
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview ? (
        <div className="relative">
          <textarea
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={t('quiz.inputPlaceholder')}
            className="w-full min-h-[100px] p-3 pb-10 rounded-xl border border-gray-200 dark:border-gray-600 text-sm resize-none focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
          />
          <SpeechButton
            size="sm"
            disabled={disabled}
            className="absolute bottom-3 left-3"
            onTranscription={(text) => {
              const cur = valueRef.current ?? '';
              onChange(cur + (cur ? ' ' : '') + text);
            }}
          />
          <span className="absolute bottom-3 right-3 text-xs text-gray-300 dark:text-gray-600">
            {(value ?? '').length} {t('quiz.charCount')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{t('quiz.yourAnswer')}</p>
            {value ? (
              <QuizMathText text={value} />
            ) : (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          {result.aiComment && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-50 dark:bg-violet-900/30 border border-violet-100 dark:border-violet-800">
              <Sparkles className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-violet-600 dark:text-violet-400 mb-0.5">
                  {t('quiz.aiComment')}
                </p>
                <p className="text-xs text-violet-600/80 dark:text-violet-400/80">
                  <QuizMathText text={result.aiComment} />
                </p>
              </div>
              <span className="ml-auto text-xs font-bold text-violet-600 dark:text-violet-400 shrink-0">
                {result.earned}/{question.points ?? 1}
                {t('quiz.pointsSuffix')}
              </span>
            </div>
          )}
        </div>
      )}
    </QuestionCard>
  );
}

function QuestionCard({
  question,
  index,
  result,
  children,
}: {
  question: QuizQuestion;
  index: number;
  result?: QuestionResult;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const pts = question.points ?? 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        'bg-white dark:bg-gray-800 rounded-2xl border p-5 relative overflow-hidden',
        !isReview && 'border-gray-150 dark:border-gray-700 shadow-sm',
        isReview &&
          result.status === 'correct' &&
          'border-emerald-200 dark:border-emerald-800 shadow-sm shadow-emerald-50 dark:shadow-emerald-900/20',
        isReview &&
          result.status === 'incorrect' &&
          result.correct !== null &&
          'border-red-200 dark:border-red-800 shadow-sm shadow-red-50 dark:shadow-red-900/20',
        isReview && isUngradedResult(result) && 'border-amber-200 dark:border-amber-800',
      )}
    >
      {/* Left accent */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl',
          !isReview && 'bg-violet-400',
          isReview && result.status === 'correct' && 'bg-emerald-400',
          isReview && result.status === 'incorrect' && result.correct !== null && 'bg-red-400',
          isReview && isUngradedResult(result) && 'bg-amber-400',
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0',
              !isReview &&
                'bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400',
              isReview &&
                result.status === 'correct' &&
                'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400',
              isReview &&
                result.status === 'incorrect' &&
                result.correct !== null &&
                'bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400',
              isReview &&
                isUngradedResult(result) &&
                'bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400',
            )}
          >
            {index + 1}
          </span>
          <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-relaxed">
              <QuizMathText text={question.question} allowDisplayMode />
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {question.type === 'single'
                ? t('quiz.singleChoice')
                : question.type === 'multiple'
                  ? t('quiz.multipleChoice')
                  : t('quiz.shortAnswer')}
              {' · '}
              {pts} {t('quiz.pointsSuffix')}
            </p>
          </div>
        </div>
        {isReview && (
          <div className="shrink-0 ml-2">
            {result.status === 'correct' && <CheckCircle2 className="w-6 h-6 text-emerald-500" />}
            {result.status === 'incorrect' && result.correct !== null && (
              <XCircle className="w-6 h-6 text-red-400" />
            )}
            {isUngradedResult(result) && <HelpCircle className="w-6 h-6 text-amber-400" />}
          </div>
        )}
      </div>

      {/* Body */}
      {children}

      {/* Analysis (review only) */}
      {isReview && question.analysis && (
        <div className="mt-3 p-3 rounded-lg bg-blue-50/70 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          <span className="font-medium">{t('quiz.analysis')}</span>
          <QuizMathText text={question.analysis} allowDisplayMode />
        </div>
      )}
    </motion.div>
  );
}

function ScoreBanner({
  score,
  total,
  results,
  onRetryGrading,
}: {
  score: number;
  total: number;
  results: QuestionResult[];
  onRetryGrading?: () => void;
}) {
  const { t } = useI18n();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const correctCount = results.filter((r) => r.status === 'correct').length;
  const incorrectCount = results.filter(
    (r) => r.status === 'incorrect' && r.correct !== null,
  ).length;
  const ungradedCount = results.filter((r) => isUngradedResult(r)).length;

  const color = pct >= 80 ? 'emerald' : pct >= 60 ? 'amber' : 'red';
  const colorMap = {
    emerald: {
      bg: 'from-emerald-500 to-teal-500',
      shadow: 'shadow-emerald-200/50 dark:shadow-emerald-900/50',
      ring: 'bg-emerald-400/30',
      text: t('quiz.excellent'),
    },
    amber: {
      bg: 'from-amber-500 to-yellow-500',
      shadow: 'shadow-amber-200/50 dark:shadow-amber-900/50',
      ring: 'bg-amber-400/30',
      text: t('quiz.keepGoing'),
    },
    red: {
      bg: 'from-red-500 to-rose-500',
      shadow: 'shadow-red-200/50 dark:shadow-red-900/50',
      ring: 'bg-red-400/30',
      text: t('quiz.needsReview'),
    },
  };
  const c = colorMap[color];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn('rounded-2xl p-6 bg-gradient-to-r text-white shadow-lg', c.bg, c.shadow)}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white/80 text-sm font-medium">{c.text}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-4xl font-black">{score}</span>
            <span className="text-white/60 text-lg">/ {total}</span>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {correctCount} {t('quiz.correct')}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {incorrectCount} {t('quiz.incorrect')}
            </span>
            {ungradedCount > 0 && (
              <span className="flex items-center gap-1">
                <HelpCircle className="w-3.5 h-3.5" /> {ungradedCount} {t('quiz.ungraded')}
              </span>
            )}
          </div>
          {ungradedCount > 0 && onRetryGrading && (
            <button
              onClick={onRetryGrading}
              className="mt-3 px-3 py-1.5 rounded-full bg-white/20 hover:bg-white/30 text-xs font-medium transition-colors"
            >
              {t('quiz.retryGrading')}
            </button>
          )}
        </div>

        {/* Percentage ring */}
        <div className="relative w-20 h-20">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="6"
            />
            <motion.circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="white"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - pct / 100) }}
              transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-black">{pct}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Capture-plan progress/executor wiring (P3: shared strict rules) ────────
// The identity/report rules live in '@/lib/mistake-book/plan-executor' and
// are shared with the client capture helper — QuizView only supplies its
// learner key, ledger effects, and mount/attempt guards here.

/** The learner identity for executor deps (dynamically imported, shared). */
async function resolveLearnerKey(): Promise<string> {
  const { getLearnerKey } = await import('@/lib/runtime/learner-key');
  return getLearnerKey();
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function QuizView({ questions, sceneId, stageId, sceneTitle, sceneOrder }: QuizViewProps) {
  const { t, locale } = useI18n();

  const [phase, setPhase] = useState<Phase>('not_started');
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [results, setResults] = useState<QuestionResult[]>([]);
  // ── Capture ledger (C2 design): the per-attempt source of truth ──
  // One target per question of THIS attempt, merged INCREMENTALLY across
  // every capture (a mixed grading recovery captures the choice now and the
  // short answer later — the second submission must never blanket-overwrite
  // the first's unfinished targets). States are the typed per-question
  // outcomes; 'uploaded' is terminal (a late older failure cannot undo it);
  // opSeq drops results from superseded operations only.
  type CaptureTargetState =
    | 'uploaded'
    | 'queued'
    | 'parked'
    | 'unbound'
    | 'conflict'
    | 'unconfigured'
    | 'local-failed'
    /** Honest recoverable storage/sync error (r1 §6): retryable, never a
     *  durability claim — the frozen plan stays the retry source. */
    | 'store-error'
    /** Operation started, verdict pending — claims NOTHING about durability. */
    | 'saving';
  interface CaptureTarget {
    questionId: string;
    eventId: string;
    /** Latest VERIFIED record key (owner-scoped; migrated on committed binds). */
    handle?: string;
    /** Stable content fingerprint of the frozen payload (receipt identity). */
    fingerprint?: string;
    /** The record's creation token — the INSTANCE identity of receipts. */
    recordToken?: string;
    /** Legacy token-less records: createdAt is the INSTANCE identity. */
    recordCreatedAt?: number;
    state: CaptureTargetState;
    /** Per-question operation sequence: results from older ops are dropped. */
    opSeq: number;
  }
  const captureLedgerRef = useRef<Map<string, CaptureTarget>>(new Map());
  // Open recovery operations of THIS attempt, in submission order: the
  // VERBATIM original payload plus the creation proofs that operation holds.
  // Retry re-sends the SAME events (same attempt/ids/frozen content) and may
  // continue binding exactly its own proof-matched records — never a blanket
  // claim of older unknown events.
  const openRecoveriesRef = useRef<
    Array<{
      payload: MistakeCapturePayload;
      proofs: Array<{ eventId: string; creationToken: string }>;
    }>
  >([]);
  const captureOpSeqRef = useRef(0);
  // Pill state DERIVED from the ledger (never the last Promise's verdict):
  // local-failed dominates (a persisted subset uploading must not mask it),
  // then conflict / unconfigured / unbound / queued; every target uploaded →
  // 'uploaded'. 'queued' means DURABLE evidence exists for every unfinished
  // target — nothing unsaved is ever called "saved offline".
  const [captureNotice, setCaptureNotice] = useState<
    | 'uploaded'
    | 'queued'
    | 'unbound'
    | 'conflict'
    | 'unconfigured'
    | 'local-failed'
    | 'store-error'
    | null
  >(null);
  const [captureRetryable, setCaptureRetryable] = useState(false);
  const recomputeCaptureNotice = useCallback(() => {
    const targets = [...captureLedgerRef.current.values()];
    if (targets.length === 0) {
      setCaptureNotice(null);
      setCaptureRetryable(false);
      return;
    }
    const has = (state: CaptureTargetState) => targets.some((target) => target.state === state);
    if (has('local-failed') || has('store-error')) {
      // Honest recoverable failures dominate — a persisted subset uploading
      // must not mask them, and q1's success never hides q2's local failure.
      setCaptureNotice(has('local-failed') ? 'local-failed' : 'store-error');
    } else if (has('conflict')) setCaptureNotice('conflict');
    else if (has('unconfigured')) setCaptureNotice('unconfigured');
    else if (has('saving')) {
      // A pending verdict blocks every whole-set claim (closing gate #3):
      // with q1 still saving, "saved offline" would assert durability for a
      // question with NO evidence yet — no notice until it resolves. The
      // hard failures above still dominate so partial success masks nothing.
      setCaptureNotice(null);
    } else if (has('unbound')) setCaptureNotice('unbound');
    else if (has('queued') || has('parked')) setCaptureNotice('queued');
    else setCaptureNotice('uploaded');
    setCaptureRetryable(
      openRecoveriesRef.current.length > 0 ||
        targets.some((target) => target.state === 'store-error' || target.state === 'local-failed'),
    );
  }, []);
  // Component-level mount guard + attempt identity (C2 implementation
  // review #1/#3): async capture/retry continuations may setState only while
  // the component is MOUNTED and the attempt is STILL CURRENT. The grading
  // effect's `cancelled` flag is wrong for this — effect RE-RUNS
  // (phase → reviewing) also flip it while the component stays mounted.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // The CURRENT attempt id, readable from async continuations without stale
  // closures: a result from an older attempt (real re-answer) is dropped.
  const attemptIdRef = useRef<string | null>(null);
  /** Confirmed outbox owner snapshot for plan building (null = unknown). */

  /** The current attempt's frozen plan items (merged, never rebuilt). */
  const planRef = useRef<QuizCapturePlan | null>(null);
  // Latest results without re-running the grading effect on every setResults.
  const resultsRef = useRef<QuestionResult[]>([]);
  const orderedResultsRef = useRef<QuestionResult[]>([]);
  resultsRef.current = results;
  const [runtimeGate, setRuntimeGate] = useState<QuizRuntimeGate>({ status: 'loading' });
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const viewLifetimeRef = useRef<QuizViewLifetime | null>(null);
  viewLifetimeRef.current ??= createQuizViewLifetime();
  const viewLifetime = viewLifetimeRef.current;
  const runtimeWriterRef = useRef<QuizAttemptWriter | null>(null);
  // Wrong answers already captured for this mount, keyed by attempt+question,
  // so the ungraded-recovery re-grade cannot double-count them (R9 makes the
  // server idempotent by event id).
  const capturedRef = useRef<Set<string>>(new Set());
  runtimeWriterRef.current ??= createQuizAttemptWriter({
    onError: (error) => log.warn('Failed to persist quiz runtime:', error),
  });
  const runtimeWriter = runtimeWriterRef.current;

  useEffect(() => {
    return () => {
      void runtimeWriter.flushDraft();
    };
  }, [runtimeWriter]);

  // Cache the outbox module + learner key so plan building reads the CURRENT
  // confirmed owner/learner synchronously at freeze time.
  useEffect(() => {
    let alive = true;
    void import('@/lib/mistake-book/outbox').then((outbox) => {
      if (alive) outboxModuleRef.current = outbox;
    });
    void import('@/lib/runtime/learner-key')
      .then((m) => m.getLearnerKey())
      .then((learner) => {
        if (alive) planLearnerRef.current = learner;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRuntimeGate({ status: 'loading' });
    setRetrying(false);
    void loadQuizAttemptState({ stageId, sceneId })
      .then(async ({ attemptId: nextAttemptId, state }) => {
        if (cancelled) return;
        // r2 item 1 + r3 group 2: the ORIGINAL-OPERATION bind capability is
        // ephemeral — granted ONLY to attempts created in this live episode:
        // (a) a first-ever attempt (hydration found NO stored state), or
        // (b) exactly the ONE child minted by THIS episode's SUCCESSFUL
        // real re-answer transition (the narrow creation ticket, consumed
        // once and never refreshed). Any other stored-state hydration
        // (restore, regrade, empty draft) is claim-only forever.
        // r4 group 2: the ticket is the TYPED receipt of the EXACT child
        // this episode's locked retry write created — redeemed only when
        // canonical hydration returns THAT child; any other stored attempt
        // (including another actor's advanced canonical Y) grants nothing.
        // r4 closing: redemption runs through the PRODUCTION helper shared
        // with the runtime race barrier (lib/quiz/view-state) — context
        // (stage/scene/lineage) mismatches revoke without granting.
        const ticket = pendingCreationTicketRef.current;
        pendingCreationTicketRef.current = null; // consumed / expired (one shot)
        const redeemedAttemptId = redeemCreationTicket(ticket, {
          attemptId: nextAttemptId,
          fromEmpty: state === undefined,
          stageId,
          sceneId,
        });
        if (redeemedAttemptId !== null) {
          liveCreatedAttemptsRef.current.add(redeemedAttemptId);
        } else if (state !== undefined) {
          liveCreatedAttemptsRef.current.delete(nextAttemptId);
        }
        const next = quizViewStateFromAttempt(state);
        setPhase(next.phase);
        setAnswers(next.answers);
        setResults(next.results);
        // A restored review's wrong answers were captured by the pass that
        // graded them — intents-first means their events were enqueued
        // BEFORE the review stored. Pre-mark ONLY questions with DURABLE
        // outbox evidence (gate group 5): a crash between the review commit
        // and the enqueue leaves no record, and its capture must RE-RUN on
        // the same identity instead of being skipped forever.
        if (next.phase === 'reviewing') {
          const wrongResults = next.results.filter(
            (result) => result.status === 'incorrect' && result.correct === false,
          );
          if (next.capturePlan !== undefined) {
            // NEW-pipeline review (§3 recovery matrix): adopt the persisted
            // plan (frozen identities), then recover only the items that are
            // neither progress-confirmed nor STRICTLY evidenced in the queue.
            // Known origin owners stay frozen; unknown origins enqueue unbound
            // (claim-only) with NO auto-bind proof.
            planRef.current = next.capturePlan;
            const capturePlan = next.capturePlan;
            registerPlanInLedgerRef.current(capturePlan.items);
            const executor = await import('@/lib/mistake-book/plan-executor');
            const outbox = await import('@/lib/mistake-book/outbox');
            const { actualIdentityFromQueueSide } = await import('@/lib/mistake-book/progress');
            const deps = { getLearnerKey: resolveLearnerKey };
            const markUploaded = (item: QuizCapturePlanItem) => {
              capturedRef.current.add(`${capturePlan.attemptId}:${item.questionId}`);
              const target = captureLedgerRef.current.get(item.questionId);
              if (target && target.state !== 'uploaded') {
                captureLedgerRef.current.set(item.questionId, { ...target, state: 'uploaded' });
              }
            };
            const pending: QuizCapturePlanItem[] = [];
            for (const item of capturePlan.items) {
              if (cancelled) return;
              // P3 §1/#6: STRICT structured precheck — every outcome has an
              // explicit branch; 'unreadable' is never "no row" and never
              // enqueues as if the scope were absent.
              const precheck = await executor.precheckItem(capturePlan, item, deps);
              if (cancelled) return;
              if (precheck.action === 'confirmed') {
                markUploaded(item);
              } else if (precheck.action === 'learner-stale') {
                // r2 item 6: the resolved learner no longer matches the
                // frozen plan — an honest recoverable error; NO side effect
                // may touch either partition.
                const target = captureLedgerRef.current.get(item.questionId);
                if (target && target.state !== 'uploaded') {
                  captureLedgerRef.current.set(item.questionId, {
                    ...target,
                    state: 'store-error',
                  });
                }
              } else if (precheck.action === 'unreadable') {
                // Honestly unresolved: the ledger keeps its 'saving' state
                // (no whole-set claim), and a later pass retries the read.
              } else if (precheck.action === 'conflict') {
                // The scope is held by a DIFFERENT plan: keep THIS plan
                // frozen and surface the recoverable conflict state — no
                // guessing empty, no enqueue.
                const target = captureLedgerRef.current.get(item.questionId);
                if (target && target.state !== 'uploaded') {
                  captureLedgerRef.current.set(item.questionId, { ...target, state: 'conflict' });
                }
              } else if (precheck.action === 'evidence') {
                if (precheck.evidence.status === 'receipt') {
                  // A committed receipt for the EXACT instance: confirm the
                  // durable progress first; only a committed confirm
                  // promotes the ledger (a failed write stays recoverable).
                  const fingerprint = outbox.fingerprintOf(item.payload);
                  const actual = actualIdentityFromQueueSide(
                    precheck.evidence.side,
                    item.eventId,
                    fingerprint,
                  );
                  const confirmed =
                    actual !== null &&
                    (await executor.confirmItemActual(capturePlan, item, actual, 'receipt', deps));
                  if (cancelled) return;
                  if (confirmed) {
                    markUploaded(item);
                  } else {
                    // The receipt is real (no re-enqueue) but the progress
                    // write did not commit — honestly retryable later.
                    capturedRef.current.add(`${capturePlan.attemptId}:${item.questionId}`);
                  }
                } else if (precheck.evidence.status === 'queued') {
                  // The queue holds this exact instance — it owns the retry.
                  // The ledger adopts the side's COMPLETE real identity and
                  // the state follows its REAL owner (r2 item 5): an unbound
                  // record is 'unbound' (claim-only), never a sync promise.
                  capturedRef.current.add(`${capturePlan.attemptId}:${item.questionId}`);
                  const queuedSide = precheck.evidence.side;
                  const target = captureLedgerRef.current.get(item.questionId);
                  if (target) {
                    captureLedgerRef.current.set(
                      item.questionId,
                      executor.adoptEvidenceSide(target, queuedSide, 'queued'),
                    );
                  }
                } else if (precheck.evidence.status === 'conflict') {
                  // Something exists at the key for ANOTHER instance. The
                  // outbox's enqueue is the authoritative content classifier:
                  // a same-content different-instance record (e.g. a LEGACY
                  // reuse target) is adopted there, only different CONTENT
                  // freezes as a conflict — so route through the enqueue.
                  pending.push(item);
                }
                // evidence 'unreadable': honestly unresolved — skip.
              } else {
                pending.push(item); // genuinely absent for this exact instance
              }
            }
            recomputeCaptureNotice();
            if (pending.length > 0) {
              // r1 §5: the recovery launches ONLY after the hydrated
              // attempt is genuinely ADOPTED (the ready-gated effect below
              // fires once attemptIdRef reflects nextAttempt) — launching
              // here would race attemptIdRef (still null/old) and the
              // executor's guards would silently drop the recovery.
              pendingRecoveryRef.current = { ...capturePlan, items: pending };
            }
          } else if (wrongResults.length > 0) {
            // LEGACY review (no plan): the historical zero-re-capture fact
            // stands — nothing is re-enqueued, nothing claimed.
            for (const result of wrongResults) {
              capturedRef.current.add(`${nextAttemptId}:${result.questionId}`);
            }
          }
        }
        setRuntimeGate({ status: 'ready', attemptId: nextAttemptId });
      })
      .catch((error) => {
        log.warn('Failed to hydrate quiz runtime:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
      });
    return () => {
      cancelled = true;
      viewLifetime.invalidate();
      void runtimeWriter.flushDraft();
    };
  }, [hydrationVersion, runtimeWriter, sceneId, stageId, viewLifetime, recomputeCaptureNotice]);

  // r1 §5: the DETERMINISTIC recovery entry — fires after the render that
  // adopted the hydrated attempt (attemptIdRef is real), keeps the actual
  // attempt guard, and never relies on React happening to render first.
  const pendingRecoveryRef = useRef<QuizCapturePlan | null>(null);
  // r2 item 1: attempts created in THIS live episode (hydration found no
  // stored state). Membership is the EPHEMERERAL original-operation
  // capability — the only source of auto-bind privilege for fresh unbound
  // creations; restored/rehydrated attempts are claim-only.
  const liveCreatedAttemptsRef = useRef<Set<string>>(new Set());
  // r3 group 2: ONE narrow creation ticket minted by a SUCCESSFUL retry
  // transition in this episode; the next canonical hydration may convert it
  // into capability membership for exactly the child it lands on.
  const pendingCreationTicketRef = useRef<
    import('@/lib/quiz/view-state').QuizRetryCreationReceipt | null
  >(null);
  // r3 group 2: stable per-attempt episode nonces (header identity reuse).
  const episodeNonceRef = useRef<Map<string, string>>(new Map());
  const attemptId = isQuizRuntimeReady(runtimeGate) ? runtimeGate.attemptId : null;
  useEffect(() => {
    const pending = pendingRecoveryRef.current;
    if (pending === null || attemptId === null || attemptId !== pending.attemptId) return;
    pendingRecoveryRef.current = null;
    void executeCapturePlanRef.current(pending, { bindAsRecovery: true });
  }, [attemptId]);
  // Keep the async-visible attempt identity in sync every render; a REAL
  // re-answer (new attempt id) must orphan any in-flight capture result.
  attemptIdRef.current = attemptId;
  // A real re-answer starts a fresh attempt: the previous attempt's capture
  // notice, retry payload, and pending handles no longer describe anything
  // on screen — clear them (C2 implementation review #3).
  const lastAttemptRef = useRef<string | null>(null);
  if (attemptId !== null && lastAttemptRef.current !== attemptId) {
    const hadPreviousAttempt = lastAttemptRef.current !== null;
    lastAttemptRef.current = attemptId;
    if (hadPreviousAttempt) {
      // A REAL new attempt starts with a clean ledger: the old attempt's
      // notices, recovery payloads, and pending handles describe nothing on
      // screen. (Its durable outbox records stay — the queue owns retries.)
      captureLedgerRef.current = new Map();
      openRecoveriesRef.current = [];
      setCaptureNotice(null);
      setCaptureRetryable(false);
    }
  }

  const totalPoints = useMemo(
    () => questions.reduce((sum, q) => sum + (q.points ?? 1), 0),
    [questions],
  );

  const allAnswered = useMemo(() => {
    return questions.every((q) => {
      const a = answers[q.id];
      if (!a) return false;
      if (Array.isArray(a)) return a.length > 0;
      return (a as string).trim().length > 0;
    });
  }, [questions, answers]);

  const handleSetAnswer = useCallback(
    (questionId: string, value: string | string[]) => {
      setAnswers((prev) => {
        const next = { ...prev, [questionId]: value };
        if (attemptId) {
          writeDraftRecovery(sceneId, attemptId, next);
          runtimeWriter.scheduleDraft({
            stageId,
            sceneId,
            attemptId,
            answers: next,
          });
        }
        return next;
      });
    },
    [attemptId, runtimeWriter, sceneId, stageId],
  );

  const handleSubmit = useCallback(async () => {
    if (!attemptId) return;
    setPhase('submitting');
    await runQuizPersistenceTransition(
      () => persistQuizSubmission({ stageId, sceneId, attemptId, answers }, runtimeWriter),
      viewLifetime,
      () => setPhase('grading'),
      (error) => {
        log.warn('Failed to persist quiz submission:', error);
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, answers, runtimeWriter, sceneId, stageId, viewLifetime]);

  /** The stable per-question event id the capture payload will mint. */
  const questionEventIdOf = (attempt: string, questionId: string) =>
    encodeEventId([attempt, questionId]);

  /** Merge a capture result into THIS attempt's ledger (C2 design §课堂消费). */
  const mergeCaptureResult = useCallback(
    (
      result: {
        status: string;
        questions: Array<{
          questionId: string;
          eventId: string;
          handle?: string;
          fingerprint?: string;
          recordToken?: string;
          state: CaptureTargetState;
        }>;
        recoveryProofs: Array<{ eventId: string; creationToken: string }>;
      },
      opSeq: number,
    ) => {
      for (const question of result.questions) {
        const existing = captureLedgerRef.current.get(question.questionId);
        if (existing && existing.opSeq > opSeq) continue; // superseded operation
        if (existing?.state === 'uploaded' && question.state !== 'uploaded') {
          continue; // uploaded is terminal — a late older failure cannot undo it
        }
        captureLedgerRef.current.set(question.questionId, {
          questionId: question.questionId,
          eventId: question.eventId,
          handle: question.handle,
          fingerprint: question.fingerprint,
          recordToken: question.recordToken,
          state: question.state,
          opSeq,
        });
      }
      recomputeCaptureNotice();
    },
    [recomputeCaptureNotice],
  );

  // ── Capture-plan helpers (Codex intent-design §1/§2) ──

  /** The owner fact to freeze into a plan built NOW ('' = explicitly unknown). */
  const outboxModuleRef = useRef<typeof import('@/lib/mistake-book/outbox') | null>(null);
  const planLearnerRef = useRef<string>('');
  const currentConfirmedOwnerForPlan = (): string =>
    outboxModuleRef.current?.currentConfirmedOwner() ?? '';

  /** Fetch the learner identity for plan building (cached after first call). */
  const getLearnerKeyForPlan = async (): Promise<string> => {
    const { getLearnerKey } = await import('@/lib/runtime/learner-key');
    const learner = await getLearnerKey();
    planLearnerRef.current = learner;
    return learner;
  };

  /** Mint ONE creation token per plan item; never re-minted on recovery. */
  const mintPlanToken = (eventId: string) =>
    `plan|${eventId}|${Date.now().toString(36)}|${Math.random().toString(36).slice(2, 8)}`;

  /** Freeze the per-question plan for every NEW decided-wrong result. */
  const buildCapturePlanRef = useRef(
    async (): Promise<QuizCapturePlan> => ({
      planVersion: 1,
      originOwner: '',
      originEpisodeId: '',
      attemptId: '',
      sceneId: '',
      learnerKey: '',
      items: [],
    }),
  );

  const buildCapturePlan = useCallback(
    async (
      ordered: QuestionResult[],
      context: {
        attemptId: string;
        sceneId: string;
        stageName: string;
        sceneTitle?: string;
        sceneOrder?: number;
        subject?: string;
        gradeSemester?: string;
        originOwner: string;
      },
    ): Promise<QuizCapturePlan> => {
      // P1: the learner is ACTUALLY fetched before any plan is built — an
      // empty/unavailable identity never persists into a header; a failure
      // throws to the runtime error gate (never a silent empty-ref default).
      const learnerKey = planLearnerRef.current || (await getLearnerKeyForPlan());
      if (learnerKey === '') {
        throw new Error('capture plan build refused: learner identity unavailable');
      }
      const byId = new Map(questions.map((question) => [question.id, question]));
      const prev = planRef.current;
      // P1: reuse ONLY a plan from the SAME attempt/scene/learner — strict
      // non-empty learner equality (no '' exemption).
      const prevReusable =
        prev !== null &&
        prev.attemptId === context.attemptId &&
        prev.sceneId === context.sceneId &&
        prev.learnerKey === learnerKey;
      // P3 §4: the historical-exemption baseline. When THIS attempt has no
      // plan yet, the questions ALREADY decided wrong in its real no-plan
      // (legacy) review history are frozen as exempt — their zero-re-capture
      // fact must survive the modern upgrade, reloads, and further
      // regrading. Once a plan exists, its own frozen baseline carries
      // forward immutably. A modern not-yet-enqueued wrong is never marked
      // historical (only PRE-EXISTING decided-wrong results count).
      const { legacyExemptQuestionIds } = await import('@/lib/quiz/runtime');
      const legacyExempt = legacyExemptQuestionIds(prevReusable ? prev : null, resultsRef.current);
      // r2 item 1: a NEW header freezes a MEANINGFUL original episode
      // identity — the live episode that created the attempt, never a bare
      // attemptId alias. Reused (frozen) headers carry their original value
      // verbatim; restored attempts that build a first modern plan mark a
      // restored episode, keeping the semantics conservative.
      const liveEpisode = liveCreatedAttemptsRef.current.has(context.attemptId);
      // ONE stable nonce per (live episode, attempt creation) — minted on
      // the first header build for that attempt and REUSED for every later
      // merge, never a fresh Date.now() per build.
      const episodeNonceKey = `${context.attemptId}`;
      const existingNonce = episodeNonceRef.current.get(episodeNonceKey);
      const nonce = existingNonce ?? Math.random().toString(36).slice(2, 10);
      if (existingNonce === undefined) episodeNonceRef.current.set(episodeNonceKey, nonce);
      const originEpisodeId = `${liveEpisode ? 'live' : 'restored'}:${context.attemptId}:${nonce}`;
      const header: QuizCapturePlan = prevReusable
        ? prev
        : {
            planVersion: 1,
            originOwner: context.originOwner,
            originEpisodeId,
            attemptId: context.attemptId,
            sceneId: context.sceneId,
            learnerKey,
            ...(legacyExempt.length > 0 ? { legacyExemptQuestions: legacyExempt } : {}),
            items: [],
          };
      const items = [...header.items];
      for (const result of ordered) {
        if (result.status !== 'incorrect' || result.correct !== false) continue;
        if (items.some((item) => item.questionId === result.questionId)) continue;
        if (
          header.legacyExemptQuestions?.includes(result.questionId) ||
          (prevReusable && (prev.legacyExemptQuestions ?? []).includes(result.questionId))
        ) {
          continue; // historical legacy wrong: exemption stays durable (P3 §4)
        }
        const question = byId.get(result.questionId);
        if (!question) continue;
        const eventId = questionEventIdOf(context.attemptId, result.questionId);
        items.push({
          questionId: result.questionId,
          eventId,
          payload: {
            stageId,
            stageName: context.stageName,
            sceneId: context.sceneId,
            ...(context.sceneTitle ? { sceneTitle: context.sceneTitle } : {}),
            ...(context.sceneOrder !== undefined ? { sceneOrder: context.sceneOrder } : {}),
            ...(context.subject ? { subject: context.subject } : {}),
            ...(context.gradeSemester ? { gradeSemester: context.gradeSemester } : {}),
            eventId,
            items: [
              {
                questionId: question.id,
                eventId,
                questionType: question.type,
                question: question.question,
                ...(question.options ? { options: question.options } : {}),
                ...(question.answer ? { correctAnswer: question.answer } : {}),
                ...(question.knowledgePoint ? { knowledgePoint: question.knowledgePoint } : {}),
                // Same merged analysis the canonical builder freezes:
                // question.analysis + THIS result's AI comment (P1 addendum).
                ...([question.analysis, result.aiComment].filter(Boolean).join('\n\n') || undefined
                  ? {
                      analysis: [question.analysis, result.aiComment].filter(Boolean).join('\n\n'),
                    }
                  : {}),
                userAnswer: answers[question.id],
              },
            ],
          },
          recordToken: mintPlanToken(eventId),
        });
      }
      // LOCAL only (P1 final): the caller adopts the ref AFTER its own
      // cancelled/attempt guards AND a successful review commit — a stale
      // async build can never overwrite a newer attempt's plan.
      return { ...header, items };
    },
    [answers, questions, stageId],
  );

  buildCapturePlanRef.current = async () =>
    buildCapturePlan(orderedResultsRef.current, {
      attemptId: attemptId ?? 'unknown-attempt',
      sceneId,
      stageName: useStageStore.getState().stage?.name ?? '',
      sceneTitle,
      sceneOrder,
      originOwner: currentConfirmedOwnerForPlan(),
    });

  /** §2.3: register every plan target in the ledger (no success masking). */
  const registerPlanInLedgerRef = useRef<(items: QuizCapturePlanItem[]) => void>(() => {});
  const registerPlanInLedger = useCallback(
    (items: QuizCapturePlanItem[]) => {
      const opSeq = ++captureOpSeqRef.current;
      for (const item of items) {
        if (captureLedgerRef.current.get(item.questionId)?.state === 'uploaded') continue;
        captureLedgerRef.current.set(item.questionId, {
          questionId: item.questionId,
          eventId: item.eventId,
          state: 'saving',
          opSeq,
        });
      }
      recomputeCaptureNotice();
    },
    [recomputeCaptureNotice],
  );
  registerPlanInLedgerRef.current = registerPlanInLedger;

  /** §2.4: background plan execution (enqueue + flush + report consumption). */
  const executeCapturePlanRef = useRef<
    (plan: QuizCapturePlan, options?: { bindAsRecovery?: boolean }) => Promise<void>
  >(async () => {});
  const executeCapturePlan = useCallback(
    async (plan: QuizCapturePlan, options: { bindAsRecovery?: boolean } = {}) => {
      const bindAsRecovery = options.bindAsRecovery === true;
      const items = plan.items;
      // r4 group 1: the COMPLETE IMMUTABLE OPERATION CONTEXT is captured at
      // EXECUTOR ENTRY — before any module import or await: every item's
      // current opSeq (a missing target is recorded, NOT a wildcard), the
      // frozen original-capability generation, and the entry attempt. Later
      // items never re-capture newer sequences.
      const entryOpSeqs = new Map<string, number | null>();
      for (const entryItem of items) {
        entryOpSeqs.set(
          entryItem.questionId,
          captureLedgerRef.current.get(entryItem.questionId)?.opSeq ?? null,
        );
      }
      const entryOriginalCapability = liveCreatedAttemptsRef.current.has(plan.attemptId);
      const entryAttempt = attemptIdRef.current;
      const operationCurrent = (item: QuizCapturePlanItem): boolean => {
        if (!mountedRef.current || attemptIdRef.current !== plan.attemptId) return false;
        if (entryAttempt !== null && attemptIdRef.current !== entryAttempt) return false;
        const captured = entryOpSeqs.get(item.questionId);
        // r4 closing group 1: a MISSING entry capture is not a wildcard —
        // this execution never owned the target, so it may issue nothing.
        if (captured === null || captured === undefined) return false;
        const current = captureLedgerRef.current.get(item.questionId);
        // A MISSING current target is equally not a wildcard: the target is
        // unregistered (or cleared) — no operation owns it through here.
        if (current === undefined) return false;
        return current.opSeq === captured; // identical operation still owns the target
      };
      const executor = await import('@/lib/mistake-book/plan-executor');
      const outbox = await import('@/lib/mistake-book/outbox');
      const deps = { getLearnerKey: resolveLearnerKey };
      const guards = () => mountedRef.current && attemptIdRef.current === plan.attemptId;
      const setItemState = (
        questionId: string,
        state: CaptureTargetState,
        adopt?: (target: CaptureTarget) => CaptureTarget,
        expectedOpSeq?: number,
      ) => {
        const target = captureLedgerRef.current.get(questionId);
        if (!target) return;
        // r2 item 6: a verdict decided under an OLDER operation never lands
        // on a newer target — validate the captured opSeq after every await.
        if (expectedOpSeq !== undefined && target.opSeq !== expectedOpSeq) return;
        if (target.state === 'uploaded' && state !== 'uploaded') return; // terminal
        if (target.state === 'conflict' && state !== 'conflict') return; // permanent
        captureLedgerRef.current.set(questionId, adopt ? adopt(target) : { ...target, state });
        recomputeCaptureNotice();
      };
      /**
       * r2 item 1: the EPHEMERERAL original-operation capability. ONLY an
       * attempt CREATED in this live episode may auto-bind its fresh unbound
       * creations; stored plan tokens, attemptIds, or newly created rows of
       * a RESTORED attempt never grant it. Hydration revoked membership for
       * any attempt it found stored state for, so a refreshed old attempt
       * is claim-only — including regrades that newly decide q2 wrong.
       */
      /**
       * P3 §2a + r2 item 1: ONLY this round's FRESHLY persisted UNBOUND
       * creations of an ORIGINAL operation are auto-bind proofs — a reused
       * record issues no new creation proof, and a restored/recovery pass
       * NEVER auto-binds an unknown origin.
       */
      const freshUnboundCreations: Array<{ eventId: string; creationToken: string }> = [];
      // C1's accepted contract (batch-c2 CONFLICT case): an execution whose
      // every target was a local CONFILCT/confirmed verdict never flushes —
      // the frozen original ships only via an EXPLICIT legal lifecycle
      // flush, never on this submission's authority.
      let enqueuedThisExecution = false;
      for (const item of items) {
        if (!guards()) return;
        // r4 closing group 1: the item's entry capture must EXIST and still
        // be the CURRENT operation before ANY work — a missing target is
        // not a wildcard permission, and an already-superseded item must
        // not even observe (let alone enqueue/note/bind).
        if (!operationCurrent(item)) continue;
        // r3 group 1: the item's OPERATION SNAPSHOT is taken BEFORE its
        // first await and required at EVERY later verdict/patch — an older
        // execution's result (any kind, including a SUCCESSFUL adoption)
        // can never land on a newer same-attempt operation's target. The
        // snapshot is never refreshed to a newer sequence after awaiting.
        // r4 group 1: the item's snapshot IS the ENTRY capture (before any
        // await of this execution) — never refreshed to a newer sequence.
        const opSnapshot = entryOpSeqs.get(item.questionId) ?? undefined;
        const applyVerdict = (
          state: CaptureTargetState,
          adopt?: (t: CaptureTarget) => CaptureTarget,
        ) => setItemState(item.questionId, state, adopt, opSnapshot);
        const precheck = await executor.precheckItem(plan, item, deps);
        if (!guards()) return;
        if (precheck.action === 'confirmed') {
          applyVerdict('uploaded');
          continue; // §3: completed items never re-enqueue
        }
        if (precheck.action === 'learner-stale') {
          // r2 item 6: the resolved learner no longer matches the frozen
          // plan — an honest recoverable error; no cross-partition write.
          applyVerdict('store-error');
          continue;
        }
        if (precheck.action === 'unreadable') {
          // r1 §6: an honest recoverable storage state — never eternal
          // 'saving', never an enqueue as if the scope were absent.
          applyVerdict('store-error');
          continue;
        }
        if (precheck.action === 'conflict') {
          applyVerdict('conflict');
          continue; // another plan owns the scope: recoverable, not empty
        }
        if (precheck.action === 'evidence') {
          if (precheck.evidence.status === 'receipt') {
            // A committed receipt for the exact instance: durable progress
            // first, ledger only on a committed confirm (r1 §6: a failed
            // confirm is a recoverable store-error, not a hang).
            const receiptSide = precheck.evidence.side;
            const fingerprint = outbox.fingerprintOf(item.payload);
            const { actualIdentityFromQueueSide } = await import('@/lib/mistake-book/progress');
            const actual = actualIdentityFromQueueSide(receiptSide, item.eventId, fingerprint);
            if (!guards()) return;
            if (actual !== null) {
              const confirmed = await executor.confirmItemActual(
                plan,
                item,
                actual,
                'receipt',
                deps,
              );
              if (!guards()) return;
              if (confirmed) {
                applyVerdict('uploaded', (target) =>
                  executor.adoptEvidenceSide(target, receiptSide, 'uploaded'),
                );
              } else {
                applyVerdict('store-error');
              }
            }
            continue;
          }
          if (precheck.evidence.status === 'queued') {
            // The queue holds this exact instance — it owns the retry; the
            // ledger adopts the side's COMPLETE real identity (r1 §1) with
            // the state following the side's REAL owner (r2 item 5).
            const queuedSide = precheck.evidence.side;
            applyVerdict('queued', (target) =>
              executor.adoptEvidenceSide(target, queuedSide, 'queued'),
            );
            // Retry continuity (C2-7 contract): an UNBOUND row carrying THIS
            // plan's own once-minted token is the ORIGINAL operation's
            // persisted creation — its bind proof rides this flush exactly
            // like the legacy open-recovery carried the original proofs.
            // A recovery pass still never auto-binds.
            if (
              !bindAsRecovery &&
              entryOriginalCapability &&
              queuedSide.owner === '' &&
              queuedSide.recordToken === item.recordToken
            ) {
              freshUnboundCreations.push({
                eventId: item.eventId,
                creationToken: queuedSide.recordToken,
              });
            }
            continue;
          }
          if (precheck.evidence.status === 'conflict') {
            // Fall through to the enqueue: the outbox classifies by CONTENT
            // (same-content different-instance → legal reuse; different
            // content → the frozen conflict). Not a terminal verdict here.
          } else {
            applyVerdict('store-error'); // evidence unreadable
            continue;
          }
        }
        // action === 'enqueue'
        // r2 item 2: the enqueue owner of a NEW item is resolved FRESH here
        // — AFTER this item's (and any earlier item's) precheck may have
        // recovered and persisted A from the committed journal/progress.
        // Absence is never cached across a helper that can commit
        // authority; a failed repair honestly stops the item.
        let enqueueOwner = plan.originOwner;
        let authorityProof: import('@/lib/mistake-book/progress').AuthorityBindProof | null = null;
        if (plan.originOwner === '') {
          const resolution = await executor.resolveAttemptOwner(plan, deps);
          if (!guards()) return;
          if (resolution.status === 'proven') {
            enqueueOwner = resolution.owner;
            authorityProof = resolution.proof;
          } else if (resolution.status !== 'absent') {
            // UNREADABLE (retryable repair) / CONFLICT: stop the item —
            // never "treat as absent" and create a fresh unbound record
            // that could auto-bind to the current owner.
            applyVerdict('store-error');
            continue;
          }
        }
        // r4 group 1: revalidate the CAPTURED operation before issuing new
        // enqueue/note/bind work — an obsolete execution must not mint queue
        // records or bind privileges even if its UI patch is dropped.
        if (!operationCurrent(item)) continue;
        const outcome = await enqueueWithFrozenOwner(item, enqueueOwner).catch(() => null);
        if (!operationCurrent(item)) continue;
        if (outcome === null || outcome.kind === 'local-failed') {
          // r1 §6: the plan item's retry is the MODERN frozen-plan executor
          // (Retry grading / the retry affordance re-runs it) — never the
          // legacy payload/current-owner capture helper.
          applyVerdict('local-failed');
          continue; // durable plan remains the retry source
        }
        if (outcome.kind === 'conflict') {
          applyVerdict('conflict');
          continue;
        }
        // 'persisted' | 'reused': durably note the REAL queue instance —
        // basis 'attempt-authority' when created directly under the PROVEN
        // attempt owner of an unknown-origin plan (P3 §2).
        enqueuedThisExecution = true;
        const enqueueFingerprint = outbox.fingerprintOf(item.payload);
        if (!operationCurrent(item)) continue; // revalidate before the note
        const noted = await executor.noteEnqueuedActual(
          plan,
          item,
          enqueueFingerprint,
          outcome,
          deps,
          authorityProof !== null && enqueueOwner !== '' ? authorityProof : undefined,
        );
        if (!guards()) return;
        if (!noted) {
          log.warn('Capture-plan pending progress NOT written — honestly retryable');
        }
        // r1 §1 + r2 item 5: the ledger leaves 'saving' and adopts the
        // COMPLETE real identity (handle + fingerprint + token-or-date,
        // other plane cleared); the state follows the REAL enqueue owner —
        // an unbound creation is 'unbound' (claim-only), never a sync
        // promise.
        applyVerdict('queued', (target) =>
          executor.adoptEnqueuedOutcome(target, outcome, enqueueOwner),
        );
        if (outcome.kind === 'persisted' && enqueueOwner === '') {
          freshUnboundCreations.push({
            eventId: outcome.eventId,
            creationToken: outcome.creationToken,
          });
        }
      }
      // Auto-bind proofs: ONLY this ORIGINAL LIVE-EPISODE operation's fresh
      // unbound creations (r2 item 1) — restored attempts and recovery
      // passes NEVER auto-bind; known-origin records are created bound.
      // r4 group 1: the capability is the ENTRY generation and each proof
      // is re-filtered by its item's captured operation still being current
      // — an obsolete execution cannot send bind privileges.
      const bindProofs =
        bindAsRecovery || !entryOriginalCapability
          ? []
          : freshUnboundCreations.filter((proof) => {
              const proofItem = items.find((entryItem) => entryItem.eventId === proof.eventId);
              return proofItem !== undefined && operationCurrent(proofItem);
            });
      if (!enqueuedThisExecution) {
        // Nothing this execution enqueued or re-enqueued: no flush on its
        // authority (all-conflict/all-confirmed submissions included).
        return;
      }
      const report = await outbox.flushOutbox(
        bindProofs.length > 0 ? { bindNewEvents: bindProofs } : {},
      );
      if (!guards()) return;
      await consumePlanFlushRef.current(plan, report);
      // r1 §6: an EMPTY report with undecided items is not silent success —
      // surface an unconfigured deployment honestly (probe 503).
      const reportEmpty =
        report.uploaded.length === 0 &&
        report.committedBinds.length === 0 &&
        report.failed.length === 0 &&
        report.rejected.length === 0 &&
        report.conflicts.length === 0 &&
        report.parked.length === 0 &&
        report.unbound.length === 0;
      if (reportEmpty && items.length > 0) {
        const undecided = items.some((item) => {
          const state = captureLedgerRef.current.get(item.questionId)?.state;
          return state === 'queued' || state === 'parked' || state === 'unbound';
        });
        if (undecided) {
          const status = await outbox.outboxStatus().catch(() => null);
          if (guards() && status !== null && status.unconfigured) {
            for (const item of items) {
              const state = captureLedgerRef.current.get(item.questionId)?.state;
              if (state === 'queued' || state === 'parked' || state === 'unbound') {
                // r4 group 1: the late 503 pass uses the SAME entry
                // snapshots — an old unconfigured result cannot downgrade a
                // newer operation's target. r4 closing: a MISSING entry
                // capture is not a wildcard either, so the sweep skips the
                // item entirely instead of patching it unguarded.
                const entrySeq = entryOpSeqs.get(item.questionId);
                if (entrySeq === null || entrySeq === undefined) continue;
                setItemState(item.questionId, 'unconfigured', undefined, entrySeq);
              }
            }
          }
        }
      }
      // consumePlanFlush is ref-stable (defined below); recompute stable.
    },
    [recomputeCaptureNotice],
  );
  executeCapturePlanRef.current = executeCapturePlan;

  /** Enqueue one plan item under its FROZEN owner (no cache re-derivation). */
  const enqueueWithFrozenOwner = async (
    item: QuizCapturePlanItem,
    frozenOwner: string,
  ): Promise<FrozenOwnerEnqueueOutcome> => {
    const outbox = await import('@/lib/mistake-book/outbox');
    return outbox.enqueueCaptureEventUnderOwner(item.payload, frozenOwner, {
      creationToken: item.recordToken,
    });
  };

  const consumePlanFlushRef = useRef<
    (
      plan: QuizCapturePlan,
      report: Awaited<ReturnType<(typeof import('@/lib/mistake-book/outbox'))['flushOutbox']>>,
    ) => Promise<void>
  >(async () => {});
  /**
   * Consume one flush report for the plan items — the SHARED strict rules
   * (P3 §3) live in plan-executor.consumeReportForPlan: committed mappings
   * first (progress migration + attempt-authority wiring), then verdicts,
   * then strict receipts; ledger 'uploaded' claims land only AFTER the
   * durable progress confirm committed. This wrapper only supplies the
   * component's ledger/guards.
   */
  const consumePlanFlush = async (
    plan: QuizCapturePlan,
    report: Awaited<ReturnType<(typeof import('@/lib/mistake-book/outbox'))['flushOutbox']>>,
  ) => {
    const executor = await import('@/lib/mistake-book/plan-executor');
    await executor.consumeReportForPlan(plan, report, {
      getLearnerKey: resolveLearnerKey,
      stillCurrent: () => mountedRef.current && attemptIdRef.current === plan.attemptId,
      getTarget: (questionId) => captureLedgerRef.current.get(questionId),
      patchLedger: (questionId, patch) => {
        const target = captureLedgerRef.current.get(questionId);
        if (!target) return;
        // r2 item 6: the ONE shared patch rule — a patch from a superseded
        // operation never lands; terminal facts survive late verdicts.
        const next = executor.applyPlanLedgerPatch(target, patch);
        if (next === null) return;
        captureLedgerRef.current.set(questionId, next);
        recomputeCaptureNotice();
      },
    });
  };
  consumePlanFlushRef.current = consumePlanFlush;

  // When entering grading phase, grade choice questions locally + call API for short-answer
  useEffect(() => {
    if (phase !== 'grading') return;
    let cancelled = false;

    (async () => {
      // Grading recovery re-uses every CONFIRMED verdict from the previous
      // pass and re-asks the AI only for questions still undecided — a retry
      // after "grading unavailable" cannot shake an already-earned score.
      const confirmed = new Map<string, QuestionResult>();
      for (const r of resultsRef.current) {
        if (r.correct === true || r.correct === false) confirmed.set(r.questionId, r);
      }

      // 1. Grade choice questions locally (instant, deterministic)
      const choiceResults = gradeChoiceQuestions(questions, answers);

      // 2. Grade short-answer questions via AI API (parallel) — only the
      // undecided ones; decided ones are final for this attempt.
      const shortAnswerQs = questions.filter((q) => isShortAnswer(q) && !confirmed.has(q.id));
      const aiResults = await Promise.all(
        shortAnswerQs.map((q) =>
          gradeShortAnswerQuestion(q, (answers[q.id] as string) ?? '', locale),
        ),
      );

      if (cancelled) return;

      // 3. Merge results in original question order
      const allResultsMap = new Map<string, QuestionResult>();
      for (const r of [...choiceResults, ...aiResults]) {
        allResultsMap.set(r.questionId, r);
      }
      for (const [questionId, result] of confirmed) {
        if (!allResultsMap.has(questionId)) allResultsMap.set(questionId, result);
      }
      const ordered = questions.map((q) => allResultsMap.get(q.id)!).filter(Boolean);

      if (!attemptId) {
        setRuntimeGate({ status: 'error' });
        return;
      }
      // CAPTURE PLAN v1 (Codex intent-design §2): freeze the per-question
      // plan (attempt/scene/event/payload/originOwner/token) and persist it
      // WITH the review in the SAME runtime fact — a refresh after this
      // commit always finds the plan. No identity probe, POST, or flush is
      // awaited to reach this point; the plan executes in the background.
      orderedResultsRef.current = ordered;
      let planItems: QuizCapturePlan | null = null;
      try {
        // Plan build INSIDE the review's error gate (P1 addendum): a learner
        // fetch failure here surfaces as the runtime error path — never an
        // unhandled rejection or a stuck grading phase.
        const stageNow = useStageStore.getState().stage;
        const originOwner = currentConfirmedOwnerForPlan();
        planItems = await buildCapturePlan(ordered, {
          attemptId,
          sceneId,
          stageName: stageNow?.name ?? '',
          sceneTitle,
          sceneOrder,
          subject: stageNow?.subject,
          gradeSemester: stageNow?.gradeSemester,
          originOwner,
        });
        if (cancelled) return;
        if (attemptIdRef.current !== attemptId) return;
        const reviewCommitted = await persistQuizReview(
          {
            stageId,
            sceneId,
            attemptId,
            answers,
            results: ordered,
            // The plan OBJECT (header + items; possibly EMPTY items) marks
            // this as a new-pipeline review; legacy reviews carry no field.
            capturePlan: planItems,
          },
          runtimeWriter,
        );
        void reviewCommitted;
      } catch (error) {
        log.warn('Failed to persist quiz review:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
        return;
      }
      // ADOPT only after the review committed AND the operation is still
      // current (P1 final): a superseded build never touches the shared ref.
      if (cancelled || attemptIdRef.current !== attemptId) return;
      planRef.current = planItems;
      if (planItems === null) return; // gate already surfaced the failure
      setResults(ordered);
      setPhase('reviewing');
      // §2.3/§2.4: register all plan targets in the attempt ledger, then
      // execute the plan in the background (enqueue + flush + receipts).
      registerPlanInLedger(planItems.items);
      void executeCapturePlan(planItems);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    phase,
    questions,
    answers,
    locale,
    sceneId,
    stageId,
    attemptId,
    runtimeWriter,
    sceneTitle,
    sceneOrder,
    mergeCaptureResult,
    recomputeCaptureNotice,
    buildCapturePlan,
    executeCapturePlan,
    registerPlanInLedger,
  ]);

  /** Shared capture runner (post-grading enqueue + post-hydration recovery). */
  const runCaptureRef = useRef<
    (
      ordered: QuestionResult[],
      attemptId: string | null,
      answers: Record<string, string | string[]>,
      options?: { localOnly?: boolean },
    ) => Promise<{ network: () => Promise<void> } | undefined>
  >(async () => undefined);
  const runCapture = async (
    ordered: QuestionResult[],
    captureAttemptId: string | null,
    captureAnswers: Record<string, string | string[]>,
    options: { localOnly?: boolean } = {},
  ) => {
    // Mistake book capture: never blocks the review flow. Dedup keys mark
    // a question captured ONLY after its event is DURABLY persisted — a
    // local-write failure un-marks it so the same mount can retry, and an
    // offline/network-unknown capture stays marked (the durable queue owns
    // the retry). Server-side idempotency by event id is live (R9).
    const stage = useStageStore.getState().stage;
    if (!stage?.name) return;
    const attemptId = captureAttemptId;
    if (!attemptId) return undefined;
    const captureAttempt = attemptId;
    const run = async () => {
      const { buildMistakeCapturePayload, captureMistakesFromQuiz } =
        await import('@/lib/mistake-book/client-reexport');
      const fresh = ordered.filter((result) => {
        if (result.status !== 'incorrect' || result.correct !== false) return false;
        const key = `${attemptId}:${result.questionId}`;
        if (capturedRef.current.has(key)) return false;
        return true;
      });
      const payload = buildMistakeCapturePayload(questions, captureAnswers, fresh, {
        stageId,
        stageName: stage.name,
        attemptId,
        sceneId,
        ...(sceneTitle ? { sceneTitle } : {}),
        ...(sceneOrder !== undefined ? { sceneOrder } : {}),
        ...(stage.subject ? { subject: stage.subject } : {}),
        ...(stage.gradeSemester ? { gradeSemester: stage.gradeSemester } : {}),
      });
      if (!payload) return undefined;
      // Tentatively mark, then un-mark the targets that did not persist
      // so THIS mount can retry exactly those (same events).
      const keys = fresh.map((result) => `${attemptId}:${result.questionId}`);
      for (const key of keys) capturedRef.current.add(key);
      const opSeq = ++captureOpSeqRef.current;
      // ASYNC REGISTRATION (C2 design): every target enters the ledger as
      // 'saving' the moment its operation starts. While q1's capture is
      // still awaiting, a later operation's result for q2 can never make
      // the attempt read fully synced — and 'saving' claims nothing.
      for (const result of fresh) {
        captureLedgerRef.current.set(result.questionId, {
          questionId: result.questionId,
          eventId: questionEventIdOf(attemptId, result.questionId),
          state: 'saving',
          opSeq,
        });
      }
      recomputeCaptureNotice();
      // PHASE SPLIT: localOnly callers await just the DURABLE ENQUEUE (the
      // events are frozen in the outbox); the network flush is returned as
      // a continuation so grading never blocks on it.
      if (options.localOnly) {
        const outbox = await import('@/lib/mistake-book/outbox');
        const creations: Array<{ eventId: string; creationToken: string }> = [];
        for (const event of payload.items) {
          const outcome = await outbox.enqueueCaptureEvent({
            ...payload,
            eventId: event.eventId,
            items: [event],
          });
          if (outcome.kind === 'persisted') {
            creations.push({ eventId: outcome.eventId, creationToken: outcome.creationToken });
          }
        }
        const network = async () => {
          const flushResult = await captureMistakesFromQuiz(payload, {
            recoveryProofs: creations,
          });
          if (!mountedRef.current) return;
          if (attemptIdRef.current !== captureAttempt) return;
          mergeCaptureResult(flushResult, opSeq);
          if (flushResult.status === 'local-failed') {
            for (const question of flushResult.questions) {
              if (question.state === 'local-failed') {
                capturedRef.current.delete(`${captureAttempt}:${question.questionId}`);
              }
            }
            openRecoveriesRef.current.push({
              payload,
              proofs: flushResult.recoveryProofs,
            });
          }
          recomputeCaptureNotice();
        };
        return { network };
      }
      const result = await captureMistakesFromQuiz(payload);
      // Mount + attempt guards (C2 design §课堂消费): phase changes re-run
      // this effect but do NOT unmount; a REAL re-answer (attempt id
      // changed) orphans this result entirely.
      if (!mountedRef.current) return;
      if (attemptIdRef.current !== captureAttempt) return;
      mergeCaptureResult(result, opSeq);
      if (result.status === 'local-failed') {
        for (const question of result.questions) {
          if (question.state === 'local-failed') {
            capturedRef.current.delete(`${captureAttempt}:${question.questionId}`);
          }
        }
        // Keep the VERBATIM original operation (payload + the proofs it
        // holds): the retry re-sends the SAME events — persisted targets
        // reuse their records (C1), nothing double-counts, no new ids.
        openRecoveriesRef.current.push({ payload, proofs: result.recoveryProofs });
        log.warn('Mistake capture NOT saved locally — retry available');
      }
      recomputeCaptureNotice();
      return undefined;
    };
    if (options.localOnly) {
      return run();
    }
    void run();
    return undefined;
  };
  runCaptureRef.current = runCapture;

  // Same-event recovery for a local-failed capture (C2 design): re-send the
  // OLDEST open operation VERBATIM — same attempt, same event ids, same
  // frozen content — carrying that operation's OWN creation proofs so
  // binding continues for exactly its proof-matched records. Persisted
  // targets reuse their records (no double count); unknown older events stay
  // claim-only. When every target of the operation is confirmed, it closes.
  const retryCaptureSave = useCallback(async () => {
    // r1 §6: MODERN plan items retry through the frozen-plan executor —
    // the same plan, identities, and authority rules as the original run;
    // never the legacy payload/current-owner capture helper.
    const plan = planRef.current;
    if (plan !== null && plan.attemptId === attemptIdRef.current) {
      const hasPlanWork = plan.items.some((item) => {
        const state = captureLedgerRef.current.get(item.questionId)?.state;
        return state === 'local-failed' || state === 'store-error';
      });
      if (hasPlanWork) {
        const opSeq = ++captureOpSeqRef.current;
        for (const item of plan.items) {
          const state = captureLedgerRef.current.get(item.questionId)?.state;
          if (state === 'local-failed' || state === 'store-error') {
            captureLedgerRef.current.set(item.questionId, {
              questionId: item.questionId,
              eventId: item.eventId,
              state: 'saving',
              opSeq,
            });
          }
        }
        recomputeCaptureNotice();
        await executeCapturePlanRef.current(plan);
        return;
      }
    }
    const open = openRecoveriesRef.current[0];
    if (!open) return;
    const retryAttempt = attemptIdRef.current;
    const { captureMistakesFromQuiz } = await import('@/lib/mistake-book/client-reexport');
    const opSeq = ++captureOpSeqRef.current;
    for (const item of open.payload.items) {
      captureLedgerRef.current.set(item.questionId, {
        questionId: item.questionId,
        eventId: item.eventId,
        state: 'saving',
        opSeq,
      });
    }
    recomputeCaptureNotice();
    const result = await captureMistakesFromQuiz(open.payload, {
      recoveryProofs: open.proofs,
    });
    // Mount + attempt guards: a result landing after a REAL re-answer
    // describes an attempt nobody is looking at.
    if (!mountedRef.current) return;
    if (attemptIdRef.current !== retryAttempt) return;
    mergeCaptureResult(result, opSeq);
    // ALSO fold the per-question verdict into the PLAN ledger (the recovery
    // payload's questions may not be in captureMistakesFromQuiz's own ledger
    // shape) so the derived pill matches the real per-question state.
    for (const question of result.questions) {
      const planTarget = captureLedgerRef.current.get(question.questionId);
      if (planTarget && !(planTarget.state === 'uploaded' && question.state !== 'uploaded')) {
        captureLedgerRef.current.set(question.questionId, {
          ...planTarget,
          ...(question.handle !== undefined ? { handle: question.handle } : {}),
          ...(question.fingerprint !== undefined ? { fingerprint: question.fingerprint } : {}),
          ...(question.recordToken !== undefined ? { recordToken: question.recordToken } : {}),
          state: question.state === 'local-failed' ? 'local-failed' : question.state,
        });
      }
    }
    if (result.status === 'local-failed') {
      for (const question of result.questions) {
        if (question.state === 'local-failed') {
          capturedRef.current.delete(`${retryAttempt}:${question.questionId}`);
        }
      }
      // Refresh the operation's proofs (the retry holds the merged set) and
      // keep it open for the next retry.
      open.proofs = result.recoveryProofs;
    } else {
      // The operation's content is fully decided now (any outcome other
      // than local-failed means every target is at least durable): close it.
      openRecoveriesRef.current = openRecoveriesRef.current.filter((entry) => entry !== open);
      if (result.status === 'uploaded') {
        for (const item of open.payload.items) {
          capturedRef.current.add(`${retryAttempt}:${item.questionId}`);
        }
      }
    }
    recomputeCaptureNotice();
  }, [mergeCaptureResult, recomputeCaptureNotice]);

  // Lifecycle flush (C2 design §课堂消费): mount + connectivity retries.
  // Confirmation is PER TARGET and by REAL record identity (key or committed
  // boundFrom alias — never a bare eventId): another owner's old upload under
  // the same id confirms nothing here. Partial confirmations keep the honest
  // per-question states; the pill only says uploaded when EVERY target of
  // the attempt is uploaded (and local-failed/conflict/unbound dominate).
  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      // Freeze the async guards up front (closing gate #2): every await in
      // this flow re-checks mount AND attempt; receipt confirmations also
      // re-check each target's opSeq so an old flush can never land on a
      // newer operation's or attempt's ledger.
      const flushAttempt = attemptIdRef.current;
      try {
        const { flushOutbox } = await import('@/lib/mistake-book/outbox');
        const report = await flushOutbox();
        if (cancelled || attemptIdRef.current !== flushAttempt) return;
        // NO empty-report early return (closing gate #2): a record already
        // uploaded AND deleted by an EARLIER flush makes this report empty —
        // the receipt replay below must still run.
        if (report.uploaded.length > 0) {
          window.dispatchEvent(new CustomEvent('openmaic:mistakes-changed'));
        }
        // r1 §2: MODERN-plan items go through the SHARED full consumer —
        // the report drives the durable progress commits and the attempt
        // authority BEFORE any ledger change (mapping → upload/refused →
        // pending facts → strict receipts, terminal states preserved).
        const executor = await import('@/lib/mistake-book/plan-executor');
        const plan = planRef.current;
        if (plan !== null && plan.attemptId === flushAttempt && plan.items.length > 0) {
          await executor.consumeReportForPlan(plan, report, {
            getLearnerKey: resolveLearnerKey,
            stillCurrent: () => !cancelled && attemptIdRef.current === flushAttempt,
            getTarget: (questionId) => captureLedgerRef.current.get(questionId),
            patchLedger: (questionId, patch) => {
              const target = captureLedgerRef.current.get(questionId);
              if (!target) return;
              const next = executor.applyPlanLedgerPatch(target, patch);
              if (next === null) return;
              captureLedgerRef.current.set(questionId, next);
            },
          });
          if (cancelled || attemptIdRef.current !== flushAttempt) return;
          recomputeCaptureNotice();
        }
        let changed = false;
        // SHARED full-identity matcher (P3 §3): key + fingerprint + the
        // token-or-createdAt instance plane, fail-closed on absent metadata —
        // a same-key different-instance verdict never applies, and a
        // metadata-less verdict is never a proof. This walk now serves ONLY
        // the leftovers (legacy no-plan capture outcomes the modern plan
        // consumer did not cover).
        const { strictInstanceMatches } = executor;
        const coveredByPlan = new Set(
          plan !== null && plan.attemptId === flushAttempt
            ? plan.items.map((item) => item.questionId)
            : [],
        );
        const findByIdentity = (entry: {
          key: string;
          boundFrom?: string;
          fingerprint?: string;
          recordToken?: string | null;
          createdAt?: number;
        }) =>
          [...captureLedgerRef.current.values()]
            .filter((candidate) => !coveredByPlan.has(candidate.questionId))
            .find((candidate) => strictInstanceMatches(entry, candidate));
        // Apply the pass's identity verdicts FIRST (addendum): parked and
        // unbound entries flip still-queued targets NOW, so the receipt
        // replay below can never lend an old receipt to a record THIS pass
        // just parked.
        for (const entry of report.parked) {
          const target = findByIdentity(entry);
          if (target && target.state === 'queued') {
            captureLedgerRef.current.set(target.questionId, { ...target, state: 'parked' });
            changed = true;
          }
        }
        for (const entry of report.unbound) {
          const target = findByIdentity(entry);
          if (target && target.state === 'queued') {
            captureLedgerRef.current.set(target.questionId, { ...target, state: 'unbound' });
            changed = true;
          }
        }
        // Committed bind migrations (r1 §3): FULL source matching (key +
        // fingerprint + instance plane) and FULL destination adoption — a
        // legacy destination CLEARS the old token and keeps its real date.
        for (const mapping of report.committedBinds) {
          for (const target of captureLedgerRef.current.values()) {
            if (coveredByPlan.has(target.questionId)) continue;
            if (strictInstanceMatches(mapping.source, target)) {
              captureLedgerRef.current.set(target.questionId, {
                ...target,
                handle: mapping.destination.key,
                ...(mapping.destination.recordToken != null
                  ? {
                      recordToken: mapping.destination.recordToken,
                      recordCreatedAt: undefined,
                    }
                  : {
                      recordToken: undefined,
                      ...(mapping.destination.createdAt !== undefined
                        ? { recordCreatedAt: mapping.destination.createdAt }
                        : {}),
                    }),
              });
              changed = true;
            }
          }
        }
        for (const target of captureLedgerRef.current.values()) {
          if (coveredByPlan.has(target.questionId)) continue;
          if (target.state === 'uploaded' || target.handle === undefined) continue;
          const uploaded = report.uploaded.find((entry) => strictInstanceMatches(entry, target));
          if (uploaded) {
            captureLedgerRef.current.set(target.questionId, {
              ...target,
              handle: uploaded.key, // committed alias → the record's real key
              state: 'uploaded',
            });
            changed = true;
            continue;
          }
          const refused =
            report.rejected.find((entry) => strictInstanceMatches(entry, target)) ??
            report.conflicts.find((entry) => strictInstanceMatches(entry, target));
          if (refused && target.state !== 'conflict') {
            captureLedgerRef.current.set(target.questionId, {
              ...target,
              state: 'conflict',
            });
            changed = true;
          }
        }
        if (changed) recomputeCaptureNotice();
        // Receipt confirmation (C2 design): a record already committed AND
        // deleted by an earlier flush never appears in this report — its
        // owner-scoped receipt is the reliable per-record confirmation.
        // ONLY 'queued' targets (durable under the current owner, identity
        // consistent): a parked target is an identity fact of THIS pass that
        // an old same-key receipt from a previous record must not overwrite
        // (closing-gate #2 addendum). Plan items were receipt-confirmed by
        // the shared consumer (with durable progress); this replay covers
        // the LEGACY leftovers only.
        const pending = [...captureLedgerRef.current.values()].filter(
          (target) =>
            !coveredByPlan.has(target.questionId) &&
            target.state === 'queued' &&
            target.handle !== undefined &&
            target.fingerprint !== undefined,
        );
        if (pending.length > 0) {
          const { readReceipts } = await import('@/lib/mistake-book/outbox');
          const confirmed = await readReceipts(
            pending.map((target) => ({
              key: target.handle!,
              fingerprint: target.fingerprint!,
              // The record's OWN token: a receipt from any other instance at
              // the same key/content confirms nothing here.
              recordToken: target.recordToken ?? null,
              ...(target.recordCreatedAt !== undefined
                ? { createdAt: target.recordCreatedAt }
                : {}),
            })),
          );
          // Post-await guards: mount, attempt, and per-target opSeq — the
          // receipt answers describe the world as it was when queried.
          if (cancelled || attemptIdRef.current !== flushAttempt) return;
          let receiptChanged = false;
          if (confirmed.ok) {
            // Only strictly matched rows (their own full identity) confirm;
            // ok === false (unreadable receipts) proves nothing — no change.
            const confirmedKeys = new Set(confirmed.matched.map((side) => side.key));
            for (const target of pending) {
              const current = captureLedgerRef.current.get(target.questionId);
              if (
                current === undefined ||
                current.opSeq !== target.opSeq ||
                current.handle !== target.handle ||
                current.state !== 'queued'
              ) {
                continue; // superseded, already decided, or identity-guarded since
              }
              if (confirmedKeys.has(target.handle!)) {
                captureLedgerRef.current.set(target.questionId, {
                  ...current,
                  state: 'uploaded',
                });
                receiptChanged = true;
              }
            }
          }
          if (receiptChanged) recomputeCaptureNotice();
        }
      } catch {
        /* offline flushes retry on the next trigger */
      }
    };
    void flush();
    window.addEventListener('online', flush);
    return () => {
      cancelled = true;
      window.removeEventListener('online', flush);
    };
  }, [recomputeCaptureNotice]);

  const handleRetry = useCallback(async () => {
    if (!attemptId || retrying) return;
    setRetrying(true);
    runtimeWriter.cancelDraft();
    let retryReceipt: import('@/lib/quiz/view-state').QuizRetryCreationReceipt | null = null;
    await runQuizPersistenceTransition(
      async () => {
        retryReceipt = await persistQuizRetry({ stageId, sceneId, attemptId }, runtimeWriter);
      },
      viewLifetime,
      () => {
        // The durable child retry session now exists in the store; adopt ITS
        // identity instead of silently keeping the completed root id — a
        // fresh hydration lands the new active attempt (empty draft), and
        // the capture dedup keys on the new attempt id, so the second real
        // wrong answer is a genuinely new event.
        // r4 group 2: store the TYPED receipt naming the EXACT child this
        // locked write created (or null when it created nothing) — the
        // hydration redeems it for exactly that child, nothing else.
        pendingCreationTicketRef.current = retryReceipt;
        capturedRef.current.clear();
        setPhase('not_started');
        setAnswers({});
        setResults([]);
        setHydrationVersion((version) => version + 1);
      },
      (error) => {
        log.warn('Failed to persist quiz retry:', error);
        setRetrying(false);
        if (error instanceof QuizRetryProgressedError) {
          setHydrationVersion((version) => version + 1);
          return;
        }
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, retrying, runtimeWriter, sceneId, stageId, viewLifetime]);

  const earnedScore = useMemo(() => results.reduce((sum, r) => sum + r.earned, 0), [results]);

  const resultMap = useMemo(() => {
    const map: Record<string, QuestionResult> = {};
    results.forEach((r) => {
      map[r.questionId] = r;
    });
    return map;
  }, [results]);

  if (runtimeGate.status === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => setHydrationVersion((version) => version + 1)}
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
        >
          <RotateCcw className="h-4 w-4" />
          {t('quiz.retry')}
        </button>
      </div>
    );
  }

  if (!isQuizRuntimeReady(runtimeGate)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col">
      <AnimatePresence mode="wait">
        {phase === 'not_started' && (
          <motion.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1"
          >
            <QuizCover
              questionCount={questions.length}
              totalPoints={totalPoints}
              onStart={() => setPhase('answering')}
            />
          </motion.div>
        )}

        {phase === 'answering' && (
          <motion.div
            key="answering"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <PieChart className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.answering')}
                </span>
                <span className="text-xs text-gray-400 ml-1">
                  {
                    Object.keys(answers).filter((k) => {
                      const a = answers[k];
                      if (Array.isArray(a)) return a.length > 0;
                      return typeof a === 'string' && a.trim().length > 0;
                    }).length
                  }{' '}
                  / {questions.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!allAnswered}
                className={cn(
                  'px-4 py-1.5 rounded-lg text-xs font-medium transition-all',
                  allAnswered
                    ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-sm hover:shadow-md hover:shadow-violet-200/50 dark:hover:shadow-violet-900/50 active:scale-[0.97]'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed',
                )}
              >
                {t('quiz.submitAnswers')}
              </button>
            </div>

            {/* Questions */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {questions.map((q, i) => {
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={(v) => handleSetAnswer(q.id, v)}
                  />
                );
              })}
            </div>
          </motion.div>
        )}

        {(phase === 'submitting' || phase === 'grading') && (
          <motion.div
            key="grading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center gap-5"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            >
              <Loader2 className="w-10 h-10 text-violet-500" />
            </motion.div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                {t('quiz.aiGrading')}
              </p>
              <p className="text-sm text-gray-400 mt-1">{t('quiz.aiGradingWait')}</p>
            </div>
            <div className="flex gap-1 mt-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-2 h-2 rounded-full bg-violet-400"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{
                    repeat: Infinity,
                    duration: 1.2,
                    delay: i * 0.2,
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {phase === 'reviewing' && (
          <motion.div
            key="reviewing"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.quizReport')}
                </span>
                {captureNotice && (
                  <span
                    className={cn(
                      'ml-1 text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1',
                      captureNotice === 'uploaded'
                        ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-300'
                        : captureNotice === 'queued' ||
                            captureNotice === 'unbound' ||
                            captureNotice === 'unconfigured'
                          ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-300'
                          : 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-300',
                    )}
                  >
                    {captureNotice === 'uploaded'
                      ? t('quiz.captureUploaded')
                      : captureNotice === 'queued'
                        ? t('quiz.captureQueued')
                        : captureNotice === 'unbound'
                          ? t('quiz.captureUnbound')
                          : captureNotice === 'conflict'
                            ? t('quiz.captureConflict')
                            : captureNotice === 'unconfigured'
                              ? t('quiz.captureUnconfigured')
                              : captureNotice === 'store-error'
                                ? t('quiz.captureStoreError')
                                : t('quiz.captureLocalFailed')}
                    {(captureNotice === 'local-failed' || captureNotice === 'store-error') &&
                      captureRetryable && (
                        <button
                          type="button"
                          onClick={() => void retryCaptureSave()}
                          className="underline underline-offset-1 font-semibold"
                        >
                          {t('quiz.captureRetrySave')}
                        </button>
                      )}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={retrying}
                className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('quiz.retry')}
              </button>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <ScoreBanner
                score={earnedScore}
                total={totalPoints}
                results={results}
                onRetryGrading={() => {
                  // Honest recovery: re-enter the grading phase for whatever
                  // is still undecided (AI unavailable, or a legacy null).
                  setPhase('grading');
                }}
              />

              {questions.map((q, i) => {
                const r = resultMap[q.id];
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={() => {}}
                    disabled
                    result={r}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
