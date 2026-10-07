/**
 * C3 §2 — unconfigured-deployment honesty for /api/mistakes.
 *
 * Every formal method (GET list, GET count, POST, PATCH, DELETE) answers the
 * SAME honest 503 when DATABASE_URL is absent OR whitespace-only, and does so
 * BEFORE any provider resolution or pool construction: both are mocked to
 * THROW if touched, proving no persistence machinery starts. A configured but
 * unreachable database is a DIFFERENT failure (not the unconfigured 503) —
 * pinned in the companion network case at the bottom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/persistence/mistake-book', () => ({
  MISTAKE_QUESTION_TYPES: ['single', 'multiple', 'short_answer'],
  captureMistakes: vi.fn(),
  listMistakes: vi.fn(),
  setMistakeMastered: vi.fn(),
  deleteMistake: vi.fn(),
  deleteStageMistakes: vi.fn(),
  deleteAllMistakes: vi.fn(),
  applyStageClassification: vi.fn(),
  mistakeRecordView: vi.fn((record: unknown) => record),
}));

// The whole point: with DATABASE_URL unset/blank these must NEVER run.
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: vi.fn(() => {
    throw new Error('PROVIDER MUST NOT BE RESOLVED when DATABASE_URL is unset');
  }),
}));
vi.mock('pg', () => ({
  Pool: vi.fn(() => {
    throw new Error('POOL MUST NOT BE CONSTRUCTED when DATABASE_URL is unset');
  }),
}));

function request(method: string, url: string, init: RequestInit = {}) {
  return new Request(url, { method, ...init }) as unknown as NextRequest;
}

const CAPTURE_BODY = {
  stageId: 'stage1',
  stageName: '一年级数学欢乐启蒙',
  sceneId: 'scene1',
  sceneTitle: '课后练习',
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

const UNCONFIGURED_CASES = [
  ['absent', undefined],
  ['whitespace-only', '   '],
] as const;

beforeEach(() => {
  vi.resetModules();
  // Restore any per-case stub in afterEach; cases stub explicitly.
});

describe.each(UNCONFIGURED_CASES)(
  'unconfigured deployment (DATABASE_URL %s) answers honest 503 on every method',
  (_label, envValue) => {
    beforeEach(() => {
      vi.stubEnv('DATABASE_URL', envValue ?? '');
      if (envValue === undefined) delete process.env.DATABASE_URL;
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('GET list', async () => {
      const { GET } = await import('@/app/api/mistakes/route');
      const response = await GET(request('GET', 'http://localhost/api/mistakes'));
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('requires server persistence');
    });

    it('GET count', async () => {
      const { GET } = await import('@/app/api/mistakes/route');
      const response = await GET(request('GET', 'http://localhost/api/mistakes?count=unmastered'));
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('requires server persistence');
    });

    it('POST capture', async () => {
      const { POST } = await import('@/app/api/mistakes/route');
      const response = await POST(
        request('POST', 'http://localhost/api/mistakes', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(CAPTURE_BODY),
        }),
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('requires server persistence');
    });

    it('PATCH mastery', async () => {
      const { PATCH } = await import('@/app/api/mistakes/route');
      const response = await PATCH(
        request('PATCH', 'http://localhost/api/mistakes', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stageId: 'stage1',
            sceneId: 'scene1',
            questionId: 'q1',
            mastered: true,
          }),
        }),
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('requires server persistence');
    });

    it('DELETE scoped', async () => {
      const { DELETE } = await import('@/app/api/mistakes/route');
      const response = await DELETE(
        request('DELETE', 'http://localhost/api/mistakes', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        }),
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('requires server persistence');
    });

    it('no persistence machinery started anywhere on the path', async () => {
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      vi.mocked(getServerPersistenceProvider).mockClear();
      // The provider/Pool mocks THROW if touched — a single request through
      // every method proves none was (a touched mock would surface as 500,
      // not the 503 asserted above; this re-checks the mocks stayed cold).
      const { GET, POST, PATCH, DELETE } = await import('@/app/api/mistakes/route');
      await GET(request('GET', 'http://localhost/api/mistakes?count=unmastered'));
      await POST(
        request('POST', 'http://localhost/api/mistakes', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(CAPTURE_BODY),
        }),
      );
      await PATCH(
        request('PATCH', 'http://localhost/api/mistakes', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stageId: 's', sceneId: 'c', questionId: 'q', mastered: true }),
        }),
      );
      await DELETE(
        request('DELETE', 'http://localhost/api/mistakes', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        }),
      );
      const provider = await import('@/lib/persistence/server-provider');
      expect(provider.getServerPersistenceProvider).not.toHaveBeenCalled();
    });
  },
);

// A CONFIGURED but unreachable database is exercised in the companion
// `no-db-network-real.test.ts` with the REAL provider/pool path (this file
// mocks the provider module precisely to prove it stays untouched).
