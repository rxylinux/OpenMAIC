import { describe, expect, it } from 'vitest';

import { buildMistakeCapturePayload } from '@/lib/mistake-book/client';
import type { QuizQuestion } from '@/lib/types/stage';
import type { QuestionResult } from '@/lib/quiz/grading';

const questions: QuizQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: '3 + 2 = ?',
    options: [
      { label: '4', value: 'A' },
      { label: '5', value: 'B' },
    ],
    answer: ['B'],
    analysis: '3 加 2 等于 5。',
  },
  {
    id: 'q2',
    type: 'short_answer',
    question: '说一个比 3 大的数',
    analysis: '参考答案：4、5、6……',
  },
];

const answers: Record<string, string | string[]> = { q1: 'A', q2: '一' };

function results(wrongIds: string[], aiComment?: string): QuestionResult[] {
  return questions.map((question) => ({
    questionId: question.id,
    correct: !wrongIds.includes(question.id),
    status: wrongIds.includes(question.id) ? ('incorrect' as const) : ('correct' as const),
    earned: 0,
    ...(question.id === 'q2' && aiComment ? { aiComment } : {}),
  }));
}

describe('buildMistakeCapturePayload', () => {
  it('captures only incorrect questions with a full snapshot', () => {
    const payload = buildMistakeCapturePayload(questions, answers, results(['q1']), {
      stageId: 's1',
      stageName: '一年级数学',
      sceneId: 'sc1',
      sceneTitle: '课后练习',
      sceneOrder: 5,
      subject: 'math',
      gradeSemester: 'grade-1-up',
    });

    expect(payload).not.toBeNull();
    expect(payload!.items).toHaveLength(1);
    const item = payload!.items[0]!;
    expect(item.questionId).toBe('q1');
    expect(item.questionType).toBe('single');
    expect(item.question).toBe('3 + 2 = ?');
    expect(item.options).toEqual(questions[0]!.options);
    expect(item.correctAnswer).toEqual(['B']);
    expect(item.analysis).toBe('3 加 2 等于 5。');
    expect(item.userAnswer).toBe('A');
    expect(payload!.stageName).toBe('一年级数学');
    expect(payload!.sceneTitle).toBe('课后练习');
    expect(payload!.sceneOrder).toBe(5);
    expect(payload!.subject).toBe('math');
    expect(payload!.gradeSemester).toBe('grade-1-up');
  });

  it('omits the curriculum fields when the stage carries none', () => {
    const payload = buildMistakeCapturePayload(questions, answers, results(['q1']), {
      stageId: 's1',
      stageName: '一年级数学',
      sceneId: 'sc1',
    });
    expect(payload!.subject).toBeUndefined();
    expect(payload!.gradeSemester).toBeUndefined();
    expect('subject' in payload!).toBe(false);
  });

  it('returns null when every answer was correct', () => {
    const payload = buildMistakeCapturePayload(questions, answers, results([]), {
      stageId: 's1',
      stageName: '一年级数学',
      sceneId: 'sc1',
    });
    expect(payload).toBeNull();
  });

  it('appends the AI grading comment to the short-answer analysis', () => {
    const payload = buildMistakeCapturePayload(
      questions,
      answers,
      results(['q2'], '答“一”不满足大于 3。'),
      { stageId: 's1', stageName: '一年级数学', sceneId: 'sc1' },
    );

    const item = payload!.items.find((entry) => entry.questionId === 'q2')!;
    expect(item.analysis).toBe('参考答案：4、5、6……\n\n答“一”不满足大于 3。');
    expect(item.correctAnswer).toBeUndefined();
    expect(item.userAnswer).toBe('一');
  });

  it('skips results whose question is missing from the scene', () => {
    const orphan: QuestionResult = {
      questionId: 'gone',
      correct: false,
      status: 'incorrect',
      earned: 0,
    };
    const payload = buildMistakeCapturePayload(questions, answers, [orphan], {
      stageId: 's1',
      stageName: '一年级数学',
      sceneId: 'sc1',
    });
    expect(payload).toBeNull();
  });
});
