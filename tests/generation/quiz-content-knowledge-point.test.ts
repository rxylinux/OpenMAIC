/**
 * The knowledge-point normalization on the MAIN quiz generation path —
 * what the classroom's questions carry into the mistake book. The similar-
 * question generator has its own coverage; these pin the primary pipeline.
 */
import { describe, expect, it } from 'vitest';
import { generateSceneContent, type SceneOutline } from '@openmaic/generation';

const outline: SceneOutline = {
  id: 'p1',
  type: 'quiz',
  order: 1,
  title: '课后练习',
  description: 'Whole-course wrap-up',
  keyPoints: ['10 以内加法'],
  quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] },
};

function modelQuestion(knowledgePoint: unknown): Record<string, unknown> {
  return {
    id: 'q1',
    type: 'single',
    question: '1 + 1 = ?',
    options: [
      { label: '2', value: 'A' },
      { label: '3', value: 'B' },
    ],
    answer: ['A'],
    analysis: '1 加 1 等于 2。',
    points: 1,
    ...(knowledgePoint === undefined ? {} : { knowledgePoint }),
  };
}

describe('generateSceneContent (quiz) knowledge point normalization', () => {
  it('trims a padded knowledge point', async () => {
    const content = await generateSceneContent(
      outline,
      async () => JSON.stringify([modelQuestion('  一元二次方程判别式  ')]),
      {},
    );
    expect(content).not.toBeNull();
    const question = (content as { questions: Array<{ knowledgePoint?: string }> }).questions[0]!;
    expect(question.knowledgePoint).toBe('一元二次方程判别式');
  });

  it('drops a blank knowledge point to undefined instead of storing whitespace', async () => {
    const content = await generateSceneContent(
      outline,
      async () => JSON.stringify([modelQuestion('   ')]),
      {},
    );
    const question = (content as { questions: Array<{ knowledgePoint?: string }> }).questions[0]!;
    expect(question.knowledgePoint).toBeUndefined();
  });

  it('keeps a legacy model answer (no knowledge point at all) valid', async () => {
    const content = await generateSceneContent(
      outline,
      async () => JSON.stringify([modelQuestion(undefined)]),
      {},
    );
    const question = (
      content as { questions: Array<{ knowledgePoint?: string; question: string }> }
    ).questions[0]!;
    expect(question.knowledgePoint).toBeUndefined();
    expect(question.question).toBe('1 + 1 = ?');
  });
});
