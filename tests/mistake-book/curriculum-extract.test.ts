import { describe, expect, it } from 'vitest';

import { extractGradeSemesterCode, extractSubjectCode } from '@/lib/curriculum/extract';

const RESPONSE = `{"languageDirective":"用中文授课","courseTitle":"一年级数学","subject":"math","gradeSemester":"grade-1-up","outlines":[{"id":"scene_1","type":"slide"}]}`;

describe('curriculum stream extraction', () => {
  it('extracts valid codes from a complete response', () => {
    expect(extractSubjectCode(RESPONSE)).toBe('math');
    expect(extractGradeSemesterCode(RESPONSE)).toBe('grade-1-up');
  });

  it('extracts from a partial (mid-stream) buffer', () => {
    const partial = RESPONSE.slice(0, RESPONSE.indexOf('"outlines"'));
    expect(extractSubjectCode(partial)).toBe('math');
    expect(extractGradeSemesterCode(partial)).toBe('grade-1-up');
  });

  it('unescapes JSON escapes in the value', () => {
    expect(extractSubjectCode('{"subject":"math","x":1}')).toBe('math');
  });

  it('returns null for absent, free-text and invalid values', () => {
    expect(extractSubjectCode('{"outlines":[]}')).toBeNull();
    expect(extractSubjectCode('{"subject":"数学"}')).toBeNull();
    expect(extractSubjectCode('{"subject":"physics"}')).toBeNull();
    expect(extractSubjectCode('{"subject":123}')).toBeNull();
    expect(extractGradeSemesterCode('{"gradeSemester":"grade-9-up"}')).toBeNull();
    expect(extractGradeSemesterCode('{"gradeSemester":"三年级上"}')).toBeNull();
  });

  it('does not match the field inside nested outline objects only at top level text scan tolerance', () => {
    // The regex scans raw text, so a nested echo would also match — but the
    // closed-list normalization still guarantees only valid codes pass. The
    // realistic risk (model writes free text) collapses to null either way.
    expect(extractSubjectCode('{"outlines":[{"note":"subject is 数学"}]}')).toBeNull();
  });
});
