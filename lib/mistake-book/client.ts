/**
 * Client half of the mistake book: the pure payload builder the quiz view
 * calls after grading, plus the fetch wrappers the mistake-book page uses.
 *
 * Capture is deliberately fire-and-forget from the quiz's point of view: a
 * failed POST (including the 503 a browser-only deployment answers) is logged
 * and dropped — grading and review must never depend on the mistake book.
 */
import type { QuizQuestion } from '@/lib/types/stage';
import type { QuestionResult } from '@/lib/quiz/grading';
import { createLogger } from '@/lib/logger';
import type { MistakeRecordView } from '@/lib/persistence/mistake-book';

const log = createLogger('MistakeBook');

export interface MistakeCaptureContextInput {
  stageId: string;
  stageName: string;
  sceneId: string;
  sceneTitle?: string;
  sceneOrder?: number;
  /** Curriculum taxonomy codes from the stage ('math', 'grade-1-up'). */
  subject?: string;
  gradeSemester?: string;
}

export interface MistakeCapturePayload {
  stageId: string;
  stageName: string;
  sceneId: string;
  sceneTitle?: string;
  sceneOrder?: number;
  subject?: string;
  gradeSemester?: string;
  items: Array<{
    questionId: string;
    questionType: QuizQuestion['type'];
    question: string;
    /** QuizOption[] from a live question, or the stored snapshot on retry. */
    options?: unknown;
    correctAnswer?: string[];
    analysis?: string;
    userAnswer: unknown;
  }>;
}

/**
 * Build the capture payload from one graded quiz review — only the incorrect
 * questions, each with a full snapshot (text, options, correct answer,
 * analysis) so the record survives course edits and deletion.
 * Returns null when nothing was wrong (nothing to capture).
 */
export function buildMistakeCapturePayload(
  questions: readonly QuizQuestion[],
  answers: Record<string, string | string[]>,
  results: readonly QuestionResult[],
  context: MistakeCaptureContextInput,
): MistakeCapturePayload | null {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const items: MistakeCapturePayload['items'] = [];
  for (const result of results) {
    if (result.status !== 'incorrect') continue;
    const question = byId.get(result.questionId);
    if (!question) continue;
    const analysis =
      [question.analysis, result.aiComment].filter(Boolean).join('\n\n') || undefined;
    items.push({
      questionId: question.id,
      questionType: question.type,
      question: question.question,
      ...(question.options ? { options: question.options } : {}),
      ...(question.answer ? { correctAnswer: question.answer } : {}),
      ...(analysis ? { analysis } : {}),
      userAnswer: answers[question.id],
    });
  }
  if (items.length === 0) return null;
  return {
    stageId: context.stageId,
    stageName: context.stageName,
    sceneId: context.sceneId,
    ...(context.sceneTitle ? { sceneTitle: context.sceneTitle } : {}),
    ...(context.sceneOrder !== undefined ? { sceneOrder: context.sceneOrder } : {}),
    ...(context.subject ? { subject: context.subject } : {}),
    ...(context.gradeSemester ? { gradeSemester: context.gradeSemester } : {}),
    items,
  };
}

/** Capture one graded batch. Never throws; failures are logged and dropped. */
export async function captureMistakesFromQuiz(payload: MistakeCapturePayload): Promise<boolean> {
  try {
    const response = await fetch('/api/mistakes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // 503 = deployment without server persistence: expected, stay quiet.
    if (response.status === 503) return false;
    if (!response.ok) {
      log.warn(`Mistake capture failed (${response.status})`);
      return false;
    }
    return true;
  } catch (error) {
    log.warn('Mistake capture request failed:', error);
    return false;
  }
}

export interface MistakeListResult {
  mistakes: MistakeRecordView[];
  configured: boolean;
}

export async function fetchMistakes(
  filter: 'all' | 'unmastered' | 'mastered' = 'all',
): Promise<MistakeListResult> {
  const response = await fetch(`/api/mistakes?filter=${filter}`);
  if (response.status === 503) return { mistakes: [], configured: false };
  if (!response.ok) throw new Error(`Failed to load mistakes (${response.status})`);
  const json = (await response.json()) as { data?: { mistakes?: MistakeRecordView[] } };
  return { mistakes: json.data?.mistakes ?? [], configured: true };
}

export async function setMistakeMastered(
  key: { stageId: string; sceneId: string; questionId: string },
  mastered: boolean,
): Promise<boolean> {
  const response = await fetch('/api/mistakes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...key, mastered }),
  });
  return response.ok;
}

export async function reportRetryWrong(payload: MistakeCapturePayload): Promise<boolean> {
  // A wrong retry is just another capture: wrong_count+1, back to unmastered.
  return captureMistakesFromQuiz(payload);
}

/**
 * Manual classification: patch the stage's curriculum metadata AND bulk-update
 * the owner's mistake rows for that stage, so existing records regroup and
 * future captures (which read the stage metadata) agree with the choice.
 */
export async function classifyStage(
  stageId: string,
  classification: { subject?: string | null; gradeSemester?: string | null },
): Promise<boolean> {
  const stageResponse = await fetch(`/api/stages/${stageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(classification),
  });
  if (!stageResponse.ok) return false;
  const mistakesResponse = await fetch('/api/mistakes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classifyStage: true, stageId, ...classification }),
  });
  return mistakesResponse.ok;
}

export async function deleteMistakeRecord(
  scope:
    | { kind: 'one'; stageId: string; sceneId: string; questionId: string }
    | { kind: 'stage'; stageId: string }
    | { kind: 'all' },
): Promise<boolean> {
  const body =
    scope.kind === 'one'
      ? { stageId: scope.stageId, sceneId: scope.sceneId, questionId: scope.questionId }
      : scope.kind === 'stage'
        ? { stageId: scope.stageId }
        : { all: true };
  const response = await fetch('/api/mistakes', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.ok;
}
