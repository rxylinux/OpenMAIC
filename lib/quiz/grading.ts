import type { QuizQuestion } from '@/lib/types/stage';

/**
 * A graded question. `correct` is null exactly when the grading could not be
 * decided (`status: 'ungraded'`) — an absent AI verdict, or a choice question
 * whose stored answer key cannot be verified (missing/unknown/ambiguous/
 * duplicated). Undecided results must never enter the mistake book and never
 * mark an answer wrong in the UI.
 *
 * Legacy runtime payloads predate 'ungraded' and carry AI-unavailable
 * questions as `{ correct: null, status: 'incorrect' }`; readers must treat
 * `correct === null` as undecided regardless of the legacy status string —
 * see {@link isUngradedResult}.
 */
export interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect' | 'ungraded';
  earned: number;
  aiComment?: string;
}

/** True when this result carries NO verdict (new 'ungraded' or legacy null). */
export function isUngradedResult(result: QuestionResult): boolean {
  return result.status === 'ungraded' || result.correct === null;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Whether a question is graded as open text (AI) rather than by exact
 * answer-key match. Classification is by the explicit `type` only: an
 * unanswered choice question (empty `answer`) is still a choice question and
 * must not be re-routed to AI grading. `hasAnswer` does not override the type.
 */
export function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === 'short_answer';
}

export interface ChoiceOptionLike {
  value: string;
  label: string;
}

/**
 * Resolve a STORED answer key to the exact set of correct option VALUES, or
 * null when the key cannot be verified. This is the single fail-closed
 * resolver shared by classroom grading, review highlighting, and the mistake
 * book's in-place retry — one semantics everywhere.
 *
 * An entry resolves only by exact alignment: it equals exactly one option
 * VALUE, or exactly one option LABEL. Anything else fails closed:
 * - a missing key (no entries) can never be verified;
 * - an entry matching no option, or matching several labels equally, stays
 *   unresolved — the raw string is NEVER treated as a parsed key;
 * - key entries must be non-empty strings — a coerced null/0 is not a label;
 * - the OPTION VALUES themselves must be pairwise unique: a value shared by
 *   two options identifies neither, so no key over such options is
 *   verifiable, not even through a unique label;
 * - entries that resolve to duplicate values (two keys naming one option) are
 *   ambiguous data, not a two-answer key;
 * - a single-choice question with more than one key entry is inconsistent.
 */
export function resolveChoiceKey(
  options: readonly ChoiceOptionLike[],
  key: readonly unknown[],
  type?: 'single' | 'multiple' | 'short_answer',
): string[] | null {
  const optionValues = new Set<string>();
  for (const option of options) {
    if (typeof option?.value !== 'string' || option.value === '') return null;
    if (optionValues.has(option.value)) return null; // duplicate value: ambiguous options
    optionValues.add(option.value);
  }
  if (key.length === 0) return null;
  const values: string[] = [];
  for (const entry of key) {
    if (typeof entry !== 'string' || entry === '') return null;
    const valueMatches = options.filter((o) => o.value === entry);
    if (valueMatches.length === 1) {
      values.push(valueMatches[0].value);
      continue;
    }
    const labelMatches = options.filter((o) => o.label === entry);
    if (labelMatches.length === 1) {
      values.push(labelMatches[0].value);
      continue;
    }
    return null; // unknown, or ambiguous between equally-matching options
  }
  if (new Set(values).size !== values.length) return null; // duplicate targets
  if (type !== 'multiple' && values.length > 1) return null; // single with multi key
  return values;
}

/**
 * Exact, unique alignment of ONE stored answer-key entry to an option value.
 * Kept for callers that probe a single entry; unverifiable entries return the
 * raw input so callers can tell them apart from values — grading paths must
 * use {@link resolveChoiceKey} instead, which fails closed.
 */
export function resolveAnswerKeyToValue(q: QuizQuestion, answer: string): string {
  const resolved = resolveChoiceKey(q.options ?? [], [answer], q.type);
  return resolved ? resolved[0]! : answer;
}

/**
 * Grade one choice submission against a verified key. Order-insensitive for
 * multiple choice; an INVALID submission (values the UI never offered) simply
 * does not equal the key — wrong, not lenient. A null key is ungradable.
 */
export function gradeChoiceSubmission(
  resolvedKey: string[] | null,
  submission: readonly string[],
): 'correct' | 'incorrect' | 'ungraded' {
  if (resolvedKey === null) return 'ungraded';
  return arraysEqual([...submission], resolvedKey) ? 'correct' : 'incorrect';
}

/**
 * Review-UI projection of the same fail-closed resolver used for grading:
 * whether an option's value is among the question's VERIFIED correct values.
 * An unverifiable key highlights nothing — no fabricated correctness.
 */
export function answerIncludesOption(q: QuizQuestion, optionValue: string): boolean {
  const key = resolveChoiceKey(q.options ?? [], toArray(q.answer), q.type);
  return key !== null && key.includes(optionValue);
}

/** Whether the question's stored key can be verified at all (for UI badges). */
export function hasVerifiableChoiceKey(q: QuizQuestion): boolean {
  return resolveChoiceKey(q.options ?? [], toArray(q.answer), q.type) !== null;
}

/**
 * Validate a raw AI-grading response body into an earned score. Fail closed on
 * anything but a finite number: null/undefined, strings, NaN, ±Infinity are
 * all "no verdict", never a zero-mark mistake.
 */
export function parseAiGradeScore(
  raw: unknown,
  points: number,
): { earned: number; comment?: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const score = (raw as { score?: unknown }).score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const comment = (raw as { comment?: unknown }).comment;
  const earned = Math.max(0, Math.min(points, score));
  return {
    earned,
    ...(typeof comment === 'string' && comment ? { comment } : {}),
  };
}

/** Grade choice questions locally. Returns results only for non-short-answer questions. */
export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): QuestionResult[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = q.points ?? 1;
      // Fail closed on the STORED key (missing/unknown/ambiguous/duplicate
      // entries cannot be graded); the submission is compared as-is — the UI
      // produces option values, and accepting a label here would let any
      // alias the key tolerates be submitted as a different option.
      const key = resolveChoiceKey(q.options ?? [], toArray(q.answer), q.type);
      // Compatibility resolution applies to the persisted key only.
      const outcome = gradeChoiceSubmission(key, toArray(answers[q.id]));
      if (outcome === 'ungraded') {
        return { questionId: q.id, correct: null, status: 'ungraded' as const, earned: 0 };
      }
      return {
        questionId: q.id,
        correct: outcome === 'correct',
        status: outcome,
        earned: outcome === 'correct' ? pts : 0,
      };
    });
}
