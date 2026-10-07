/**
 * Pure outline construction for the quiz editor's "regenerate at another
 * difficulty" action — extracted from QuizRegenerateControl so the merge
 * rules below are unit-testable without the generation pipeline.
 */
import type { SceneOutline } from '@/lib/types/generation';
import type { QuizContent, Scene } from '@/lib/types/stage';

export type QuizDifficulty = 'easy' | 'medium' | 'hard';

/**
 * Build the outline handed to fetchSceneContent when regenerating a quiz
 * scene at a new difficulty:
 *
 * - The scene's PLANNED outline is the base (description/keyPoints/题量/题型
 *   survive), matched by outlineId first, then order — the same lookup the
 *   agent runtime uses.
 * - `quizConfig.difficulty` is overridden with the picked value; the planned
 *   questionCount and questionTypes are kept so a regen only changes
 *   difficulty, not the shape of the set.
 * - With no planned quizConfig the config is derived from the LIVE
 *   questions: the current count (min 3) and the present question types, so
 *   a hand-edited set regenerates to a same-shaped one.
 */
export function buildQuizRegenerationOutline(input: {
  scene: Scene;
  planned?: SceneOutline;
  difficulty: QuizDifficulty;
}): SceneOutline {
  const { scene, planned, difficulty } = input;
  const content = scene.type === 'quiz' ? (scene.content as QuizContent) : null;
  const questions = content?.questions ?? [];
  // Map the stored type tokens onto the outline's config vocabulary:
  // 'short_answer' is the DSL token, 'text' is the quizConfig token.
  const presentTypes = [
    ...new Set(
      questions.map((q) =>
        q.type === 'short_answer' ? 'text' : (q.type as 'single' | 'multiple' | 'text'),
      ),
    ),
  ] as ('single' | 'multiple' | 'text')[];

  return {
    ...(planned ?? {}),
    id: planned?.id ?? scene.outlineId ?? scene.id,
    order: scene.order,
    title: scene.title,
    type: 'quiz',
    description: planned?.description ?? scene.title,
    keyPoints: planned?.keyPoints ?? [],
    quizConfig: {
      questionCount: planned?.quizConfig?.questionCount ?? Math.max(3, questions.length),
      difficulty,
      questionTypes: planned?.quizConfig?.questionTypes?.length
        ? planned.quizConfig.questionTypes
        : presentTypes.length
          ? presentTypes
          : ['single'],
    },
  };
}
