import { describe, expect, test } from 'vitest';
import { buildOutlinePrompt } from '@openmaic/generation';

const BASE_REQUIREMENTS = { requirement: 'Teach a short lesson on addition within 5' };

describe('requirements-to-outlines difficulty preference', () => {
  test('injects an explicit difficulty directive the outlines must obey', () => {
    const { user } = buildOutlinePrompt({
      ...BASE_REQUIREMENTS,
      difficultyPreference: 'hard',
    });
    expect(user).toContain('## Difficulty Preference');
    expect(user).toContain('"hard"');
    // The quizConfig rule references the override so the model cannot infer around it.
    expect(user).toContain('every `quizConfig.difficulty` MUST equal that selected value');
  });

  test('omits the section entirely when no preference was selected', () => {
    const { user } = buildOutlinePrompt(BASE_REQUIREMENTS);
    expect(user).not.toContain('## Difficulty Preference');
    expect(user).not.toContain('{{');
  });
});
