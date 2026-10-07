/**
 * The operator LLM proxy transport (`createProxyLlmFetch`).
 *
 * Only the socket boundary is mocked: the ProxyAgent construction, the
 * per-hop redirect validation and the caller-safe error reduction all run for
 * real. `resolveModel`'s fail-closed caller+proxy contract is covered in
 * resolve-model-pinned-transport.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProxyLlmFetch,
  destroyProxyLlmAgentsForTests,
} from '@/lib/server/llm-provider-fetch';
import { LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  proxyAgentOptions: [] as unknown[],
  promisesLookup: vi.fn(),
}));

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

describe('createProxyLlmFetch', () => {
  beforeEach(() => {
    mocks.undiciFetch.mockReset();
    mocks.proxyAgentOptions.length = 0;
    mocks.promisesLookup.mockReset();
    // The URL-layer guard resolves the target hostname publicly.
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    destroyProxyLlmAgentsForTests();
  });

  afterEach(() => {
    destroyProxyLlmAgentsForTests();
  });

  it('constructs the ProxyAgent once with the 15-minute budget', async () => {
    mocks.undiciFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');

    await proxyFetch('https://api.example.test/v1/chat/completions', { method: 'POST' });
    await proxyFetch('https://api.example.test/v1/chat/completions', { method: 'POST' });

    expect(mocks.proxyAgentOptions).toHaveLength(1);
    expect(mocks.proxyAgentOptions[0]).toMatchObject({
      uri: 'http://proxy.example.test:3128',
      headersTimeout: LLM_FETCH_TIMEOUT_MS,
      bodyTimeout: LLM_FETCH_TIMEOUT_MS,
    });
    // Both requests rode the proxy agent.
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(2);
    for (const call of mocks.undiciFetch.mock.calls) {
      expect((call[1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    }
  });

  it('validates each redirect hop under the operator policy before following it', async () => {
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');
    mocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://hop.example.test/v1' } }),
    );
    mocks.undiciFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const response = await proxyFetch('https://api.example.test/v1/chat/completions');

    expect(response.status).toBe(200);
    // Both hops carried the proxy dispatcher.
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(2);
    for (const call of mocks.undiciFetch.mock.calls) {
      expect((call[1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    }
  });

  it('refuses a redirect hop to a private address', async () => {
    // The first hop resolves publicly; only the redirect target is private.
    mocks.promisesLookup.mockImplementation(async (hostname: string) =>
      hostname === 'internal.example.test'
        ? [{ address: '10.0.0.9', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
    );
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');
    mocks.undiciFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://internal.example.test/v1' },
      }),
    );

    let caught: unknown;
    try {
      await proxyFetch('https://api.example.test/v1/chat/completions');
    } catch (error) {
      caught = error;
    }
    // An address-policy refusal keeps the guard's fixed text verbatim.
    const failure = caught as Error;
    expect(failure.name).toBe('UnsafeNetworkTargetError');
    expect(failure.message).toContain('Local/private network URLs are not allowed');
    // The internal hop was never requested.
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a literal metadata first hop with zero proxy dispatch', async () => {
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');

    let caught: unknown;
    try {
      await proxyFetch('https://169.254.169.254/latest/meta-data/');
    } catch (error) {
      caught = error;
    }
    const failure = caught as Error;
    expect(failure.name).toBe('UnsafeNetworkTargetError');
    expect(failure.message).toContain('Cloud instance metadata endpoints');
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  });

  it('refuses a first hop whose hostname resolves to metadata', async () => {
    mocks.promisesLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');

    let caught: unknown;
    try {
      await proxyFetch('https://metadata-alias.example.test/v1');
    } catch (error) {
      caught = error;
    }
    const failure = caught as Error;
    expect(failure.name).toBe('UnsafeNetworkTargetError');
    expect(failure.message).toContain('Cloud instance metadata endpoints');
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  });

  it('refuses a first hop to a private address without the operator opt-in', async () => {
    mocks.promisesLookup.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');

    let caught: unknown;
    try {
      await proxyFetch('https://internal.example.test/v1');
    } catch (error) {
      caught = error;
    }
    const failure = caught as Error;
    expect(failure.name).toBe('UnsafeNetworkTargetError');
    expect(failure.message).toContain('Local/private network URLs are not allowed');
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  });

  it('allows an operator-local first hop with the operator opt-in', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    mocks.promisesLookup.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');
    mocks.undiciFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    const response = await proxyFetch('https://internal.example.test/v1');

    expect(response.status).toBe(200);
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  it('reduces a transport failure to fixed caller-safe text', async () => {
    const proxyFetch = createProxyLlmFetch('http://proxy.example.test:3128');
    mocks.undiciFetch.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('proxy socket error MARKER-9'), { code: 'UND_ERR_SOCKET' }),
      }),
    );

    let caught: unknown;
    try {
      await proxyFetch('https://api.example.test/v1/chat/completions');
    } catch (error) {
      caught = error;
    }
    const failure = caught as TypeError;
    expect(failure.message).toBe('fetch failed');
    // UND_ERR_SOCKET is not a timeout code: the fixed 'connection failed'.
    expect((failure.cause as Error).message).toBe('connection failed');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('MARKER-9');
  });
});
