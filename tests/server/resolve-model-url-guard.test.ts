import { beforeEach, describe, expect, it, vi } from 'vitest';

// resolveModel throws when a request-supplied base URL is unsafe, in every
// environment. Since D, a body-supplied URL runs under the STRICT PUBLIC
// policy: the operator's ALLOW_LOCAL_NETWORKS opt-in exists for operator
// endpoints and is not inherited by client input. This file keeps the real
// ssrf-guard (no mock) so the private address classification is exercised end
// to end.

const mocks = vi.hoisted(() => ({
  getModelCalls: [] as Array<Record<string, unknown>>,
  serverManaged: false,
  promisesLookup: vi.fn(),
}));

// The real guard resolves hostnames through node:dns; hermetic tests pin the
// URL-layer answers to a public address so only the policy logic runs.
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    getModel: (args: Record<string, unknown>) => {
      mocks.getModelCalls.push(args);
      return { model: { id: args.modelId }, modelInfo: undefined };
    },
  };
});

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => mocks.serverManaged,
  resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
  resolveProxy: () => undefined,
}));

describe('resolveModel — client-supplied base URL guard applies in every environment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
    mocks.getModelCalls.length = 0;
    mocks.serverManaged = false;
    mocks.promisesLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a private-network base URL when NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await expect(
      resolveModel({
        modelString: 'openai:gpt-5.4-mini',
        apiKey: 'client-key',
        baseUrl: 'http://192.168.1.10/v1/',
      }),
    ).rejects.toThrow(/Local\/private network URLs are not allowed/);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('still rejects a private-network base URL when ALLOW_LOCAL_NETWORKS=true (strict public policy for body URLs)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { resolveModel } = await import('@/lib/server/resolve-model');

    await expect(
      resolveModel({
        modelString: 'openai:gpt-5.4-mini',
        apiKey: 'client-key',
        baseUrl: 'http://192.168.1.10/v1/',
      }),
    ).rejects.toThrow(/Local\/private network URLs are not allowed/);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it('keeps a public client base URL working and pins it on the strict caller transport', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { resolveModel } = await import('@/lib/server/resolve-model');

    const result = await resolveModel({
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'https://api.openai.com/v1/',
    });

    expect(result.modelId).toBe('gpt-5.4-mini');
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      baseUrl: 'https://api.openai.com/v1/',
    });
    // A body-supplied URL rides the strict-public pinned transport (the
    // catalog-default variant is covered in resolve-model-pinned-transport).
    const fetchImpl = (mocks.getModelCalls.at(-1) as { fetchImpl?: unknown }).fetchImpl;
    const { clientBaseUrlLlmFetch } = await import('@/lib/server/llm-provider-fetch');
    expect(fetchImpl).toBe(clientBaseUrlLlmFetch);
  });
});
