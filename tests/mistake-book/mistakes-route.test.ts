/**
 * Route-level tests for `/api/mistakes`. The persistence layer is mocked:
 * these pin the HTTP contract (owner wrapper, 503 without a provider, body
 * validation, scoped deletes), not SQL behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  captureMistakes: vi.fn(),
  applyStageClassification: vi.fn(),
  listMistakes: vi.fn(),
  setMistakeMastered: vi.fn(),
  deleteMistake: vi.fn(),
  deleteStageMistakes: vi.fn(),
  deleteAllMistakes: vi.fn(),
  mistakeRecordView: vi.fn((record: { questionId: string }) => ({
    ...record,
    firstWrongAt: '2026-10-02T00:00:00.000Z',
    lastWrongAt: '2026-10-02T00:00:00.000Z',
    masteredAt: null,
  })),
}));

vi.mock('@/lib/persistence/mistake-book', () => ({
  MISTAKE_QUESTION_TYPES: ['single', 'multiple', 'short_answer'],
  captureMistakes: mocks.captureMistakes,
  applyStageClassification: mocks.applyStageClassification,
  listMistakes: mocks.listMistakes,
  setMistakeMastered: mocks.setMistakeMastered,
  deleteMistake: mocks.deleteMistake,
  deleteStageMistakes: mocks.deleteStageMistakes,
  deleteAllMistakes: mocks.deleteAllMistakes,
  mistakeRecordView: mocks.mistakeRecordView,
}));

const providerMock = vi.hoisted(() => ({ pool: {} }));

let providerConfigured = true;
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: vi.fn(async () => (providerConfigured ? providerMock : undefined)),
}));

function request(method: string, init: RequestInit = {}, url = 'http://localhost/api/mistakes') {
  return new Request(url, { method, ...init }) as unknown as NextRequest;
}

function jsonRequest(method: string, body: unknown) {
  return request(method, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CAPTURE_BODY = {
  stageId: 'stage1',
  stageName: '一年级数学欢乐启蒙',
  sceneId: 'scene1',
  sceneTitle: '课后练习',
  sceneOrder: 9,
  items: [
    {
      questionId: 'q1',
      questionType: 'single',
      question: '3 + 2 = ?',
      options: [{ label: '5', value: 'B' }],
      correctAnswer: ['B'],
      userAnswer: 'A',
    },
  ],
};

beforeEach(() => {
  vi.resetModules();
  // The route now refuses (503) when DATABASE_URL is unset/blank (R10) —
  // the configured-path tests say so explicitly.
  process.env.DATABASE_URL = 'postgres://test-configured';
  providerConfigured = true;
  mocks.captureMistakes.mockReset().mockResolvedValue({
    created: ['q1'],
    counted: [],
    duplicates: [],
  });
  mocks.applyStageClassification.mockReset();
  mocks.listMistakes.mockReset().mockResolvedValue([]);
  mocks.setMistakeMastered.mockReset().mockResolvedValue(true);
  mocks.deleteMistake.mockReset().mockResolvedValue(true);
  mocks.deleteStageMistakes.mockReset().mockResolvedValue(2);
  mocks.deleteAllMistakes.mockReset().mockResolvedValue(3);
});

describe('POST /api/mistakes', () => {
  it('captures a valid batch with curriculum classification', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const response = await POST(
      jsonRequest('POST', { ...CAPTURE_BODY, subject: 'math', gradeSemester: 'grade-1-up' }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ success: true, data: { captured: 1 } });
    expect(mocks.captureMistakes).toHaveBeenCalledWith(
      providerMock.pool,
      expect.any(String),
      expect.objectContaining({
        stageId: 'stage1',
        sceneTitle: '课后练习',
        subject: 'math',
        gradeSemester: 'grade-1-up',
      }),
      expect.arrayContaining([expect.objectContaining({ questionId: 'q1' })]),
      expect.objectContaining({ eventIds: expect.any(Array) }), // R9 contract wired
    );
  });

  it('passes the item knowledge point through the capture whitelist', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const response = await POST(
      jsonRequest('POST', {
        ...CAPTURE_BODY,
        items: [{ ...CAPTURE_BODY.items[0]!, knowledgePoint: '10 以内加法' }],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.captureMistakes).toHaveBeenCalledWith(
      providerMock.pool,
      expect.any(String),
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ knowledgePoint: '10 以内加法' })]),
      expect.anything(),
    );
  });

  it('rejects a malformed knowledge point with a 400', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    for (const knowledgePoint of [42, 'x'.repeat(201)]) {
      const response = await POST(
        jsonRequest('POST', {
          ...CAPTURE_BODY,
          items: [{ ...CAPTURE_BODY.items[0]!, knowledgePoint }],
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.captureMistakes).not.toHaveBeenCalled();
  });

  it('answers 503 when server persistence is not configured', async () => {
    providerConfigured = false;
    const { POST } = await import('@/app/api/mistakes/route');
    const response = await POST(jsonRequest('POST', CAPTURE_BODY));

    expect(response.status).toBe(503);
    expect(mocks.captureMistakes).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies with a generic 400', async () => {
    const { POST } = await import('@/app/api/mistakes/route');

    const badBodies: unknown[] = [
      null,
      { stageId: 'stage1', sceneId: 'scene1', stageName: 'x', items: [] },
      { ...CAPTURE_BODY, items: [{ ...CAPTURE_BODY.items[0]!, questionType: 'essay' }] },
      { ...CAPTURE_BODY, items: [{ ...CAPTURE_BODY.items[0]!, question: '' }] },
      { ...CAPTURE_BODY, stageId: '' },
      { ...CAPTURE_BODY, subject: '数学' },
      { ...CAPTURE_BODY, gradeSemester: 'grade-9-up' },
    ];
    for (const body of badBodies) {
      const response = await POST(jsonRequest('POST', body));
      expect(response.status).toBe(400);
    }
    expect(mocks.captureMistakes).not.toHaveBeenCalled();
  });
});

describe('GET /api/mistakes', () => {
  it('lists with the requested filter and stageId', async () => {
    mocks.listMistakes.mockResolvedValue([
      { ownerId: 'o', stageId: 'stage1', sceneId: 'scene1', questionId: 'q1', wrongCount: 2 },
    ]);
    const { GET } = await import('@/app/api/mistakes/route');
    const response = await GET(
      request('GET', {}, 'http://localhost/api/mistakes?filter=unmastered&stageId=stage1'),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.mistakes).toHaveLength(1);
    expect(mocks.listMistakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ filter: 'unmastered', stageId: 'stage1' }),
    );
  });

  it('falls back to the all filter for unknown filter values', async () => {
    const { GET } = await import('@/app/api/mistakes/route');
    await GET(request('GET', {}, 'http://localhost/api/mistakes?filter=bogus'));

    expect(mocks.listMistakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ filter: 'all' }),
    );
  });
});

describe('PATCH /api/mistakes', () => {
  it('marks a mistake mastered by composite key', async () => {
    const { PATCH } = await import('@/app/api/mistakes/route');
    const response = await PATCH(
      jsonRequest('PATCH', {
        stageId: 'stage1',
        sceneId: 'scene1',
        questionId: 'q1',
        mastered: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.setMistakeMastered).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { stageId: 'stage1', sceneId: 'scene1', questionId: 'q1' },
      true,
    );
  });

  it('answers 404 when the key matches no row', async () => {
    mocks.setMistakeMastered.mockResolvedValue(false);
    const { PATCH } = await import('@/app/api/mistakes/route');
    const response = await PATCH(
      jsonRequest('PATCH', {
        stageId: 'stage1',
        sceneId: 'scene1',
        questionId: 'gone',
        mastered: true,
      }),
    );
    expect(response.status).toBe(404);
  });

  it('classifies a stage through the single command with tri-state fields', async () => {
    mocks.applyStageClassification.mockResolvedValue({
      matched: true,
      mistakeRows: 4,
      courseUpdated: true,
      classification: { subject: 'math', gradeSemester: null, source: 'manual', updatedAt: 1 },
    });
    const { PATCH } = await import('@/app/api/mistakes/route');
    const response = await PATCH(
      jsonRequest('PATCH', {
        classifyStage: true,
        stageId: 'stage1',
        subject: 'math',
        gradeSemester: null,
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        classified: 4,
        courseUpdated: true,
        classification: { subject: 'math', gradeSemester: null },
      },
    });
    // ONE storage command, tri-state forwarded verbatim (null = clear).
    expect(mocks.applyStageClassification).toHaveBeenCalledWith(
      expect.anything(),
      { ownerId: expect.any(String), stageId: 'stage1' },
      { subject: 'math', gradeSemester: null },
    );
    // The mastered branch must not have run for the classify variant.
    expect(mocks.setMistakeMastered).not.toHaveBeenCalled();
  });

  it('answers 404 when nothing of the owner matches the stage', async () => {
    mocks.applyStageClassification.mockResolvedValue({
      matched: false,
      classification: null,
      mistakeRows: 0,
      courseUpdated: false,
    });
    const { PATCH } = await import('@/app/api/mistakes/route');
    const response = await PATCH(
      jsonRequest('PATCH', { classifyStage: true, stageId: 'ghost', subject: 'math' }),
    );
    expect(response.status).toBe(404);
  });

  it('rejects invalid codes and empty tri-state patches without writing', async () => {
    const { PATCH } = await import('@/app/api/mistakes/route');
    for (const body of [
      { classifyStage: true, stageId: 'stage1', subject: '数学' },
      { classifyStage: true, stageId: 'stage1', gradeSemester: 'grade-9-up' },
      { classifyStage: true, stageId: 'stage1' },
      { classifyStage: true, stageId: '', subject: null },
    ]) {
      const response = await PATCH(jsonRequest('PATCH', body));
      expect(response.status).toBe(400);
    }
    expect(mocks.applyStageClassification).not.toHaveBeenCalled();
  });

  it('R1: classification works while the stages route is runtime-gated off (no flag mocks)', async () => {
    // The real feature flag (unset env = agent runtime OFF) makes the stages
    // PATCH answer 404, while the mistakes classify command — whose handler
    // never consults the flag — still succeeds against the same provider.
    // Both routes are the REAL ones here; only the storage layer is mocked.
    mocks.applyStageClassification.mockResolvedValue({
      matched: true,
      mistakeRows: 1,
      courseUpdated: false,
      classification: { subject: 'math', gradeSemester: null, source: 'manual', updatedAt: 1 },
    });
    const { PATCH: patchMistakes } = await import('@/app/api/mistakes/route');
    const stagesRoute = await import('@/app/api/stages/[id]/route');

    const stagesResponse = await stagesRoute.PATCH(jsonRequest('PATCH', { name: 'x' }), {
      params: Promise.resolve({ id: 'stage1' }),
    } as never);
    const mistakesResponse = await patchMistakes(
      jsonRequest('PATCH', { classifyStage: true, stageId: 'stage1', subject: 'math' }),
    );

    expect(stagesResponse.status).toBe(404); // runtime gate: untouched
    expect(mistakesResponse.status).toBe(200); // classification: works anyway
    expect(mocks.applyStageClassification).toHaveBeenCalledOnce();
  });
});

describe('DELETE /api/mistakes', () => {
  it('deletes one row by composite key', async () => {
    const { DELETE } = await import('@/app/api/mistakes/route');
    const response = await DELETE(
      jsonRequest('DELETE', { stageId: 'stage1', sceneId: 'scene1', questionId: 'q1' }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.deleted).toBe(1);
    expect(mocks.deleteMistake).toHaveBeenCalledOnce();
    expect(mocks.deleteStageMistakes).not.toHaveBeenCalled();
    expect(mocks.deleteAllMistakes).not.toHaveBeenCalled();
  });

  it('deletes a whole stage when only stageId is given', async () => {
    const { DELETE } = await import('@/app/api/mistakes/route');
    const response = await DELETE(jsonRequest('DELETE', { stageId: 'stage1' }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.deleted).toBe(2);
    expect(mocks.deleteStageMistakes).toHaveBeenCalledOnce();
    expect(mocks.deleteMistake).not.toHaveBeenCalled();
  });

  it('deletes everything for the owner with all: true', async () => {
    const { DELETE } = await import('@/app/api/mistakes/route');
    const response = await DELETE(jsonRequest('DELETE', { all: true }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.deleted).toBe(3);
    expect(mocks.deleteAllMistakes).toHaveBeenCalledOnce();
  });

  it('rejects ambiguous delete scopes with 400', async () => {
    const { DELETE } = await import('@/app/api/mistakes/route');
    const response = await DELETE(jsonRequest('DELETE', { sceneId: 'scene1' }));
    expect(response.status).toBe(400);
  });
});
