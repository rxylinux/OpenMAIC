/**
 * `/api/provider/probe-models` caller positives and redirect refusal, with
 * only the external socket boundary mocked (see azure-voices-caller-transport
 * for the pattern rationale).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/provider/probe-models/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  undiciFetch: vi.fn(),
  agentOptions: [] as unknown[],
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn(),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: async (input: unknown, init?: { redirect?: string }) => {
      const response = (await mocks.undiciFetch(
        input,
        init as Record<string, unknown>,
      )) as Response;
      if (init?.redirect === 'error' && response.status >= 300 && response.status < 400) {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      }
      return response;
    },
    Agent: class {
      constructor(options: unknown) {
        mocks.agentOptions.push(options);
      }
      destroy() {
        return Promise.resolve();
      }
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function postProbeModels(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/provider/probe-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

describe('POST /api/provider/probe-models (socket boundary mocked)', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    mocks.undiciFetch.mockReset();
    mocks.agentOptions.length = 0;
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    destroyAudioProviderDispatchersForTests();
  });

  it('returns the filtered model list through the pinned transport', async () => {
    mocks.undiciFetch.mockImplementation(async (url: unknown) => {
      // First candidate misses; the stripped-root fallback answers the list.
      if (url === 'https://gw.example.test/api/anthropic/v1/models') {
        return new Response('', { status: 404 });
      }
      if (url === 'https://gw.example.test/v1/models') {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'chat-model', owned_by: 'provider' },
              { id: 'text-embedding-3-small', owned_by: 'provider' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected url ${String(url)}`);
    });

    const res = await postProbeModels({
      baseUrl: 'https://gw.example.test/api/anthropic',
      apiKey: 'test-key',
    });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      success: true,
      models: [{ id: 'chat-model', ownedBy: 'provider' }],
      total: 2,
      filtered: 1,
    });
    const init = mocks.undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
    expect(mocks.agentOptions.length).toBeGreaterThan(0);
  });

  it.each([401, 403])(
    'maps an upstream %i to the fixed API-key contract without the body',
    async (status) => {
      mocks.undiciFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'internal-secret-marker' } }), {
          status,
        }),
      );

      const res = await postProbeModels({ baseUrl: 'https://api.example.test', apiKey: 'bad' });

      expect(res.status).toBe(401);
      expect(res.json).toEqual({
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: 'API key is invalid or expired',
      });
      expect(JSON.stringify(res.json)).not.toContain('internal-secret-marker');
    },
  );

  it('refuses a redirect answer and maps it to the redirect contract', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/x' } }),
    );

    const res = await postProbeModels({ baseUrl: 'https://api.example.test', apiKey: 'key' });

    expect(res.status).toBe(403);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'REDIRECT_NOT_ALLOWED',
      error: 'Redirects are not allowed',
    });
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('signals a missing model list via 404 for the manual-entry UI', async () => {
    mocks.undiciFetch.mockResolvedValue(new Response('', { status: 404 }));

    const res = await postProbeModels({ baseUrl: 'https://api.example.test', apiKey: 'key' });

    expect(res.status).toBe(404);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'This provider does not expose a model list',
    });
  });

  it('reports another HTTP status without the provider body', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response('internal-secret-marker-body', { status: 500 }),
    );

    const res = await postProbeModels({ baseUrl: 'https://api.example.test', apiKey: 'key' });

    expect(res.status).toBe(502);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'The provider answered HTTP 500',
    });
    expect(JSON.stringify(res.json)).not.toContain('internal-secret-marker');
  });
});
