/**
 * Extract a curriculum taxonomy code (`subject` / `gradeSemester`) from a
 * partially or fully streamed outline-generation JSON response.
 *
 * Mirrors the route's courseTitle scan: a tolerant regex over the raw buffer
 * (the wrapper may still be mid-stream), then closed-list normalization so a
 * free-text or hallucinated value collapses to null instead of forking the
 * taxonomy the mistake book groups by.
 */
import { normalizeCourseSubject, normalizeGradeSemester } from '@/lib/curriculum/taxonomy';

function extractJsonStringField(buffer: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(buffer);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1] ?? null;
  }
}

export function extractSubjectCode(buffer: string): string | null {
  return normalizeCourseSubject(extractJsonStringField(buffer, 'subject'));
}

export function extractGradeSemesterCode(buffer: string): string | null {
  return normalizeGradeSemester(extractJsonStringField(buffer, 'gradeSemester'));
}
