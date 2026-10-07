/**
 * R5/R6 formal tests: the canonical choice grader fails closed, AI grade
 * responses validate strictly, and undecided verdicts never become mistakes.
 */
import { describe, expect, it } from 'vitest';

import {
  answerIncludesOption,
  gradeChoiceQuestions,
  gradeChoiceSubmission,
  hasVerifiableChoiceKey,
  isUngradedResult,
  parseAiGradeScore,
  resolveChoiceKey,
  type QuestionResult,
} from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';

const OPTS = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

function q(overrides: Partial<QuizQuestion>): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: '?',
    options: OPTS,
    answer: ['a'],
    hasAnswer: true,
    points: 1,
    ...overrides,
  };
}

describe('resolveChoiceKey (fail closed)', () => {
  it('resolves exact value keys and exact unique label keys', () => {
    expect(resolveChoiceKey(OPTS, ['a'], 'single')).toEqual(['a']);
    expect(resolveChoiceKey(OPTS, ['A'], 'single')).toEqual(['a']);
    expect(resolveChoiceKey(OPTS, ['A', 'b'], 'multiple')).toEqual(['a', 'b']);
  });

  it('rejects missing, unknown, ambiguous and duplicate keys', () => {
    expect(resolveChoiceKey(OPTS, [], 'single')).toBeNull(); // no key at all
    expect(resolveChoiceKey(OPTS, ['数学'], 'single')).toBeNull(); // unknown entry
    expect(resolveChoiceKey(OPTS, ['(6,2)'], 'single')).toBeNull(); // formatting variant
    // Two options share one label: the label entry is ambiguous.
    expect(
      resolveChoiceKey(
        [
          { value: 'a', label: 'X' },
          { value: 'b', label: 'X' },
        ],
        ['X'],
        'single',
      ),
    ).toBeNull();
    // Duplicate entries naming one option are ambiguous data.
    expect(resolveChoiceKey(OPTS, ['a', 'a'], 'multiple')).toBeNull();
    // Two distinct label entries resolving to the same value.
    expect(
      resolveChoiceKey(
        [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'A2' },
          { value: 'b', label: 'B' },
        ],
        ['A', 'A2'],
        'multiple',
      ),
    ).toBeNull();
    // A single-choice question with two key entries is inconsistent.
    expect(resolveChoiceKey(OPTS, ['a', 'b'], 'single')).toBeNull();
  });
});

describe('gradeChoiceSubmission', () => {
  const key = ['a', 'b'];
  it('is order-insensitive for multiple choice and exact otherwise', () => {
    expect(gradeChoiceSubmission(key, ['b', 'a'])).toBe('correct');
    expect(gradeChoiceSubmission(key, ['a'])).toBe('incorrect');
    expect(gradeChoiceSubmission(['a'], ['not-an-option'])).toBe('incorrect');
  });

  it('never grades an unverifiable key — empty submission included', () => {
    // The old bug: an empty key against an empty submission scored CORRECT.
    expect(gradeChoiceSubmission(null, [])).toBe('ungraded');
    expect(gradeChoiceSubmission(null, ['a'])).toBe('ungraded');
    // And the old empty-vs-empty path through gradeChoiceQuestions:
    const results = gradeChoiceQuestions([q({ answer: [] })], { q1: [] });
    expect(results[0]!.status).toBe('ungraded');
  });
});

describe('gradeChoiceQuestions (canonical, fail closed)', () => {
  it('marks an unverifiable key ungraded, not wrong, and awards nothing', () => {
    const results = gradeChoiceQuestions([q({ answer: ['(6,2)'] })], { q1: 'a' });
    expect(results[0]).toMatchObject({ correct: null, status: 'ungraded', earned: 0 });
  });

  it('grades a label-stored key against value submissions (label key, value answer)', () => {
    const results = gradeChoiceQuestions([q({ answer: ['B'] })], { q1: 'b' });
    expect(results[0]).toMatchObject({ correct: true, status: 'correct' });
  });

  it('keeps missing submissions incorrect when the key is verifiable', () => {
    const results = gradeChoiceQuestions([q({})], {});
    expect(results[0]).toMatchObject({ correct: false, status: 'incorrect' });
  });
});

describe('answerIncludesOption / hasVerifiableChoiceKey (highlight parity)', () => {
  it('highlights through the same resolver as grading — label keys highlight values', () => {
    const question = q({ answer: ['B'] });
    expect(answerIncludesOption(question, 'b')).toBe(true);
    expect(answerIncludesOption(question, 'a')).toBe(false);
  });

  it('highlights nothing for an unverifiable key', () => {
    const question = q({ answer: ['nope'] });
    expect(answerIncludesOption(question, 'a')).toBe(false);
    expect(answerIncludesOption(question, 'b')).toBe(false);
    expect(hasVerifiableChoiceKey(question)).toBe(false);
  });
});

describe('parseAiGradeScore (fail closed)', () => {
  const pts = 5;
  it('accepts finite numbers and clamps into range', () => {
    expect(parseAiGradeScore({ score: 4 }, pts)).toEqual({ earned: 4 });
    expect(parseAiGradeScore({ score: -3 }, pts)!.earned).toBe(0);
    expect(parseAiGradeScore({ score: 99 }, pts)!.earned).toBe(5);
    expect(parseAiGradeScore({ score: 4, comment: 'good' }, pts)).toEqual({
      earned: 4,
      comment: 'good',
    });
  });

  it('rejects null, missing, non-number, NaN, Infinity, junk bodies', () => {
    expect(parseAiGradeScore({ score: null }, pts)).toBeNull();
    expect(parseAiGradeScore({}, pts)).toBeNull();
    expect(parseAiGradeScore({ score: '4' }, pts)).toBeNull();
    expect(parseAiGradeScore({ score: Number.NaN }, pts)).toBeNull();
    expect(parseAiGradeScore({ score: Number.POSITIVE_INFINITY }, pts)).toBeNull();
    expect(parseAiGradeScore(null, pts)).toBeNull();
    expect(parseAiGradeScore('ok', pts)).toBeNull();
  });

  it('drops non-string comments instead of propagating them', () => {
    expect(parseAiGradeScore({ score: 3, comment: 7 }, pts)).toEqual({ earned: 3 });
  });
});

describe('isUngradedResult (legacy compatibility)', () => {
  it('treats new ungraded and legacy null-verdict rows as undecided', () => {
    const fresh: QuestionResult = { questionId: 'q', correct: null, status: 'ungraded', earned: 0 };
    const legacy: QuestionResult = {
      questionId: 'q',
      correct: null,
      status: 'incorrect',
      earned: 2,
    };
    expect(isUngradedResult(fresh)).toBe(true);
    expect(isUngradedResult(legacy)).toBe(true);
    expect(
      isUngradedResult({ questionId: 'q', correct: false, status: 'incorrect', earned: 0 }),
    ).toBe(false);
  });
});
