/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { parseAiGradeScore } from '@/lib/quiz/grading';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  try {
    const body = (await req.json()) as GradeRequest;
    const { question, userAnswer, points, commentPrompt, language } = body;
    questionSnippet = question?.substring(0, 60);
    resolvedPoints = points;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
    }

    // Validate points is a positive finite number
    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number');
    }

    // Resolve model from request headers/body
    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'quiz-grade',
    );

    const isZh = language === 'zh-CN';

    const systemPrompt = isZh
      ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
      : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

    const userPrompt = isZh
      ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
      : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
      },
      'quiz-grade',
      undefined,
      thinkingConfig,
    );

    // Parse the LLM response as JSON — STRICTLY. The raw score must be a
    // finite number before anything else touches it: null, "0"-as-string,
    // NaN, Infinity or a non-JSON body are "no verdict", never a forged
    // half-score (the old fallback) and never Number()-coerced into a valid
    // zero. A real numeric 0 is a legitimate wrong-verdict and passes.
    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let parsed: unknown = null;
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = null; // malformed JSON in the braces: no verdict either
      }
    }
    const verdict = parseAiGradeScore(parsed, points);
    if (!verdict) {
      // Upstream produced nothing verifiable. Fail loud, not lenient: the
      // client keeps the answer and shows an honest "ungraded, retryable"
      // state instead of recording a fabricated mistake.
      log.warn(
        `Quiz grading produced no verifiable verdict [question="${questionSnippet ?? 'unknown'}...", raw=${JSON.stringify(text.slice(0, 120))}]`,
      );
      return apiError(
        'AI_GRADE_UNAVAILABLE',
        502,
        isZh ? '评分未完成，请重试' : 'Grading unavailable; retry',
      );
    }

    return apiSuccess({ score: Math.round(verdict.earned), comment: verdict.comment ?? '' });
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer');
  }
}
