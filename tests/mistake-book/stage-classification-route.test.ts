/**
 * Unit tests for the curriculum-classification half of `PATCH /api/stages/[id]`.
 * The owner document store is mocked; these pin body validation and the
 * stage-field merge, not persistence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => true,
}));

const mocks = vi.hoisted(() => ({
  loadDocument: vi.fn(),
  saveDocument: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: vi.fn(async () => ({
    loadDocument: mocks.loadDocument,
    saveDocument: mocks.saveDocument,
  })),
}));

const DOCUMENT = {
  stage: {
    id: 'stage1',
    name: 'Old name',
    createdAt: 1,
    updatedAt: 1,
  },
  scenes: [],
};

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/stages/stage1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function routeContext() {
  return { params: Promise.resolve({ id: 'stage1' }) } as never;
}

async function callPatch(body: unknown) {
  const { PATCH } = await import('@/app/api/stages/[id]/route');
  return PATCH(patchRequest(body), routeContext());
}

beforeEach(() => {
  vi.resetModules();
  mocks.loadDocument.mockReset().mockResolvedValue(structuredClone(DOCUMENT));
  mocks.saveDocument.mockReset().mockResolvedValue(undefined);
});

describe('PATCH /api/stages/[id] curriculum classification', () => {
  it('sets subject and gradeSemester on the stage', async () => {
    await callPatch({ subject: 'math', gradeSemester: 'grade-1-up' });

    expect(mocks.saveDocument).toHaveBeenCalledTimes(1);
    const saved = mocks.saveDocument.mock.calls[0]![0] as { stage: Record<string, unknown> };
    expect(saved.stage.subject).toBe('math');
    expect(saved.stage.gradeSemester).toBe('grade-1-up');
    expect(saved.stage.name).toBe('Old name');
  });

  it('clears classification with explicit null (key dropped from the stage)', async () => {
    // Seed a stage that carries classification, then clear it.
    mocks.loadDocument.mockResolvedValue({
      ...structuredClone(DOCUMENT),
      stage: { ...DOCUMENT.stage, subject: 'math', gradeSemester: 'grade-1-up' },
    });
    await callPatch({ subject: null, gradeSemester: null });

    const saved = mocks.saveDocument.mock.calls[0]![0] as { stage: Record<string, unknown> };
    expect(saved.stage).not.toHaveProperty('subject');
    expect(saved.stage).not.toHaveProperty('gradeSemester');
  });

  it('rejects free-text and out-of-list codes', async () => {
    for (const body of [
      { subject: '数学' },
      { subject: 'physics' },
      { gradeSemester: 'grade-9-up' },
      { gradeSemester: 3 },
    ]) {
      const response = await callPatch(body);
      expect(response.status).toBe(400);
    }
    expect(mocks.saveDocument).not.toHaveBeenCalled();
  });

  it('rejects a body with nothing to update', async () => {
    const response = await callPatch({});
    expect(response.status).toBe(400);
  });

  it('still renames and can combine rename with classification', async () => {
    await callPatch({ name: '新名字', subject: 'chinese' });

    const saved = mocks.saveDocument.mock.calls[0]![0] as { stage: Record<string, unknown> };
    expect(saved.stage.name).toBe('新名字');
    expect(saved.stage.subject).toBe('chinese');
    expect(saved.stage.gradeSemester).toBeUndefined();
  });

  it('rejects an empty rename value like the legacy contract', async () => {
    const response = await callPatch({ name: '   ' });
    expect(response.status).toBe(400);
  });
});
