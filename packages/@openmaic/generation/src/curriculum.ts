/**
 * Curriculum taxonomy — the stable machine codes for a course's subject and
 * grade/semester, emitted by outline generation and stored on the stage.
 *
 * Codes are fixed English tokens so stored values stay groupable and
 * i18n-able; the app side maps them to localized labels. Keep both lists
 * CLOSED: the outline template teaches exactly these values, and the manual
 * picker offers exactly these values.
 */

export const COURSE_SUBJECTS = ['chinese', 'math', 'english', 'science', 'other'] as const;
export type CourseSubject = (typeof COURSE_SUBJECTS)[number];

export const GRADE_SEMESTERS = [
  'grade-1-up',
  'grade-1-down',
  'grade-2-up',
  'grade-2-down',
  'grade-3-up',
  'grade-3-down',
  'grade-4-up',
  'grade-4-down',
  'grade-5-up',
  'grade-5-down',
  'grade-6-up',
  'grade-6-down',
  'other',
] as const;
export type GradeSemester = (typeof GRADE_SEMESTERS)[number];

/**
 * Normalize one raw model/user-supplied value to a valid code, or null.
 * Accepts the exact token case-insensitively; everything else — including
 * free-text values like "数学" — is rejected: the model is taught the codes,
 * and silently accepting synonyms would fork the taxonomy.
 */
export function normalizeCourseSubject(raw: unknown): CourseSubject | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toLowerCase();
  return (COURSE_SUBJECTS as readonly string[]).includes(token) ? (token as CourseSubject) : null;
}

export function normalizeGradeSemester(raw: unknown): GradeSemester | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toLowerCase();
  return (GRADE_SEMESTERS as readonly string[]).includes(token) ? (token as GradeSemester) : null;
}
