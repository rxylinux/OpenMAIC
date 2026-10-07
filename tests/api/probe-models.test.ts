/**
 * `/api/provider/probe-models` — strict-public caller contract, real transport.
 *
 * Model discovery URLs are explicit request input, so no operator opt-in is
 * set anywhere in this file: private/literal/metadata/rebinding targets must
 * be refused by the real guard or the real pinned dispatcher with no socket
 * reaching a loopback answer. Positive and redirect contracts run in
 * `probe-models-caller-transport.test.ts` with the socket boundary mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/provider/probe-models/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
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

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/provider/probe-models (caller URLs: strict public)', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  it('refuses a private base URL even with the operator opt-in set', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await postProbeModels({
      baseUrl: 'http://192.168.1.10',
      apiKey: 'test-key',
    });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: expect.stringContaining('Local/private network URLs are not allowed'),
    });
  });

  it('refuses a loopback base URL even with the operator opt-in set', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const loopback = await startLoopback();

    const res = await postProbeModels({ baseUrl: loopback.origin, apiKey: 'key' });

    expect(res.status).toBe(400);
    expect(loopback.requests()).toBe(0);
  });

  it('refuses a literal metadata target under every policy', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await postProbeModels({
      baseUrl: 'http://169.254.169.254/latest',
      apiKey: 'test-key',
    });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: expect.stringContaining('Cloud instance metadata endpoints are never allowed'),
    });
  });

  it('refuses a rebinding hostname before any socket reaches the loopback answer', async () => {
    const internal = await startLoopback();
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    const res = await postProbeModels({
      baseUrl: 'https://rebinding.example.test',
      apiKey: 'test-key',
    });

    expect(res.status).toBe(502);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Cannot connect to the provider, please check the Base URL',
    });
    expect(internal.requests()).toBe(0);
  });

  it('requires a baseUrl', async () => {
    const res = await postProbeModels({ apiKey: 'key' });
    expect(res.status).toBe(400);
  });
});
