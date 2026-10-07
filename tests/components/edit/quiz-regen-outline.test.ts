import { describe, expect, it } from 'vitest';

import { buildQuizRegenerationOutline } from '@/components/edit/surfaces/quiz/quiz-regen-outline';
import type { SceneOutline } from '@/lib/types/generation';
import type { QuizContent, Scene } from '@/lib/types/stage';

function quizScene(content: QuizContent, over: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    order: 3,
    title: '课后练习',
    type: 'quiz',
    content,
    actions: [],
    ...over,
  } as Scene;
}

describe('buildQuizRegenerationOutline', () => {
  it('keeps the planned quizConfig shape and overrides only the difficulty', () => {
    const planned: SceneOutline = {
      id: 'p3',
      type: 'quiz',
      order: 3,
      title: '课后练习',
      description: '全课收尾练习',
      keyPoints: ['加法', '减法'],
      quizConfig: { questionCount: 6, difficulty: 'easy', questionTypes: ['single', 'text'] },
    };
    const outline = buildQuizRegenerationOutline({
      scene: quizScene({ type: 'quiz', questions: [] }, { outlineId: 'p3' }),
      planned,
      difficulty: 'hard',
    });

    expect(outline.id).toBe('p3');
    expect(outline.quizConfig).toEqual({
      questionCount: 6,
      difficulty: 'hard',
      questionTypes: ['single', 'text'],
    });
    // The planned teaching context survives so the regen reuses it.
    expect(outline.keyPoints).toEqual(['加法', '减法']);
    expect(outline.description).toBe('全课收尾练习');
  });

  it('derives the config from the live questions when no plan exists', () => {
    const scene = quizScene({
      type: 'quiz',
      questions: [
        { id: 'q1', type: 'single', question: 'a' },
        { id: 'q2', type: 'short_answer', question: 'b' },
        { id: 'q3', type: 'short_answer', question: 'c' },
        { id: 'q4', type: 'single', question: 'd' },
        { id: 'q5', type: 'single', question: 'e' },
      ],
    });
    const outline = buildQuizRegenerationOutline({ scene, difficulty: 'medium' });

    expect(outline.quizConfig).toEqual({
      questionCount: 5,
      difficulty: 'medium',
      // 'short_answer' (DSL token) maps to 'text' (quizConfig token), deduped.
      questionTypes: ['single', 'text'],
    });
    // Fallback identity when neither plan nor outlineId exists.
    expect(outline.id).toBe('scene-1');
    expect(outline.description).toBe('课后练习');
  });

  it('defaults a hand-cleared quiz to 3 single-choice questions', () => {
    const outline = buildQuizRegenerationOutline({
      scene: quizScene({ type: 'quiz', questions: [] }),
      difficulty: 'easy',
    });
    expect(outline.quizConfig).toEqual({
      questionCount: 3,
      difficulty: 'easy',
      questionTypes: ['single'],
    });
  });
});
