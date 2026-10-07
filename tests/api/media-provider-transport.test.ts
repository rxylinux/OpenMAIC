/**
 * Image/video provider transports — provenance and trust spoofing, driven
 * through the real `/api/generate/image` and `/api/verify-image-provider`
 * routes.
 *
 * Trust flags (`managed`, `callerSupplied`, `fetchImpl`) are resolved
 * server-side from operator configuration only: a request body that carries
 * same-named booleans cannot influence the transport. Managed endpoints are
 * probed on a real loopback server through the pinned managed transport;
 * caller-supplied endpoints are strict-public (no opt-in in this file), so
 * rebinding targets are refused before any socket reaches a loopback answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST as postGenerateImage } from '@/app/api/generate/image/route';
import { POST as postGenerateVideo } from '@/app/api/generate/video/route';
import { POST as postVerifyImage } from '@/app/api/verify-image-provider/route';
import { POST as postVerifyVideo } from '@/app/api/verify-video-provider/route';
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
  isServerProviderDisabled: vi.fn(),
  resolveImageApiKey: vi.fn(),
  resolveImageBaseUrl: vi.fn(),
  resolveImageModel: vi.fn(),
  resolveServerImageProviderId: vi.fn(),
  resolveVideoApiKey: vi.fn(),
  resolveVideoBaseUrl: vi.fn(),
  resolveVideoModel: vi.fn(),
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  isServerProviderDisabled: mocks.isServerProviderDisabled,
  resolveImageApiKey: mocks.resolveImageApiKey,
  resolveImageBaseUrl: mocks.resolveImageBaseUrl,
  resolveImageModel: mocks.resolveImageModel,
  resolveServerImageProviderId: mocks.resolveServerImageProviderId,
  resolveVideoApiKey: mocks.resolveVideoApiKey,
  resolveVideoBaseUrl: mocks.resolveVideoBaseUrl,
  resolveVideoModel: mocks.resolveVideoModel,
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

function imageRequest(headers: Record<string, string>, body: unknown) {
  const request = new Request('http://localhost/api/generate/image', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return postGenerateImage(request as unknown as NextRequest);
}

/** A minimal OpenAI-compatible image generation answer. */
function openAiImageHandler() {
  return (_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        created: 1,
        data: [{ url: 'https://cdn.example.test/img.png', revised_prompt: 'p' }],
      }),
    );
  };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('media provider transports (real routes)', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.isServerProviderDisabled.mockReturnValue(false);
    mocks.resolveServerImageProviderId.mockReturnValue(undefined);
    mocks.resolveImageApiKey.mockImplementation((_id: string, client?: string) => client || 'key');
    mocks.resolveImageBaseUrl.mockImplementation((_id: string, client?: string) => client);
    mocks.resolveImageModel.mockReturnValue('gpt-image-2');
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

  it('generates through a managed local-network provider without the opt-in', async () => {
    const provider = await startLoopback(openAiImageHandler());
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveImageApiKey.mockReturnValue('server-key');
    mocks.resolveImageBaseUrl.mockReturnValue(provider.origin);

    const res = await imageRequest(
      { 'x-image-provider': 'openai-image', 'x-image-model': 'gpt-image-2' },
      { prompt: 'a cat' },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true });
    expect(provider.requests()).toBe(1);
    // The managed key travelled, and nothing echoed the provider's response
    // beyond the declared fields.
    expect(provider.lastHeaders()?.authorization).toBe('Bearer server-key');
  });

  it('ignores body-supplied trust flags (managed/trusted/allowLocal/fetchImpl)', async () => {
    const provider = await startLoopback(openAiImageHandler());
    // Unmanaged provider with a caller base URL: strict public. The loopback
    // URL in x-base-url is refused at the URL layer even though the body
    // claims trusted/managed/allowLocal flags.
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const res = await imageRequest(
      {
        'x-image-provider': 'openai-image',
        'x-image-model': 'gpt-image-2',
        'x-api-key': 'client-key',
        'x-base-url': provider.origin,
      },
      {
        prompt: 'a cat',
        managed: true,
        trusted: true,
        allowLocal: true,
        allowLocalNetworks: true,
        fetchImpl: 'https://attacker.example.test',
        callerSupplied: false,
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Local/private network URLs are not allowed'),
    });
    expect(provider.requests()).toBe(0);
  });

  it('refuses a rebinding caller base URL before any provider request', async () => {
    const internal = await startLoopback(openAiImageHandler());
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    const res = await imageRequest(
      {
        'x-image-provider': 'openai-image',
        'x-image-model': 'gpt-image-2',
        'x-api-key': 'client-key',
        'x-base-url': 'https://rebinding.example.test/v1',
      },
      { prompt: 'a cat' },
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Image generation failed',
    });
    expect(internal.requests()).toBe(0);
  });

  it('answers a generation failure with fixed text, never the provider body', async () => {
    const provider = await startLoopback((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal-secret-marker' } }));
    });
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveImageApiKey.mockReturnValue('server-key');
    mocks.resolveImageBaseUrl.mockReturnValue(provider.origin);

    const res = await imageRequest(
      { 'x-image-provider': 'openai-image', 'x-image-model': 'gpt-image-2' },
      { prompt: 'a cat' },
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Image generation failed',
    });
    expect(JSON.stringify(json)).not.toContain('internal-secret-marker');
  });

  it('verifies credentials through the pinned managed transport on a local network', async () => {
    const provider = await startLoopback((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key: internal-secret-marker' } }));
    });
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveImageApiKey.mockReturnValue('server-key');
    mocks.resolveImageBaseUrl.mockReturnValue(provider.origin);

    const request = new Request('http://localhost/api/verify-image-provider', {
      method: 'POST',
      headers: { 'x-image-provider': 'openai-image', 'x-image-model': 'gpt-image-2' },
    });
    const res = await postVerifyImage(request as unknown as NextRequest);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({ success: false });
    // The adapter's fixed auth-failure text; no provider body.
    expect(JSON.stringify(json)).not.toContain('internal-secret-marker');
    expect(provider.requests()).toBe(1);
  });

  it('refuses a redirect answered by a managed provider', async () => {
    const internal = await startLoopback(openAiImageHandler());
    const provider = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `${internal.origin}/gen` });
      res.end();
    });
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveImageApiKey.mockReturnValue('server-key');
    mocks.resolveImageBaseUrl.mockReturnValue(provider.origin);

    const res = await imageRequest(
      { 'x-image-provider': 'openai-image', 'x-image-model': 'gpt-image-2' },
      { prompt: 'a cat' },
    );

    expect(res.status).toBe(500);
    expect(provider.requests()).toBe(1);
    expect(internal.requests()).toBe(0);
  });
});

describe('media provider video transports (real routes)', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.isServerProviderDisabled.mockReturnValue(false);
    mocks.resolveServerImageProviderId.mockReturnValue(undefined);
    mocks.resolveVideoApiKey.mockImplementation((_id: string, client?: string) => client || 'key');
    mocks.resolveVideoBaseUrl.mockImplementation((_id: string, client?: string) => client);
    mocks.resolveVideoModel.mockReturnValue('grok-video-test');
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

  /** submit → poll(done) scripted grok-video flow. */
  function grokVideoFlow() {
    let requests = 0;
    return (_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (requests === 1) {
        res.end(JSON.stringify({ request_id: 'r1' }));
      } else {
        res.end(
          JSON.stringify({
            status: 'done',
            video: { url: 'https://cdn.example.test/v.mp4', duration: 6 },
          }),
        );
      }
    };
  }

  it('generates through a managed local-network video provider without the opt-in', async () => {
    const provider = await startLoopback(grokVideoFlow());
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveVideoApiKey.mockReturnValue('server-key');
    mocks.resolveVideoBaseUrl.mockReturnValue(provider.origin);

    const request = new Request('http://localhost/api/generate/video', {
      method: 'POST',
      headers: { 'x-video-provider': 'grok-video' },
      body: JSON.stringify({ prompt: 'a wave' }),
    });
    const res = await postGenerateVideo(request as unknown as NextRequest);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      result: { url: 'https://cdn.example.test/v.mp4' },
    });
    expect(provider.requests()).toBe(2); // submit + poll rode the pinned transport
    expect(provider.lastHeaders()?.authorization).toBe('Bearer server-key');
  }, 30_000);

  it('refuses a caller private base URL even with the operator opt-in set', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const provider = await startLoopback(grokVideoFlow());

    const request = new Request('http://localhost/api/generate/video', {
      method: 'POST',
      headers: {
        'x-video-provider': 'grok-video',
        'x-api-key': 'client-key',
        'x-base-url': provider.origin,
      },
      body: JSON.stringify({ prompt: 'a wave', managed: true, trusted: true, allowLocal: true }),
    });
    const res = await postGenerateVideo(request as unknown as NextRequest);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
      error: expect.stringContaining('Local/private network URLs are not allowed'),
    });
    expect(provider.requests()).toBe(0);
  });

  it('answers a caller rebinding base URL with the fixed failure text', async () => {
    const internal = await startLoopback(grokVideoFlow());
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));

    const request = new Request('http://localhost/api/generate/video', {
      method: 'POST',
      headers: {
        'x-video-provider': 'grok-video',
        'x-api-key': 'client-key',
        'x-base-url': 'https://rebinding.example.test/v1',
      },
      body: JSON.stringify({ prompt: 'a wave' }),
    });
    const res = await postGenerateVideo(request as unknown as NextRequest);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Video generation failed',
    });
    expect(internal.requests()).toBe(0);
  });

  it('verifies a managed video provider on the pinned transport with fixed errors', async () => {
    const provider = await startLoopback((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal-secret-marker' } }));
    });
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveVideoApiKey.mockReturnValue('server-key');
    mocks.resolveVideoBaseUrl.mockReturnValue(provider.origin);

    const request = new Request('http://localhost/api/verify-video-provider', {
      method: 'POST',
      headers: { 'x-video-provider': 'grok-video' },
    });
    const res = await postVerifyVideo(request as unknown as NextRequest);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({ success: false });
    expect(JSON.stringify(json)).not.toContain('internal-secret-marker');
    expect(provider.requests()).toBe(1);
  });
});
