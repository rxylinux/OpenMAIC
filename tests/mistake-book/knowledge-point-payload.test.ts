import { describe, expect, it } from 'vitest';

import { buildMistakeCapturePayload, buildRetryPayload } from '@/lib/mistake-book/client';
import type { QuizQuestion } from '@/lib/types/stage';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { MistakeRecordView } from '@/lib/persistence/mistake-book';

describe('knowledge point through the capture chain', () => {
  it('freezes the question knowledge point into the capture payload', () => {
    const question: QuizQuestion = {
      id: 'q1',
      type: 'single',
      question: '3+2=?',
      options: [
        { label: '4', value: 'A' },
        { label: '5', value: 'B' },
      ],
      answer: ['B'],
      knowledgePoint: '10 以内加法',
    };
    const results: QuestionResult[] = [
      { questionId: 'q1', correct: false, status: 'incorrect', earned: 0 },
    ];

    const payload = buildMistakeCapturePayload([question], { q1: 'A' }, results, {
      stageId: 's1',
      stageName: '数学',
      attemptId: 'att1',
      sceneId: 'sc1',
    });

    expect(payload!.items[0]!.knowledgePoint).toBe('10 以内加法');
  });

  it('keeps legacy questions (no knowledge point) field-absent, never null', () => {
    const question: QuizQuestion = {
      id: 'q1',
      type: 'single',
      question: '3+2=?',
      options: [
        { label: '4', value: 'A' },
        { label: '5', value: 'B' },
      ],
      answer: ['B'],
    };
    const results: QuestionResult[] = [
      { questionId: 'q1', correct: false, status: 'incorrect', earned: 0 },
    ];

    const payload = buildMistakeCapturePayload([question], { q1: 'A' }, results, {
      stageId: 's1',
      stageName: '数学',
      attemptId: 'att1',
      sceneId: 'sc1',
    });

    expect('knowledgePoint' in payload!.items[0]!).toBe(false);
  });

  it('carries the stored knowledge point into the retry/similar-wrong payload', () => {
    const record = {
      stageId: 's1',
      stageName: '数学',
      sceneId: 'sc1',
      questionId: 'q1',
      questionType: 'single',
      question: '3+2=?',
      options: [
        { label: '4', value: 'A' },
        { label: '5', value: 'B' },
      ],
      correctAnswer: ['B'],
      analysis: '加法',
      knowledgePoint: '10 以内加法',
      lastUserAnswer: ['A'],
      wrongCount: 1,
      firstWrongAt: '2026-10-01T00:00:00.000Z',
      lastWrongAt: '2026-10-01T00:00:00.000Z',
      masteredAt: null,
      sceneTitle: null,
      sceneOrder: null,
      subject: null,
      gradeSemester: null,
    } as MistakeRecordView;

    const payload = buildRetryPayload(record, ['B'], 'similar-evt-1');
    expect(payload.items[0]!.knowledgePoint).toBe('10 以内加法');
  });
});
