/**
 * `/api/proxy-media` — the validated dispatcher is honored by the real
 * undici runtime path.
 *
 * The existing `proxy-media.test.ts` freezes the route contract with a
 * stubbed global fetch. This file runs the REAL fetch: only `node:dns` is
 * mocked, so a hostname whose URL-layer answer is public but whose
 * connect-time answer is loopback (rebinding) is refused BY THE DISPATCHER —
 * proving the per-hop `dispatcher` option actually reaches undici — and a
 * literal metadata target is refused by the guard with zero sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/proxy-media/route';
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

async function postProxy(url: string) {
  const request = new Request('http://localhost/api/proxy-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('POST /api/proxy-media (real undici runtime)', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
  });

  afterEach(async () => {
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  it('refuses a rebinding URL at connect time with zero sockets to the loopback answer', async () => {
    const internal = await startLoopback();

    const res = await postProxy('https://rebinding.example.test/media.png');

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Local/private network URLs are not allowed'),
    });
    expect(internal.requests()).toBe(0);
  });

  it('refuses a literal metadata target under every policy with zero sockets', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await postProxy('http://169.254.169.254/latest/meta-data');

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Cloud instance metadata endpoints'),
    });
  });

  it('refuses a loopback IP-literal URL without the operator opt-in', async () => {
    const internal = await startLoopback();

    const res = await postProxy(`${internal.origin}/media.png`);

    expect(res.status).toBe(403);
    expect(internal.requests()).toBe(0);
  });

  it('serves an operator-local asset through the dispatcher with the opt-in', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const asset = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '4' });
      res.end(Buffer.from([1, 2, 3, 4]));
    });

    const request = new Request('http://localhost/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${asset.origin}/media.png` }),
    });
    const res = await POST(request as unknown as NextRequest);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(asset.requests()).toBe(1);
  });
});
