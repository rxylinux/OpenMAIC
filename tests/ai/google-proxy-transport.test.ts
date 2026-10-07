/**
 * Google proxy transport wiring contract.
 *
 * Since D, the ProxyAgent lives in the operator proxy transport
 * (`lib/server/llm-provider-fetch.ts`) and `resolveModel` installs it; the
 * first hop is validated under the operator policy and a caller-chosen
 * endpoint fails closed. `getModel` therefore refuses a `proxy` config without
 * the proxy-aware `fetchImpl` instead of silently bypassing the operator's
 * proxy. The ProxyAgent budget assertions live here via resolveModel with the
 * undici boundary mocked; the full send/receive chain is covered by
 * `tests/server/llm-google-proxy.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyAgentMock = vi.hoisted(() => ({
  constructions: [] as Array<{ uri: string } & Record<string, unknown>>,
}));

vi.mock('undici', () => ({
  Agent: class {},
  ProxyAgent: class {
    constructor(options: { uri: string } & Record<string, unknown>) {
      proxyAgentMock.constructions.push(options);
    }
  },
  fetch: vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveApiKey: vi.fn(),
  resolveBaseUrl: vi.fn(),
  resolveProxy: vi.fn(),
  promisesLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveApiKey: mocks.resolveApiKey,
  resolveBaseUrl: mocks.resolveBaseUrl,
  resolveProxy: mocks.resolveProxy,
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn(),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resolveModel } from '@/lib/server/resolve-model';
import { getModel, LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';

describe('Google proxy transport', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    proxyAgentMock.constructions.length = 0;
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveApiKey.mockReturnValue('g-test');
    mocks.resolveBaseUrl.mockReturnValue(undefined);
    mocks.resolveProxy.mockReturnValue('http://proxy.example:8080');
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it('fails loud when getModel receives a proxy without the proxy-aware fetchImpl', () => {
    expect(() =>
      getModel({
        providerId: 'google',
        modelId: 'gemini-3.6-flash',
        apiKey: 'g-test',
        proxy: 'http://proxy.example:8080',
      }),
    ).toThrow(/proxy without a proxy-aware fetchImpl/);
    // No traffic can silently bypass the operator's proxy.
    expect(proxyAgentMock.constructions).toHaveLength(0);
  });

  it('resolveModel installs the proxy transport with the extended LLM timeout budget', async () => {
    const resolved = await resolveModel({ modelString: 'google:gemini-3.6-flash' });
    expect(resolved.providerId).toBe('google');

    // The proxy transport is installed lazily: issuing one request constructs
    // exactly one ProxyAgent carrying the 15-minute headers/body budget.
    await resolved.model;
    const { createProxyLlmFetch } = await import('@/lib/server/llm-provider-fetch');
    const proxyFetch = createProxyLlmFetch('http://proxy.example:8080');
    await proxyFetch('https://generativelanguage.googleapis.com/v1beta/x', { method: 'POST' });
    await proxyFetch('https://generativelanguage.googleapis.com/v1beta/x', { method: 'POST' });

    expect(proxyAgentMock.constructions).toHaveLength(1);
    expect(proxyAgentMock.constructions[0]).toMatchObject({
      uri: 'http://proxy.example:8080',
      headersTimeout: LLM_FETCH_TIMEOUT_MS,
      bodyTimeout: LLM_FETCH_TIMEOUT_MS,
    });
  });
});
