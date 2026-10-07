/**
 * Similar Question Generation API
 *
 * POST: given one stored mistake-record question snapshot, generate ONE fresh
 * question of the same type testing the same knowledge point — the engine of
 * the mistake book's same-point practice. Fail-closed: any parse/shape
 * problem answers 502 so the client can fall back to redoing the original.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { generateSimilarQuestion, type AICallFn } from '@openmaic/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';

const log = createLogger('SimilarQuestion');

const QUESTION_TYPES = ['single', 'multiple', 'short_answer'] as const;
const MAX_QUESTION_CHARS = 32 * 1024;
const MAX_ANALYSIS_CHARS = 16 * 1024;
const MAX_TEXT_CHARS = 200;

interface SimilarQuestionRequest {
  questionType?: unknown;
  question?: unknown;
  options?: unknown;
  correctAnswer?: unknown;
  analysis?: unknown;
  commentPrompt?: unknown;
  knowledgePoint?: unknown;
  difficulty?: unknown;
  language?: unknown;
}

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  try {
    const body = (await req.json()) as SimilarQuestionRequest;
    questionSnippet =
      typeof body.question === 'string' ? body.question.substring(0, 60) : undefined;

    const { questionType, question } = body;
    if (
      typeof questionType !== 'string' ||
      !QUESTION_TYPES.includes(questionType as (typeof QUESTION_TYPES)[number])
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'questionType must be single | multiple | short_answer',
      );
    }
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS) {
      return apiError('INVALID_REQUEST', 400, 'question must be a non-empty string');
    }
    if (body.options !== undefined && !Array.isArray(body.options)) {
      return apiError('INVALID_REQUEST', 400, 'options must be an array when present');
    }
    if (
      body.analysis !== undefined &&
      (typeof body.analysis !== 'string' || body.analysis.length > MAX_ANALYSIS_CHARS)
    ) {
      return apiError('INVALID_REQUEST', 400, 'analysis must be a string when present');
    }
    if (
      body.commentPrompt !== undefined &&
      (typeof body.commentPrompt !== 'string' || body.commentPrompt.length > MAX_ANALYSIS_CHARS)
    ) {
      return apiError('INVALID_REQUEST', 400, 'commentPrompt must be a string when present');
    }
    if (
      body.knowledgePoint !== undefined &&
      (typeof body.knowledgePoint !== 'string' || body.knowledgePoint.length > MAX_TEXT_CHARS)
    ) {
      return apiError('INVALID_REQUEST', 400, 'knowledgePoint must be a short string when present');
    }
    const difficulty =
      body.difficulty === 'easy' || body.difficulty === 'medium' || body.difficulty === 'hard'
        ? body.difficulty
        : undefined;
    const languageDirective =
      typeof body.language === 'string' && body.language
        ? `Write every piece of question content in the language of locale "${body.language}".`
        : undefined;

    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'similar-question',
    );
    const aiCall: AICallFn = async (system, user) =>
      (
        await callLLM(
          { model: languageModel, system, prompt: user },
          'similar-question',
          undefined,
          thinkingConfig,
        )
      ).text;

    const questionGenerated = await generateSimilarQuestion(
      {
        questionType: questionType as 'single' | 'multiple' | 'short_answer',
        question,
        ...(body.options !== undefined ? { options: body.options } : {}),
        ...(body.correctAnswer !== undefined ? { correctAnswer: body.correctAnswer } : {}),
        ...(typeof body.analysis === 'string' && body.analysis ? { analysis: body.analysis } : {}),
        ...(typeof body.commentPrompt === 'string' && body.commentPrompt
          ? { commentPrompt: body.commentPrompt }
          : {}),
        ...(typeof body.knowledgePoint === 'string' && body.knowledgePoint
          ? { knowledgePoint: body.knowledgePoint }
          : {}),
        ...(difficulty ? { difficulty } : {}),
        ...(languageDirective ? { languageDirective } : {}),
      },
      aiCall,
    );

    if (!questionGenerated) {
      log.warn(
        `Similar question generation produced nothing usable [question="${questionSnippet ?? 'unknown'}..."]`,
      );
      return apiError('GENERATION_FAILED', 502, 'Generation failed; retry');
    }

    return apiSuccess({ question: questionGenerated });
  } catch (error) {
    log.error(
      `Similar question generation failed [question="${questionSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to generate a similar question');
  }
}
