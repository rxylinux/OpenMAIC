/**
 * App-side re-export of the curriculum taxonomy (canonical home is the
 * generation package, whose outline parser also consumes it) plus the
 * mistake-book grouping tree builder used by the UI.
 */
import {
  COURSE_SUBJECTS,
  GRADE_SEMESTERS,
  normalizeCourseSubject,
  normalizeGradeSemester,
} from '@openmaic/generation';

export { COURSE_SUBJECTS, GRADE_SEMESTERS, normalizeCourseSubject, normalizeGradeSemester };
export type { CourseSubject, GradeSemester } from '@openmaic/generation';

/** i18n key for a subject code ('math' -> 'mistakeBook.subject_math'). */
export function subjectLabelKey(subject: string): string {
  return `mistakeBook.subject_${subject}`;
}

/** i18n key for a grade/semester code ('grade-3-up' -> 'mistakeBook.grade_grade-3-up'). */
export function gradeSemesterLabelKey(grade: string): string {
  return `mistakeBook.grade_${grade}`;
}

/**
 * Group mistakes into the subject -> grade/semester -> course tree the
 * mistake book renders. Records with a missing/invalid field land under
 * `unclassified` so nothing is silently dropped; tree order follows the
 * taxonomy lists.
 */
export interface MistakeGroupNode<T> {
  key: string;
  subject: string;
  grades: Array<{
    key: string;
    grade: string;
    stages: Array<{ key: string; stageId: string; stageName: string; records: T[] }>;
  }>;
}

interface GroupableRecord {
  stageId: string;
  stageName: string;
  subject?: string | null;
  gradeSemester?: string | null;
}

export function groupMistakesByCurriculum<T extends GroupableRecord>(
  records: readonly T[],
): MistakeGroupNode<T>[] {
  const subjectOrder: readonly string[] = [...COURSE_SUBJECTS, 'unclassified'];
  const gradeOrder: readonly string[] = [...GRADE_SEMESTERS, 'unclassified'];

  const subjects = new Map<string, MistakeGroupNode<T>>();
  const gradeOf = (node: MistakeGroupNode<T>, grade: string) =>
    node.grades.find((entry) => entry.grade === grade);
  const stageOf = (
    node: MistakeGroupNode<T>['grades'][number],
    stageId: string,
    stageName: string,
  ) => {
    let stage = node.stages.find((entry) => entry.stageId === stageId);
    if (!stage) {
      stage = { key: stageId, stageId, stageName, records: [] };
      node.stages.push(stage);
    }
    return stage;
  };

  for (const record of records) {
    const subject = subjectOrder.includes(record.subject ?? '') ? record.subject! : 'unclassified';
    const grade = gradeOrder.includes(record.gradeSemester ?? '')
      ? record.gradeSemester!
      : 'unclassified';

    let subjectNode = subjects.get(subject);
    if (!subjectNode) {
      subjectNode = { key: subject, subject, grades: [] };
      subjects.set(subject, subjectNode);
    }
    let gradeNode = gradeOf(subjectNode, grade);
    if (!gradeNode) {
      gradeNode = { key: `${subject}:${grade}`, grade, stages: [] };
      subjectNode.grades.push(gradeNode);
    }
    stageOf(gradeNode, record.stageId, record.stageName).records.push(record);
  }

  const ordered = [...subjects.values()].sort(
    (a, b) => subjectOrder.indexOf(a.subject) - subjectOrder.indexOf(b.subject),
  );
  for (const node of ordered) {
    node.grades.sort((a, b) => gradeOrder.indexOf(a.grade) - gradeOrder.indexOf(b.grade));
    for (const grade of node.grades) {
      grade.stages.sort((a, b) => a.stageName.localeCompare(b.stageName));
    }
  }
  return ordered;
}
