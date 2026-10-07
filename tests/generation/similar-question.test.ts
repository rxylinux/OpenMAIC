import { describe, expect, it } from 'vitest';

import { generateSimilarQuestion } from '@openmaic/generation';

function singleResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'q_model',
    type: 'single',
    question: '4 + 3 = ?',
    options: [
      { label: '6', value: 'A' },
      { label: '7', value: 'B' },
      { label: '8', value: 'C' },
    ],
    answer: ['B'],
    analysis: '4 加 3 等于 7。',
    knowledgePoint: '10 以内加法',
    points: 10,
    ...overrides,
  });
}

describe('generateSimilarQuestion', () => {
  it('returns a normalized fresh question preserving the original type and point', async () => {
    const question = await generateSimilarQuestion(
      {
        questionType: 'single',
        question: '2 + 3 = ?',
        options: [
          { label: '4', value: 'A' },
          { label: '5', value: 'B' },
        ],
        correctAnswer: ['B'],
        analysis: '2 加 3 等于 5。',
        knowledgePoint: '10 以内加法',
      },
      async () => singleResponse(),
    );

    expect(question).not.toBeNull();
    expect(question!.type).toBe('single');
    expect(question!.question).toBe('4 + 3 = ?');
    expect(question!.answer).toEqual(['B']);
    expect(question!.knowledgePoint).toBe('10 以内加法');
    expect(question!.hasAnswer).toBe(true);
    expect(question!.id).toMatch(/^q_similar_/);
  });

  it('rejects a model answer that drifts to another question type', async () => {
    const question = await generateSimilarQuestion(
      { questionType: 'single', question: '2 + 3 = ?' },
      async () => singleResponse({ type: 'short_answer' }),
    );
    expect(question).toBeNull();
  });

  it('normalizes label-form answer keys against the generated options', async () => {
    const question = await generateSimilarQuestion(
      { questionType: 'single', question: '2 + 3 = ?' },
      async () => singleResponse({ answer: ['7'] }),
    );
    expect(question!.answer).toEqual(['B']);
  });

  it('falls back to the input knowledge point when the model omits it', async () => {
    const question = await generateSimilarQuestion(
      { questionType: 'single', question: '2 + 3 = ?', knowledgePoint: '10 以内加法' },
      async () => singleResponse({ knowledgePoint: undefined }),
    );
    expect(question!.knowledgePoint).toBe('10 以内加法');
  });

  it('fails closed on unparseable model output', async () => {
    const question = await generateSimilarQuestion(
      { questionType: 'single', question: '2 + 3 = ?' },
      async () => 'not json at all',
    );
    expect(question).toBeNull();
  });

  it('keeps short answers answer-free and carries the rubric through', async () => {
    const question = await generateSimilarQuestion(
      {
        questionType: 'short_answer',
        question: '说一个比 3 大的数',
        commentPrompt: 'Rubric: any number greater than 3 - 100%',
        knowledgePoint: '数的大小比较',
      },
      async () =>
        JSON.stringify({
          id: 'q_model',
          type: 'short_answer',
          question: '说一个比 10 大的数',
          commentPrompt: 'Rubric: any number greater than 10 - 100%',
          analysis: '参考答案：11、12……',
          knowledgePoint: '数的大小比较',
          points: 20,
        }),
    );

    expect(question).not.toBeNull();
    expect(question!.type).toBe('short_answer');
    expect(question!.options).toBeUndefined();
    expect(question!.answer).toBeUndefined();
    expect(question!.hasAnswer).toBe(false);
    expect(question!.commentPrompt).toBe('Rubric: any number greater than 10 - 100%');
  });

  it('falls back to the original rubric when the model omits one', async () => {
    const question = await generateSimilarQuestion(
      {
        questionType: 'short_answer',
        question: '说一个比 3 大的数',
        commentPrompt: 'Rubric: any number greater than 3 - 100%',
      },
      async () =>
        JSON.stringify({
          id: 'q_model',
          type: 'short_answer',
          question: '说一个比 10 大的数',
          analysis: '参考答案：11、12……',
          points: 20,
        }),
    );

    // The stored rubric still grades the fresh question when the model
    // produced none — the AI-grading call needs one to be meaningful.
    expect(question!.commentPrompt).toBe('Rubric: any number greater than 3 - 100%');
  });
});
