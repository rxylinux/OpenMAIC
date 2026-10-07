/**
 * Contract tests for the quiz-content prompt templates. The knowledge point
 * requirement is load-bearing for the mistake book's same-point practice:
 * a template edit that silently drops it would make every newly generated
 * course carry考点-less questions, degrading practice to runtime inference
 * with no test failing — these assertions close that hole.
 */
import { describe, expect, test } from 'vitest';
import { buildPrompt, PROMPT_IDS } from '@openmaic/generation';

function quizContentPrompt(): string {
  const prompt = buildPrompt(PROMPT_IDS.QUIZ_CONTENT, {
    title: 'After-Class Practice',
    description: 'Whole-course wrap-up',
    keyPoints: '1. 加法\n2. 减法',
    questionCount: 6,
    difficulty: 'hard',
    questionTypes: 'single, multiple, text',
    languageDirective: 'Teach in Chinese.',
  });
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('quiz-content knowledge point contract', () => {
  test('requires a knowledgePoint on every generated question', () => {
    const text = quizContentPrompt();

    expect(text).toContain('Every question must include `knowledgePoint`');
    // Both the per-type examples and the output-format examples carry the
    // field, so the model sees it in every shape it might copy.
    expect((text.match(/"knowledgePoint"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  test('renders with every placeholder filled', () => {
    expect(quizContentPrompt()).not.toContain('{{');
  });
});
