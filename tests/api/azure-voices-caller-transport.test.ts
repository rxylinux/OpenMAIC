/**
 * `/api/azure-voices` caller positives and redirect refusal, with only the
 * external socket boundary mocked.
 *
 * The real route, the real URL guard (its DNS answers mocked to a public
 * address) and the real strict provider transport run; `undici`'s fetch and
 * Agent stand in for the network. This proves the whole production chain up to
 * the socket: the pinned dispatcher (with the strict address policy installed
 * in its connect lookup) rides the request, and the caller's strict-public
 * policy refuses a loopback answer at the (mocked) connect stage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/azure-voices/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
  undiciFetch: vi.fn(),
  agentOptions: [] as unknown[],
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    // The socket boundary stand-in also reproduces undici's redirect
    // semantics so the transport's `redirect: 'error'` path is exercised.
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

async function postAzureVoices(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/azure-voices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

/** The strict address policy installed in the pinned Agent's connect lookup. */
function installedLookup(): ((...args: unknown[]) => void) | undefined {
  const options = mocks.agentOptions.at(-1) as
    | { connect?: { lookup?: (...args: unknown[]) => void } }
    | undefined;
  return options?.connect?.lookup;
}

describe('POST /api/azure-voices (socket boundary mocked)', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    mocks.undiciFetch.mockReset();
    mocks.agentOptions.length = 0;
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    // Connect-time answers would be loopback in a rebinding attack.
    mocks.callbackLookup.mockImplementation(
      (_hostname: unknown, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) {
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
        } else {
          callback(null, '127.0.0.1', 4);
        }
      },
    );
  });

  afterEach(() => {
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
  });

  it('returns the voice list with the subscription key on the pinned transport', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response(JSON.stringify([{ ShortName: 'en-US-Aria' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await postAzureVoices({
      apiKey: 'synthetic-key',
      baseUrl: 'https://tts.example.test',
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, voices: [{ ShortName: 'en-US-Aria' }] });

    // The request rode undici's fetch with a dispatcher whose connect lookup
    // is the pinned policy (not undici's default resolution).
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
    const init = mocks.undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
    const lookup = installedLookup();
    expect(lookup).toBeTypeOf('function');
    // The installed lookup refuses a loopback connect answer under the
    // caller's strict-public policy, even with the operator opt-in set.
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const callback = vi.fn();
    lookup!('tts.example.test', { all: true }, callback);
    expect(callback).toHaveBeenCalled();
    const error = callback.mock.calls[0]![0] as Error;
    expect(error.message).toContain('Local/private network URLs are not allowed');
  });

  it('answers an auth failure with the fixed message, never the upstream body', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'internal-secret-marker' } }), {
        status: 401,
      }),
    );

    const res = await postAzureVoices({ apiKey: 'bad', baseUrl: 'https://tts.example.test' });

    expect(res.status).toBe(502);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Authentication failed, please check the API Key',
    });
    expect(JSON.stringify(res.json)).not.toContain('internal-secret-marker');
  });

  it('refuses a 3xx answer instead of following it', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/x' } }),
    );

    const res = await postAzureVoices({ apiKey: 'key', baseUrl: 'https://tts.example.test' });

    expect(res.status).toBe(500);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Failed to fetch voices from Azure',
    });
    // One request, no follow-up.
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-array JSON body with the fixed message', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response(JSON.stringify({ voices: 'internal-secret-marker' }), { status: 200 }),
    );

    const res = await postAzureVoices({ apiKey: 'key', baseUrl: 'https://tts.example.test' });

    expect(res.status).toBe(502);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Failed to fetch voices from Azure',
    });
  });
});
