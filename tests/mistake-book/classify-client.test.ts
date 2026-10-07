/**
 * Client contract for the single classify command: ONE request to
 * /api/mistakes with the tri-state body forwarded verbatim; network failures
 * resolve to false (never throw) so the dialog can stay open for retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildRetryPayload, classifyStage } from '@/lib/mistake-book/client';
import type { MistakeRecordView } from '@/lib/persistence/mistake-book';

function jsonResponse(ok: boolean, status = ok ? 200 : 500) {
  return { ok, status, json: async () => ({ success: ok }) };
}

afterEach(() => {
  mocks.fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('classifyStage client', () => {
  it('sends exactly one request with the tri-state body', async () => {
    mocks.fetchMock.mockResolvedValue(jsonResponse(true));
    vi.stubGlobal('fetch', mocks.fetchMock);

    const ok = await classifyStage('stage1', { subject: 'math', gradeSemester: null });

    expect(ok).toBe(true);
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMock).toHaveBeenCalledWith('/api/mistakes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        classifyStage: true,
        stageId: 'stage1',
        subject: 'math',
        gradeSemester: null,
      }),
    });
  });

  it('omits absent fields instead of sending them', async () => {
    mocks.fetchMock.mockResolvedValue(jsonResponse(true));
    vi.stubGlobal('fetch', mocks.fetchMock);

    await classifyStage('stage1', { subject: null });

    const body = JSON.parse((mocks.fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ classifyStage: true, stageId: 'stage1', subject: null });
    expect('gradeSemester' in body).toBe(false);
  });

  it('resolves false on a failing response and on a network error', async () => {
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse(false, 500))
      .mockRejectedValueOnce(new TypeError('offline'));
    vi.stubGlobal('fetch', mocks.fetchMock);

    await expect(classifyStage('stage1', { subject: 'math' })).resolves.toBe(false);
    await expect(classifyStage('stage1', { subject: 'math' })).resolves.toBe(false);
  });
});

const RECORD = {
  stageId: 's1',
  stageName: '一年级数学',
  sceneId: 'sc1',
  sceneTitle: '课后练习',
  sceneOrder: 9,
  subject: 'math',
  gradeSemester: 'grade-1-up',
  questionId: 'q1',
  questionType: 'single',
  question: '3+2=?',
  options: [{ label: '5', value: 'B' }],
  correctAnswer: ['B'],
  analysis: '加法',
  lastUserAnswer: ['A'], // the STALE previous answer
  wrongCount: 1,
  firstWrongAt: '2026-10-02T00:00:00.000Z',
  lastWrongAt: '2026-10-02T00:00:00.000Z',
  masteredAt: null,
} as MistakeRecordView;

describe('buildRetryPayload (R7)', () => {
  it("ships THIS attempt's answer and the stable event id, never the stale one", () => {
    const payload = buildRetryPayload(RECORD, ['C'], 'retry-evt-1');
    expect(payload.eventId).toBe('retry-evt-1');
    expect(payload.items[0]!.userAnswer).toEqual(['C']); // not ['A']
    expect(payload.items).toHaveLength(1);
    expect(payload.subject).toBe('math');
    expect(payload.gradeSemester).toBe('grade-1-up');
  });
});
