// @vitest-environment jsdom

/**
 * QuizRegenerateControl's permission gate. The full regeneration flow is
 * covered by the extracted pure helper (quiz-regen-outline.test.ts) plus the
 * existing scene-content pipeline tests; what only the component can pin is
 * the affordance's visibility contract: the control never renders when this
 * browser may not generate for the stage (mirrors the classroom retry rule
 * that the render condition and the precondition stay one rule).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'zh-CN' }),
}));

const permission = vi.hoisted(() => ({ mayGenerate: true }));

vi.mock('@/lib/classroom/generation-permission', () => ({
  mayGenerateForStage: () => permission.mayGenerate,
  useMayGenerateForStage: () => permission.mayGenerate,
}));

import { QuizRegenerateControl } from '@/components/edit/surfaces/quiz/QuizRegenerateControl';
import { useStageStore } from '@/lib/store/stage';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  permission.mayGenerate = true;
  useStageStore.setState({
    stage: { id: 'stage-1', name: 'Test', createdAt: 1, updatedAt: 1 } as never,
    scenes: [],
    outlines: [],
    currentSceneId: 'scene-1',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderControl() {
  act(() => {
    root!.render(createElement(QuizRegenerateControl));
  });
  return container!.querySelector('[data-testid="quiz-regenerate"]');
}

describe('QuizRegenerateControl permission gate', () => {
  it('renders the regenerate affordance when generation is permitted', () => {
    expect(renderControl()).not.toBeNull();
  });

  it('renders nothing when this browser may not generate for the stage', () => {
    permission.mayGenerate = false;
    expect(renderControl()).toBeNull();
    expect(container!.textContent).toBe('');
  });
});
