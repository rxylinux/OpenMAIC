/**
 * Client-side AI grading for one short-answer question — one bounded request
 * to /api/quiz-grade with STRICT response validation. Every unavailable
 * outcome (HTTP error, timeout/abort, malformed body, non-finite score)
 * resolves to an honest 'ungraded' verdict the review UI can retry; a real
 * numeric score (including 0) is a legitimate verdict.
 */
import type { QuizQuestion } from '@/lib/types/stage';
import { parseAiGradeScore, type QuestionResult } from '@/lib/quiz/grading';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { createLogger } from '@/lib/logger';

const log = createLogger('QuizAiGrade');

/** Per-question ceiling; on expiry the question is ungraded, retryable. */
export const AI_GRADE_TIMEOUT_MS = 30_000;

export async function gradeShortAnswerQuestion(
  q: QuizQuestion,
  userAnswer: string,
  language: string,
  timeoutMs: number = AI_GRADE_TIMEOUT_MS,
): Promise<QuestionResult> {
  const pts = q.points ?? 1;
  const ungraded = (): QuestionResult => ({
    questionId: q.id,
    correct: null,
    status: 'ungraded',
    earned: 0,
    aiComment:
      language === 'zh-CN' ? '评分未完成，可重新评分。' : 'Grading incomplete — retry grading.',
  });
  try {
    const modelConfig = getCurrentModelConfig();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
    };
    if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
    if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;

    const res = await fetch('/api/quiz-grade', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        question: q.question,
        userAnswer,
        points: pts,
        commentPrompt: q.commentPrompt,
        language,
      }),
      // A hung upstream must not pin the whole review open: bounded wait,
      // abort lands in the catch below as an honest ungraded verdict.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return ungraded();
    // Fail closed on the response body: a null/NaN/string/Infinity score is
    // "no verdict" — never a zero-mark that pollutes the mistake book.
    const data: unknown = await res.json();
    const parsed = parseAiGradeScore(data, pts);
    if (!parsed) return ungraded();
    const correct = parsed.earned >= pts * 0.8;
    return {
      questionId: q.id,
      correct,
      status: correct ? 'correct' : 'incorrect',
      earned: parsed.earned,
      aiComment: parsed.comment,
    };
  } catch (err) {
    // Network failure, timeout, abort: not a wrong answer — no half credit,
    // no mistake, an honest ungraded verdict the review UI can retry.
    log.warn('AI grading unavailable for', q.id, err);
    return ungraded();
  }
}
