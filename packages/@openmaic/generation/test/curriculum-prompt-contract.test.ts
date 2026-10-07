/**
 * Focused contract assertions for the curriculum-classification prompt
 * alignment: the requirements-to-outlines templates must teach ONE
 * consistent top-level shape — all five keys, subject/gradeSemester as
 * closed codes from src/curriculum.ts — in every place they describe the
 * output (shape block, rules, minimal example, reminders). A template that
 * demands five keys but shows a three-key example teaches the model to omit
 * the classification, forking the taxonomy.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { COURSE_SUBJECTS, GRADE_SEMESTERS } from '@openmaic/generation';

const templatesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../templates/requirements-to-outlines',
);
const system = readFileSync(resolve(templatesDir, 'system.md'), 'utf8');
const user = readFileSync(resolve(templatesDir, 'user.md'), 'utf8');

/** The first ```json fence that follows the "Minimal complete example" heading. */
function minimalExampleJson(source: string): Record<string, unknown> {
  const headingAt = source.indexOf('### Minimal complete example');
  expect(headingAt).toBeGreaterThan(-1);
  const fenceStart = source.indexOf('```json', headingAt);
  const fenceEnd = source.indexOf('```', fenceStart + 7);
  const body = source.slice(fenceStart + 7, fenceEnd);
  return JSON.parse(body) as Record<string, unknown>;
}

describe('curriculum prompt contract (requirements-to-outlines)', () => {
  test('system.md demands the five-key shape and its minimal example matches it', () => {
    expect(system).toContain('exactly these five top-level keys');
    const example = minimalExampleJson(system);
    expect(Object.keys(example).sort()).toEqual(
      ['courseTitle', 'gradeSemester', 'languageDirective', 'outlines', 'subject'].sort(),
    );
    // The reviewed Projectile Motion example classifies as science (physics),
    // gradeSemester outside primary school.
    expect(example.subject).toBe('science');
    expect(example.gradeSemester).toBe('other');
  });

  test('the closed code lists the templates teach are exactly src/curriculum.ts', () => {
    // Subjects are fully enumerated in both templates.
    for (const subject of COURSE_SUBJECTS) {
      expect(system).toContain(`"${subject}"`);
      expect(user).toContain(`"${subject}"`);
    }
    // Grades are taught as the closed range grade-1-up … grade-6-down plus the
    // out-of-primary escape hatch; every token in that notation is a legal
    // GRADE_SEMESTERS code (the runtime normalizer enforces full closure).
    expect(system).toContain('"grade-1-up"');
    expect(system).toContain('"grade-6-down"');
    expect(user).toContain('"grade-1-up"');
    expect(user).toContain('"grade-6-down"');
    for (const endpoint of ['grade-1-up', 'grade-6-down', 'other']) {
      expect(GRADE_SEMESTERS).toContain(endpoint);
    }
  });

  test('reminders enumerate all five keys; no template still says three', () => {
    expect(system).toMatch(/MUST have `languageDirective`[^]*`gradeSemester`/);
    expect(system).toContain('All five top-level keys are required');
    expect(user).toContain('All five keys are required');
    expect(user).toContain('exactly five top-level keys');
    for (const source of [system, user]) {
      expect(source).not.toContain('three top-level keys');
      expect(source).not.toContain('All three keys');
      expect(source).not.toContain('exactly these three');
    }
  });

  test('the after-class practice finale reminder is preserved verbatim', () => {
    expect(system).toContain('After-class practice finale');
    expect(system).toMatch(/LAST outline MUST be a `quiz` scene/);
    expect(system).toMatch(/5-8 questions/);
  });
});
