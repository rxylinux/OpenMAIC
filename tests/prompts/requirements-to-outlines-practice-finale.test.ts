import { describe, expect, test } from 'vitest';
import { buildPrompt, PROMPT_IDS } from '@openmaic/generation';

function outlinePromptText() {
  const prompt = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
    requirement: 'Teach a short lesson on addition within 5',
    pdfContent: 'None',
    availableImages: 'No images available',
    userProfile: '',
    difficultyPreference: '',
    researchContext: 'None',
    teacherContext: '',
    hasSourceImages: false,
    imageEnabled: false,
    videoEnabled: false,
    mediaEnabled: false,
  });
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('requirements-to-outlines after-class practice finale', () => {
  test('documents the mandatory final practice quiz scene rule', () => {
    const text = outlinePromptText();

    expect(text).toContain('After-class practice finale');
    // The rule must pin the finale to the LAST outline as a quiz scene.
    expect(text).toContain('the LAST outline MUST be a `quiz` scene');
    // It must cover the whole course, not the closing scene only.
    expect(text).toContain('covering the key points of the WHOLE course');
    // Size and question-type expectations must be stated.
    expect(text).toContain('5-8 questions');
    expect(text).toContain('["single", "multiple", "short_answer"]');
    // The escape hatch (user asked for no quizzes) and the PBL/short-course
    // exclusions must both be present so the model can opt out honestly.
    expect(text).toContain('no quizzes');
    expect(text).toContain('not primarily a PBL course');
    // No unfilled template placeholders may leak into the rendered prompt.
    expect(text).not.toContain('{{');
  });

  test('documents the curriculum classification contract', () => {
    const text = outlinePromptText();

    // subject and gradeSemester are required top-level keys with closed lists.
    expect(text).toContain('`subject` (code from the closed list)');
    expect(text).toContain('`gradeSemester` (code from the closed list)');
    expect(text).toContain('`"chinese"`, `"math"`, `"english"`, `"science"`, `"other"`');
    expect(text).toContain('"grade-1-up"');
    expect(text).toContain('"grade-6-down"');
    expect(text).toContain('`"other"` for anything outside primary school');
    // Free-text / localized values are explicitly forbidden (the phrase wraps
    // across lines in the template, so assert the fragments).
    expect(text).toContain('free-text value');
    expect(text).toContain('never a synonym');
  });
});
