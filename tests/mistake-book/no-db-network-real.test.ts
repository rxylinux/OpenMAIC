/**
 * C3 §2 companion — a CONFIGURED but UNREACHABLE database is a different
 * failure from the unconfigured 503.
 *
 * This file mocks NOTHING on the persistence path: the real
 * getServerPersistenceProvider (real `pg` Pool) runs against a synthetic
 * loopback address with no listener (connection refused, bounded). The
 * response must be an honest error that is NOT the unconfigured-503 body.
 * No user data or real credentials are touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function request(method: string, url: string, init: RequestInit = {}) {
  return new Request(url, { method, ...init }) as unknown as NextRequest;
}

const CAPTURE_BODY = {
  stageId: 'stage1',
  stageName: 'C3 Network',
  sceneId: 'scene1',
  sceneTitle: 'Scene',
  items: [
    {
      questionId: 'q1',
      questionType: 'single',
      question: '1+1=?',
      options: [{ label: '2', value: 'A' }],
      correctAnswer: ['A'],
      userAnswer: 'B',
    },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('configured-but-unreachable database (REAL provider/pool path)', () => {
  it('POST surfaces the actual internal-error response (500), not a fake 200/empty and not the unconfigured 503', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://c3-synthetic:no-listener@127.0.0.1:9/c3_net');
    const { POST } = await import('@/app/api/mistakes/route');
    const response = await POST(
      request('POST', 'http://localhost/api/mistakes', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(CAPTURE_BODY),
      }),
    );
    // The with-owner wrapper maps a thrown provider/pool failure to exactly
    // this response; a bogus 200/empty body must NOT satisfy the assertion.
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Internal Server Error');
  }, 15_000);

  it('GET list likewise fails with the actual 500, never an empty-200 and never the 503', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://c3-synthetic:no-listener@127.0.0.1:9/c3_net');
    const { GET } = await import('@/app/api/mistakes/route');
    const response = await GET(request('GET', 'http://localhost/api/mistakes'));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Internal Server Error');
  }, 15_000);
});
