/**
 * `/api/verify-pdf-provider` — provenance-split transport tests.
 *
 * Managed endpoints are operator configuration and are probed on a real
 * loopback server through the real pinned managed transport (local networks
 * allowed without the opt-in — an operator configuration right, not a caller
 * one). Caller-supplied endpoints are strict-public: this file keeps the real
 * transport and NO opt-in, so private/literal/rebinding targets are refused
 * with no socket reaching a loopback answer. Caller positives and redirect
 * refusal run in `verify-pdf-provider-caller-transport.test.ts` with the
 * socket boundary mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/verify-pdf-provider/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveManagedAliDocMindCredentials: vi.fn(),
  resolvePDFApiKey: vi.fn(),
  resolvePDFBaseUrl: vi.fn(),
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
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

const CONNECTION_FAILED = {
  success: false,
  errorCode: 'INTERNAL_ERROR',
  error: 'Cannot connect to server, please check the Base URL',
};

async function postVerifyPdfProvider(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/verify-pdf-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/verify-pdf-provider', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolvePDFApiKey.mockReturnValue(undefined);
    mocks.resolvePDFBaseUrl.mockImplementation((_id: string, client?: string) => client);
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

  describe('managed endpoints (operator configuration)', () => {
    it('probes a managed self-hosted provider on a local network without the opt-in', async () => {
      const provider = await startLoopback((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      mocks.isServerConfiguredProvider.mockReturnValue(true);
      mocks.resolvePDFApiKey.mockReturnValue('server-key');
      mocks.resolvePDFBaseUrl.mockReturnValue(provider.origin);

      const res = await postVerifyPdfProvider({ providerId: 'mineru' });

      expect(res.json).toEqual({ success: true, message: 'Connection successful' });
      expect(provider.requests()).toBe(1);
    });

    it('reports a fixed authentication failure for a managed MinerU Cloud 401', async () => {
      const provider = await startLoopback((_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1002, msg: 'internal-secret-marker' }));
      });
      mocks.isServerConfiguredProvider.mockReturnValue(true);
      mocks.resolvePDFApiKey.mockReturnValue('cloud-key');
      mocks.resolvePDFBaseUrl.mockReturnValue(provider.origin);

      const res = await postVerifyPdfProvider({ providerId: 'mineru-cloud' });

      expect(res.json).toEqual({
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: 'Authentication failed, please check the API Key',
      });
      expect(JSON.stringify(res.json)).not.toContain('internal-secret-marker');
    });

    it('reports MinerU Cloud success without leaking the target status', async () => {
      const provider = await startLoopback((_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"code":0}');
      });
      mocks.isServerConfiguredProvider.mockReturnValue(true);
      mocks.resolvePDFApiKey.mockReturnValue('cloud-key');
      mocks.resolvePDFBaseUrl.mockReturnValue(provider.origin);

      const res = await postVerifyPdfProvider({ providerId: 'mineru-cloud' });

      expect(res.json).toEqual({ success: true, message: 'Connection successful' });
    });

    it('refuses a redirect answered by a managed endpoint', async () => {
      const internal = await startLoopback();
      const provider = await startLoopback((_req, res) => {
        res.writeHead(302, { Location: `${internal.origin}/credentials` });
        res.end();
      });
      mocks.isServerConfiguredProvider.mockReturnValue(true);
      mocks.resolvePDFApiKey.mockReturnValue('server-key');
      mocks.resolvePDFBaseUrl.mockReturnValue(provider.origin);

      const res = await postVerifyPdfProvider({ providerId: 'mineru' });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({
        success: false,
        errorCode: 'REDIRECT_NOT_ALLOWED',
        error: 'Redirects are not allowed',
      });
      expect(provider.requests()).toBe(1);
      expect(internal.requests()).toBe(0);
    });
  });

  describe('caller-supplied endpoints (strict public)', () => {
    it('refuses a private base URL even with the operator opt-in set', async () => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';

      const res = await postVerifyPdfProvider({
        providerId: 'mineru',
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

      const res = await postVerifyPdfProvider({ providerId: 'mineru', baseUrl: loopback.origin });

      // A loopback IP literal is refused at the URL layer under the strict
      // public policy, before any socket exists.
      expect(res.status).toBe(403);
      expect(res.json).toEqual({
        success: false,
        errorCode: 'INVALID_URL',
        error: expect.stringContaining('Local/private network URLs are not allowed'),
      });
      expect(loopback.requests()).toBe(0);
    });

    it('refuses a literal metadata target under every policy', async () => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';

      const res = await postVerifyPdfProvider({
        providerId: 'mineru',
        baseUrl: 'http://169.254.169.254/',
      });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({
        success: false,
        errorCode: 'INVALID_URL',
        error: expect.stringContaining('Cloud instance metadata endpoints'),
      });
    });

    it('answers a rebinding target with the fixed connection failure', async () => {
      const internal = await startLoopback();
      mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

      const res = await postVerifyPdfProvider({
        providerId: 'mineru',
        baseUrl: 'https://rebinding.example.test',
      });

      expect(res.json).toEqual(CONNECTION_FAILED);
      expect(internal.requests()).toBe(0);
    });

    it('refuses a non-official AliDocMind client endpoint before any SDK call', async () => {
      const res = await postVerifyPdfProvider({
        providerId: 'alidocmind',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
        baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com.example.test',
      });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({
        success: false,
        errorCode: 'INVALID_URL',
        error:
          'Only official AliDocMind endpoints (docmind-api.<region>.aliyuncs.com) are supported',
      });
    });
  });
});
