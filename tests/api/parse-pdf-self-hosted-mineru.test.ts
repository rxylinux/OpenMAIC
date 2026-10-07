/**
 * `/api/parse-pdf` with a self-hosted MinerU provider — provenance-split.
 *
 * A managed provider's endpoint is operator configuration and receives the
 * real multipart upload on a real loopback server through the pinned managed
 * transport (local networks allowed without the opt-in). Caller-supplied
 * endpoints are strict-public: this file keeps the real transport and NO
 * opt-in, so rebinding/private targets are refused with no upload leaving the
 * process. Caller positives run in the boundary-mocked sibling file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/parse-pdf/route';
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
  resolvePDFApiKey: vi.fn(),
  resolvePDFBaseUrl: vi.fn(),
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
  /** What the (mocked) operator config resolves for a managed provider. */
  managedBaseUrl: undefined as string | undefined,
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
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

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x62, 0x6f, 0x64, 0x79, 0x0a,
]);

async function postParsePdf(baseUrl: string, managed: boolean) {
  mocks.isServerConfiguredProvider.mockReturnValue(managed);
  mocks.resolvePDFApiKey.mockReturnValue(managed ? 'server-key' : 'synthetic-key');
  // Managed: the operator-configured server URL wins; unmanaged: the client's.
  mocks.resolvePDFBaseUrl.mockImplementation(
    (_id: string, client?: string) => client ?? (managed ? mocks.managedBaseUrl : undefined),
  );

  const form = new FormData();
  form.append('pdf', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'lesson.pdf');
  form.append('providerId', 'mineru');
  form.append('apiKey', 'synthetic-key');
  form.append('baseUrl', baseUrl);

  // No manual Content-Type: the runtime attaches the multipart boundary.
  const request = new Request('http://localhost/api/parse-pdf', { method: 'POST', body: form });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json().catch(() => null) };
}

function mineruResult() {
  return startLoopback((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        results: { 'lesson.pdf': { md_content: '# Parsed lesson', images: {}, content_list: [] } },
      }),
    );
  });
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/parse-pdf (self-hosted MinerU)', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) {
        (mock as { mockReset: () => void }).mockReset();
      }
    }
    mocks.managedBaseUrl = undefined;
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

  it('delivers the multipart upload intact through the managed pinned transport', async () => {
    const provider = await mineruResult();
    mocks.managedBaseUrl = provider.origin;

    const res = await postParsePdf(provider.origin, true);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).toContain('Parsed lesson');

    // The multipart body survived the pinned transport with the real undici
    // FormData serialization: the PDF part and the form fields are all present.
    const body = provider.lastBody()!.toString('utf8');
    expect(body).toContain('name="files"');
    expect(body).toContain('filename="lesson.pdf"');
    expect(body).toContain('name="parse_method"');
    expect(body).toContain('name="return_content_list"');
    expect(body).toContain('name="backend"');
    expect(provider.lastHeaders()?.['content-type']).toContain('multipart/form-data');
    expect(provider.lastHeaders()?.authorization).toBe('Bearer server-key');
  });

  it('refuses a rebinding caller hostname before any upload leaves the process', async () => {
    const internal = await startLoopback();
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    const res = await postParsePdf('https://rebinding.example.test', false);

    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({
      success: false,
      errorCode: 'PARSE_FAILED',
      error: 'Cannot connect to the self-hosted MinerU server, please check the Base URL',
    });
    expect(internal.requests()).toBe(0);
  });

  it('refuses a private caller base URL even with the operator opt-in set', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await postParsePdf('http://192.168.1.10/', false);

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Local/private network URLs are not allowed'),
    });
  });

  it('reports an upstream error status without the provider body', async () => {
    const provider = await startLoopback((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'internal-secret-marker' }));
    });
    mocks.managedBaseUrl = provider.origin;

    const res = await postParsePdf(provider.origin, true);

    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({
      success: false,
      errorCode: 'PARSE_FAILED',
      error: 'MinerU API error (500)',
    });
    expect(JSON.stringify(res.json)).not.toContain('internal-secret-marker');
  });
});
