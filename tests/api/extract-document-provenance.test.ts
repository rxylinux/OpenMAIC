/**
 * `/api/extract-document` endpoint provenance wiring.
 *
 * The real route with the real URL guard (`node:dns` mocked to public
 * answers): an explicit request URL is strict-public (never inherits the
 * operator opt-in), an AliDocMind endpoint accepts only official hosts, and
 * the resolved provenance flags (`managed`, `callerSuppliedBaseUrl`) reach the
 * parser config the extraction boundary forwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolvePDFApiKey: vi.fn(),
  resolvePDFBaseUrl: vi.fn(),
  resolveManagedAliDocMindCredentials: vi.fn(),
  parseWithMinerUCloud: vi.fn(),
  resolveServerAsset: vi.fn(),
  promisesLookup: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
  getServerPDFProviders: () => ({}),
  resolveServerMediaExtractorConfig: () => ({ providerId: '' }),
}));

vi.mock('@/lib/pdf/mineru-cloud', () => ({
  parseWithMinerUCloud: mocks.parseWithMinerUCloud,
}));

vi.mock('@/lib/persistence/resolve-server-asset', () => ({
  resolveServerAsset: mocks.resolveServerAsset,
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn(),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

async function postExtractDocument(input: {
  file: File;
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  const { POST } = await import('@/app/api/extract-document/route');
  const formData = new FormData();
  formData.append('file', input.file);
  if (input.providerId) formData.append('providerId', input.providerId);
  if (input.apiKey) formData.append('apiKey', input.apiKey);
  if (input.baseUrl) formData.append('baseUrl', input.baseUrl);
  const request = new Request('http://localhost/api/extract-document', {
    method: 'POST',
    body: formData,
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/extract-document — endpoint provenance', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolvePDFApiKey.mockImplementation((_id: string, client?: string) => client || '');
    mocks.resolvePDFBaseUrl.mockImplementation((_id: string, client?: string) => client);
    mocks.resolveManagedAliDocMindCredentials.mockReturnValue(undefined);
    mocks.resolveServerAsset.mockReset();
    mocks.parseWithMinerUCloud.mockReset();
    mocks.parseWithMinerUCloud.mockResolvedValue({
      text: 'cloud parsed text',
      images: [],
      metadata: { pageCount: 1, parser: 'mineru-cloud' },
    });
    mocks.promisesLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  it('forwards callerSuppliedBaseUrl=true for an unmanaged explicit URL', async () => {
    const res = await postExtractDocument({
      file: new File(['%PDF-1.7 x'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'mineru-cloud',
      apiKey: 'client-key',
      baseUrl: 'https://cloud.example.test',
    });

    expect(res.status).toBe(200);
    expect(mocks.parseWithMinerUCloud).toHaveBeenCalledTimes(1);
    const config = mocks.parseWithMinerUCloud.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.callerSuppliedBaseUrl).toBe(true);
    expect(config.managed).toBe(false);
  });

  it('forwards managed=true and no caller flag for a managed provider', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolvePDFApiKey.mockReturnValue('server-key');
    mocks.resolvePDFBaseUrl.mockReturnValue('https://cloud.example.test');

    const res = await postExtractDocument({
      file: new File(['%PDF-1.7 x'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'mineru-cloud',
      baseUrl: 'https://ignored-because-managed.example.test',
    });

    expect(res.status).toBe(200);
    const config = mocks.parseWithMinerUCloud.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.managed).toBe(true);
    expect(config.callerSuppliedBaseUrl).toBe(false);
  });

  it('refuses a private explicit URL even with the operator opt-in set', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await postExtractDocument({
      file: new File(['%PDF-1.7 x'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'mineru',
      baseUrl: 'http://192.168.1.10/',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Local/private network URLs are not allowed'),
    });
    expect(mocks.parseWithMinerUCloud).not.toHaveBeenCalled();
  });

  it('refuses a non-official AliDocMind endpoint before any SDK call', async () => {
    const res = await postExtractDocument({
      file: new File(['%PDF-1.7 x'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'alidocmind',
      baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com.example.test',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
      error: 'Only official AliDocMind endpoints (docmind-api.<region>.aliyuncs.com) are supported',
    });
  });
});
