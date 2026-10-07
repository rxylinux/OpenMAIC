/**
 * `/api/azure-voices` — strict-public caller contract, real transport.
 *
 * The voice-list base URL is always explicit request input, so these tests run
 * with NO operator opt-in anywhere: every private/literal/metadata/rebinding
 * target must be refused by the real guard or the real pinned dispatcher, and
 * no socket may reach a loopback answer. Positive responses and redirect
 * refusal are covered in `azure-voices-caller-transport.test.ts` with the
 * external socket boundary mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/azure-voices/route';
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

async function postAzureVoices(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/azure-voices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const FIXED_FAILURE = {
  success: false,
  errorCode: 'INTERNAL_ERROR',
  error: 'Failed to fetch voices from Azure',
};

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/azure-voices (caller URLs: strict public)', () => {
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

  it('refuses a private-network base URL even with the operator opt-in set', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await postAzureVoices({
      apiKey: 'key',
      baseUrl: 'http://192.168.1.10/',
    });

    expect(res.status).toBe(403);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Local/private network URLs are not allowed'),
    });
  });

  it('refuses a loopback base URL even with the operator opt-in set', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const loopback = await startLoopback();

    const res = await postAzureVoices({ apiKey: 'key', baseUrl: loopback.origin });

    expect(res.status).toBe(403);
    expect(loopback.requests()).toBe(0);
  });

  it('refuses a literal metadata target under every policy', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await postAzureVoices({
      apiKey: 'key',
      baseUrl: 'http://169.254.169.254/',
    });

    expect(res.status).toBe(403);
    expect(res.json).toEqual({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Cloud instance metadata endpoints'),
    });
  });

  it('refuses a rebinding hostname before any socket reaches the loopback answer', async () => {
    const internal = await startLoopback();
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    const res = await postAzureVoices({
      apiKey: 'key',
      baseUrl: 'https://rebinding.example.test',
    });

    expect(res.status).toBe(500);
    expect(res.json).toEqual(FIXED_FAILURE);
    expect(internal.requests()).toBe(0);
  });

  it('rejects an unresolvable hostname at the URL layer with the guard text', async () => {
    mocks.promisesLookup.mockRejectedValue(new Error('ENOTFOUND synthetic-dns'));
    const unresolvable = await postAzureVoices({
      apiKey: 'key',
      baseUrl: 'https://no-such-host.example.test',
    });
    expect(unresolvable.status).toBe(403);
    expect(unresolvable.json).toEqual({
      success: false,
      errorCode: 'INVALID_URL',
      error: 'Unable to verify hostname safety',
    });
  });

  it('validates the required fields first', async () => {
    const noKey = await postAzureVoices({ baseUrl: 'https://api.example.test' });
    expect(noKey.status).toBe(400);

    const noUrl = await postAzureVoices({ apiKey: 'key' });
    expect(noUrl.status).toBe(400);
  });
});
