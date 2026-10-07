/**
 * `resolveModel` → Google SDK → operator proxy, end to end at the socket
 * boundary.
 *
 * The real model resolution and the real Google provider transport run; only
 * `undici` (the socket layer) and `node:dns` are stubbed. This proves the
 * operator proxy survives the D transport rework for a server-selected Google
 * model: requests ride the ProxyAgent with per-hop validation, and a caller
 * endpoint still fails closed before any proxy dispatch.
 */
import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveApiKey: vi.fn(),
  resolveBaseUrl: vi.fn(),
  resolveProxy: vi.fn(),
  promisesLookup: vi.fn(),
  undiciFetch: vi.fn(),
  proxyAgentOptions: [] as unknown[],
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

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => mocks.undiciFetch(...(args as [unknown, unknown])),
    ProxyAgent: class {
      constructor(options: unknown) {
        mocks.proxyAgentOptions.push(options);
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

import { resolveModel } from '@/lib/server/resolve-model';
import { LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';
import { destroyProxyLlmAgentsForTests } from '@/lib/server/llm-provider-fetch';

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('resolveModel → Google SDK → operator proxy', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if ('mockReset' in (mock as object)) (mock as { mockReset: () => void }).mockReset();
    }
    mocks.proxyAgentOptions.length = 0;
    destroyProxyLlmAgentsForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveApiKey.mockReturnValue('server-key');
    mocks.resolveBaseUrl.mockReturnValue(undefined);
    mocks.resolveProxy.mockReturnValue('http://proxy.example.test:3128');
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    destroyProxyLlmAgentsForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
  });

  it('routes an operator-selected Google model through the proxy with the 15-minute budget', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: 'OK' }], role: 'model' }, finishReason: 'STOP' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const resolved = await resolveModel({ modelString: 'google:gemini-2.0-flash' });
    const result = await generateText({ model: resolved.model, prompt: 'hi', maxRetries: 0 });

    expect(result.text).toBe('OK');
    expect(mocks.proxyAgentOptions).toHaveLength(1);
    expect(mocks.proxyAgentOptions[0]).toMatchObject({
      uri: 'http://proxy.example.test:3128',
      headersTimeout: LLM_FETCH_TIMEOUT_MS,
      bodyTimeout: LLM_FETCH_TIMEOUT_MS,
    });
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
    const init = mocks.undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
  }, 20_000);

  it('refuses a DNS-named metadata first hop through the proxy with zero dispatch', async () => {
    mocks.promisesLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const resolved = await resolveModel({ modelString: 'google:gemini-2.0-flash' });
    await expect(
      generateText({ model: resolved.model, prompt: 'hi', maxRetries: 0 }),
    ).rejects.toThrow(/Cloud instance metadata endpoints/);
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  }, 20_000);

  it('refuses a literal metadata first hop through the proxy with zero dispatch', async () => {
    mocks.resolveBaseUrl.mockReturnValue('https://169.254.169.254/v1beta');

    const resolved = await resolveModel({ modelString: 'google:gemini-2.0-flash' });
    await expect(
      generateText({ model: resolved.model, prompt: 'hi', maxRetries: 0 }),
    ).rejects.toThrow(/Cloud instance metadata endpoints/);
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  }, 20_000);

  it('refuses a proxied redirect hop to a private address', async () => {
    mocks.promisesLookup.mockImplementation(async (hostname: string) =>
      hostname === 'internal.example.test'
        ? [{ address: '10.0.0.9', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
    );
    mocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://internal.example.test/v1' },
      }),
    );

    const resolved = await resolveModel({ modelString: 'google:gemini-2.0-flash' });
    await expect(
      generateText({ model: resolved.model, prompt: 'hi', maxRetries: 0 }),
    ).rejects.toThrow(/Local\/private network URLs are not allowed/);
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('fails closed for a caller-chosen endpoint when a proxy is configured', async () => {
    // The caller's endpoint only counts when the provider is unmanaged.
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    await expect(
      resolveModel({
        modelString: 'google:gemini-2.0-flash',
        apiKey: 'client-key',
        baseUrl: 'https://api.openai-compatible.example.test/v1',
      }),
    ).rejects.toThrow(/cannot be used through the server proxy/);
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  });
});
