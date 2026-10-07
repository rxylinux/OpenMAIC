'use client';

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useStageStore } from '@/lib/store/stage';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';
import { fetchSceneActions, fetchSceneContent } from '@/lib/hooks/use-scene-generator';
import type { Action } from '@/lib/types/action';
import type { QuizContent } from '@/lib/types/stage';
import { buildQuizRegenerationOutline, type QuizDifficulty } from './quiz-regen-outline';
import { useQuizEditSession } from './quiz-edit-session';
import { cn } from '@/lib/utils';

type Difficulty = QuizDifficulty;

/**
 * "Regenerate this question set at another difficulty" for the quiz edit
 * surface. Runs the same content → actions pipeline the classroom retry uses
 * (fetchSceneContent/fetchSceneActions), with the scene's outline quizConfig
 * rewritten to the picked difficulty, then writes the result through
 * `updateScene` so the stage store's auto-save persists it. Deliberately
 * bypasses the regen-lock: the user is editing this exact scene and asked for
 * the replacement, which is what the lock exists to prevent surprising.
 */
export function QuizRegenerateControl() {
  const { t } = useI18n();
  const stage = useStageStore((s) => s.stage);
  const sceneId = useStageStore((s) => s.currentSceneId);
  const mayGenerate = mayGenerateForStage(stage?.id);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the picker from the scene's planned quizConfig so the first click
  // regenerates at the difficulty the questions were generated with.
  useEffect(() => {
    const state = useStageStore.getState();
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!scene || scene.type !== 'quiz') return;
    const planned = state.outlines.find((o) => o.id === scene.outlineId || o.order === scene.order);
    const plannedDifficulty = planned?.quizConfig?.difficulty;
    if (
      plannedDifficulty === 'easy' ||
      plannedDifficulty === 'medium' ||
      plannedDifficulty === 'hard'
    ) {
      setDifficulty(plannedDifficulty);
    }
  }, [sceneId]);

  if (!mayGenerate) return null;

  const regenerate = async () => {
    const state = useStageStore.getState();
    const currentStage = state.stage;
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!currentStage || !scene || scene.type !== 'quiz' || running) return;

    setRunning(true);
    setError(null);
    try {
      const planned = state.outlines.find(
        (o) => o.id === scene.outlineId || o.order === scene.order,
      );
      const outline = buildQuizRegenerationOutline({ scene, planned, difficulty });
      const allOutlines = state.outlines.some((o) => o.id === outline.id)
        ? state.outlines
        : [...state.outlines, outline];

      const contentResult = await fetchSceneContent({
        outline,
        allOutlines,
        stageId: currentStage.id,
        stageInfo: {
          name: currentStage.name || '',
          description: currentStage.description,
          style: currentStage.style,
        },
        languageDirective: currentStage.languageDirective,
      });
      if (!contentResult.success || !contentResult.content) {
        throw new Error(contentResult.error || t('edit.quiz.regenFailed'));
      }

      const sorted = [...state.scenes].sort((a, b) => a.order - b.order);
      const index = sorted.findIndex((s) => s.id === scene.id);
      const previous = index > 0 ? sorted[index - 1] : undefined;
      const previousSpeeches = (previous?.actions ?? [])
        .filter((a): a is Extract<Action, { type: 'speech' }> => a.type === 'speech')
        .map((a) => a.text)
        .filter(Boolean)
        .slice(-3);

      const actionsResult = await fetchSceneActions({
        outline: contentResult.effectiveOutline ?? outline,
        allOutlines,
        content: contentResult.content,
        stageId: currentStage.id,
        previousSpeeches,
        languageDirective: currentStage.languageDirective,
      });
      const actions: Action[] =
        actionsResult.success && actionsResult.scene ? (actionsResult.scene.actions ?? []) : [];

      const nextContent = contentResult.content as QuizContent;
      useStageStore.getState().updateScene(scene.id, { content: nextContent, actions });
      // The undo history refers to the replaced question set; re-seed so undo
      // cannot resurrect stale questions over the regenerated ones.
      useQuizEditSession.getState().seed(scene.id, nextContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('edit.quiz.regenFailed'));
    } finally {
      setRunning(false);
    }
  };

  const options: Array<{ key: Difficulty; label: string }> = [
    { key: 'easy', label: t('generation.quizDifficultyEasy') },
    { key: 'medium', label: t('generation.quizDifficultyMedium') },
    { key: 'hard', label: t('generation.quizDifficultyHard') },
  ];

  return (
    <div className="flex items-center justify-end gap-2" data-testid="quiz-regenerate">
      {error && <span className="text-xs text-red-500">{error}</span>}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={running}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
              running
                ? 'cursor-not-allowed border-zinc-300 text-zinc-400 dark:border-zinc-700'
                : 'border-violet-300 text-violet-600 hover:bg-violet-50 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10',
            )}
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t('edit.quiz.regenLabel')}
          </button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="w-72 p-3">
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              {t('edit.quiz.regenTitle')}
            </p>
            <div className="flex items-center gap-1" role="radiogroup" aria-label="difficulty">
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={difficulty === option.key}
                  onClick={() => setDifficulty(option.key)}
                  className={cn(
                    'h-7 flex-1 cursor-pointer rounded-full px-2 text-xs font-medium transition-colors',
                    difficulty === option.key
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'bg-muted text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              {t('edit.quiz.regenWarning')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={running}
                onClick={regenerate}
                className="h-8 cursor-pointer rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? t('edit.quiz.regenRunning') : t('edit.quiz.regenConfirm')}
              </button>
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
