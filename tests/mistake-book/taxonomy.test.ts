import { describe, expect, it } from 'vitest';

import {
  COURSE_SUBJECTS,
  GRADE_SEMESTERS,
  groupMistakesByCurriculum,
  gradeSemesterLabelKey,
  normalizeCourseSubject,
  normalizeGradeSemester,
  subjectLabelKey,
} from '@/lib/curriculum/taxonomy';

describe('curriculum taxonomy', () => {
  it('accepts exact codes case-insensitively', () => {
    expect(normalizeCourseSubject('math')).toBe('math');
    expect(normalizeCourseSubject('Math')).toBe('math');
    expect(normalizeGradeSemester('grade-3-up')).toBe('grade-3-up');
    expect(normalizeGradeSemester('Grade-6-Down')).toBe('grade-6-down');
  });

  it('rejects free-text synonyms, junk and missing values', () => {
    expect(normalizeCourseSubject('数学')).toBeNull();
    expect(normalizeCourseSubject('mathematics')).toBeNull();
    expect(normalizeCourseSubject(42)).toBeNull();
    expect(normalizeCourseSubject(undefined)).toBeNull();
    expect(normalizeGradeSemester('三年级上')).toBeNull();
    expect(normalizeGradeSemester('grade-7-up')).toBeNull();
    expect(normalizeGradeSemester('')).toBeNull();
  });

  it('builds label keys that exist as i18n keys for every code', () => {
    for (const subject of COURSE_SUBJECTS) {
      expect(subjectLabelKey(subject)).toBe(`mistakeBook.subject_${subject}`);
    }
    for (const grade of GRADE_SEMESTERS) {
      expect(gradeSemesterLabelKey(grade)).toBe(`mistakeBook.grade_${grade}`);
    }
  });
});

describe('groupMistakesByCurriculum', () => {
  const record = (overrides: Partial<Parameters<typeof groupMistakesByCurriculum>[0][number]>) => ({
    stageId: 's1',
    stageName: '一年级数学欢乐启蒙',
    subject: null,
    gradeSemester: null,
    ...overrides,
  });

  it('groups into subject -> grade -> course in taxonomy order', () => {
    const tree = groupMistakesByCurriculum([
      record({ subject: 'math', gradeSemester: 'grade-1-up' }),
      record({ subject: 'chinese', gradeSemester: 'grade-1-up' }),
      record({ subject: 'math', gradeSemester: 'grade-1-down', stageId: 's2', stageName: 'B课' }),
    ]);

    expect(tree.map((node) => node.subject)).toEqual(['chinese', 'math']);
    const math = tree.find((node) => node.subject === 'math')!;
    // Taxonomy order: semester 1 (-up) before semester 2 (-down) per grade.
    expect(math.grades.map((grade) => grade.grade)).toEqual(['grade-1-up', 'grade-1-down']);
  });

  it('merges the same course across grades only when grades match, and courses within a grade', () => {
    const tree = groupMistakesByCurriculum([
      record({ subject: 'math', gradeSemester: 'grade-1-up', questionIdLike: 1 } as never),
      record({ subject: 'math', gradeSemester: 'grade-1-up', sceneId: 'sc2' } as never),
    ]);
    const grade = tree[0]!.grades[0]!;
    expect(grade.stages).toHaveLength(1);
    expect(grade.stages[0]!.records).toHaveLength(2);
  });

  it('routes missing or invalid classification to unclassified', () => {
    const tree = groupMistakesByCurriculum([
      record({}),
      record({ subject: '物理', gradeSemester: 'grade-9-up' } as never),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.subject).toBe('unclassified');
    expect(tree[0]!.grades[0]!.grade).toBe('unclassified');
    expect(tree[0]!.grades[0]!.stages[0]!.records).toHaveLength(2);
  });

  it('keeps records intact through grouping', () => {
    const input = [record({ subject: 'english', gradeSemester: 'other', stageId: 'sx' })];
    const leaf = groupMistakesByCurriculum(input)[0]!.grades[0]!.stages[0]!;
    expect(leaf.records[0]).toBe(input[0]);
  });
});
