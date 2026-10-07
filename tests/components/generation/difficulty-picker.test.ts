// @vitest-environment jsdom

/**
 * DifficultyPicker — the homepage quiz-difficulty preference control.
 * Renders four radio options (Auto keeps the legacy infer-from-requirement
 * behavior), reports the pick through onChange, and goes inert when the
 * generation prep freeze disables it.
 */
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DifficultyPicker,
  type DifficultyPreference,
} from '@/components/generation/difficulty-picker';

const LABELS = { auto: 'Auto', easy: 'Easy', medium: 'Medium', hard: 'Hard' };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
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

function render(props: {
  value: DifficultyPreference | null;
  onChange: (value: DifficultyPreference | null) => void;
  disabled?: boolean;
}) {
  act(() => {
    root!.render(createElement(DifficultyPicker, { labels: LABELS, ...props }));
  });
  return Array.from(container!.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
}

describe('DifficultyPicker', () => {
  it('renders the four options with Auto active by default', () => {
    const buttons = render({ value: null, onChange: vi.fn() });
    expect(buttons.map((button) => button.textContent)).toEqual(['Auto', 'Easy', 'Medium', 'Hard']);
    expect(buttons[0]!.getAttribute('aria-checked')).toBe('true');
    expect(
      buttons.slice(1).every((button) => button.getAttribute('aria-checked') === 'false'),
    ).toBe(true);
  });

  it('marks the selected difficulty active and reports picks', () => {
    const onChange = vi.fn();
    const buttons = render({ value: 'hard', onChange });
    expect(buttons[3]!.getAttribute('aria-checked')).toBe('true');

    act(() => buttons[1]!.click());
    expect(onChange).toHaveBeenCalledWith('easy');
  });

  it('reports null (auto/infer) when Auto is clicked', () => {
    const onChange = vi.fn();
    const buttons = render({ value: 'medium', onChange });
    act(() => buttons[0]!.click());
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('goes inert while disabled', () => {
    const onChange = vi.fn();
    const buttons = render({ value: null, onChange, disabled: true });
    act(() => buttons[2]!.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(buttons[2]!.disabled).toBe(true);
  });
});
