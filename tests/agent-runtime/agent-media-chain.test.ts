/**
 * Agent media chain on the REAL strict transports.
 *
 * Only the external boundaries are stubbed — `undici` (the socket layer) and
 * `node:dns`. The real tools, the real managed transport injection, the real
 * result-URL policy, the real pinned dispatcher (whose captured connect lookup
 * is invoked to prove rebinding refusal) and the real persistence download
 * chain all run. The asset store is the module's own test seam; the video
 * tool's `emitMediaReady` dependency doubles as a synthetic completion hook so
 * the background job is awaited deterministically and the default emitter
 * never touches a real session store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  agentOptions: [] as unknown[],
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => mocks.undiciFetch(...(args as [unknown, unknown])),
    Agent: class {
      constructor(options: unknown) {
        mocks.agentOptions.push(options);
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
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildGenerateImageTool,
  defaultPersistGeneratedImage,
} from '@/lib/server/agent-runtime/generate-image';
import { defaultPersistGeneratedVideo } from '@/lib/server/agent-runtime/generate-video';
import type { MediaReadyLifecycleData } from '@/lib/agent-runtime/lifecycle';
import { createFakeAssetStore } from './_fake-asset-store';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import { answerWith, LOOPBACK_ANSWER, PUBLIC_ANSWER } from '@/tests/helpers/loopback-servers';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 9, 8]);
const MP4_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

/** The captured pinned Agent's connect lookup (newest Agent). */
function capturedLookup(): (...args: unknown[]) => void {
  const options = mocks.agentOptions.at(-1) as
    | { connect?: { lookup?: (...args: unknown[]) => void } }
    | undefined;
  const lookup = options?.connect?.lookup;
  expect(lookup).toBeTypeOf('function');
  return lookup!;
}

function resetBoundaries() {
  mocks.undiciFetch.mockReset();
  mocks.agentOptions.length = 0;
  mocks.promisesLookup.mockReset();
  mocks.callbackLookup.mockReset();
  // The dispatcher pool is per-policy and process-global: reset it so each
  // test captures its own pinned Agents.
  destroyAudioProviderDispatchersForTests();
  mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
  // Connect-time answers would be loopback in a rebinding attack.
  mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
}

describe('agent image chain (real strict transports, socket mocked)', () => {
  beforeEach(resetBoundaries);

  afterEach(() => {
    delete process.env.IMAGE_SEEDREAM_API_KEY;
    delete process.env.IMAGE_SEEDREAM_MODELS;
  });

  it('generates, downloads and stores the image through the managed pinned transport', async () => {
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/i.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://cdn.example.test/i.png') {
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.length) },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    // Operator-configured provider key and pinned model: the production
    // config resolution must accept them (server-side provenance).
    process.env.IMAGE_SEEDREAM_API_KEY = 'sk-seedream';
    process.env.IMAGE_SEEDREAM_MODELS = 'seedream-4-0';

    const pool = createFakeAssetStore();
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ seedream: {} }),
      // Keep the production persistence chain (real download); only the
      // store is the module's own test seam.
      persistGeneratedImage: (input) => defaultPersistGeneratedImage(input, pool.store),
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'A cat',
      aspectRatio: '16:9',
    })) as { isError?: boolean; details?: { src?: string } };

    // The asset id and the stored bytes both came from the real chain.
    expect(result.isError).toBeFalsy();
    expect(result.details?.src).toMatch(/^ast_/);
    expect(pool.puts[0]!.bytes).toEqual(Buffer.from(PNG_BYTES));
    // Submit rode the managed pinned transport with the dispatcher attached.
    const init = mocks.undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
    // The newest Agent is the strict-public result downloader: its captured
    // connect lookup refuses a loopback rebinding answer.
    const lookup = capturedLookup();
    const callback = vi.fn();
    lookup('cdn.example.test', { all: true }, callback);
    expect((callback.mock.calls[0]![0] as Error).message).toContain(
      'Local/private network URLs are not allowed',
    );
  });

  it('refuses an http provider-returned image URL', async () => {
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'http://cdn.example.test/i.png' }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    process.env.IMAGE_SEEDREAM_API_KEY = 'sk-seedream';
    process.env.IMAGE_SEEDREAM_MODELS = 'seedream-4-0';

    const pool = createFakeAssetStore();
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ seedream: {} }),
      persistGeneratedImage: (input) => defaultPersistGeneratedImage(input, pool.store),
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'A cat',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(pool.puts).toHaveLength(0);
    // Only the generation request was issued; the download never ran.
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider-returned URL that resolves to metadata', async () => {
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(
          JSON.stringify({ data: [{ url: 'https://meta.example.test/i.png' }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    mocks.promisesLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    process.env.IMAGE_SEEDREAM_API_KEY = 'sk-seedream';
    process.env.IMAGE_SEEDREAM_MODELS = 'seedream-4-0';

    const pool = createFakeAssetStore();
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ seedream: {} }),
      persistGeneratedImage: (input) => defaultPersistGeneratedImage(input, pool.store),
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'A cat',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(pool.puts).toHaveLength(0);
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
  });
});

describe('agent video chain (real strict transports, socket mocked)', () => {
  beforeEach(resetBoundaries);

  afterEach(() => {
    delete process.env.VIDEO_GROK_API_KEY;
    delete process.env.VIDEO_GROK_MODELS;
  });

  it('downloads the video AND the poster through the strict result policy', async () => {
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://cdn.example.test/v.mp4') {
        return new Response(MP4_BYTES, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(MP4_BYTES.length) },
        });
      }
      if (url === 'https://cdn.example.test/p.jpg') {
        return new Response(JPG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(JPG_BYTES.length) },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const pool = createFakeAssetStore();
    const persisted = await defaultPersistGeneratedVideo(
      {
        result: {
          url: 'https://cdn.example.test/v.mp4',
          poster: 'https://cdn.example.test/p.jpg',
          duration: 6,
          width: 1280,
          height: 720,
        },
        stageId: 'stage-owner',
        signal: new AbortController().signal,
      },
      pool.store,
    );

    expect(persisted.src).toMatch(/^ast_/);
    expect(persisted.poster).toMatch(/^ast_/);
    // Video then poster both downloaded through the pinned transport.
    const urls = mocks.undiciFetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(['https://cdn.example.test/v.mp4', 'https://cdn.example.test/p.jpg']);
    // The video bytes were stored; the poster was stored as its own asset.
    expect(pool.puts[0]!.bytes).toEqual(Buffer.from(MP4_BYTES));
    expect(pool.puts[1]!.bytes).toEqual(Buffer.from(JPG_BYTES));
    // The strict-public result agent is the newest one; its captured connect
    // lookup refuses a loopback rebinding answer.
    const lookup = capturedLookup();
    const callback = vi.fn();
    lookup('cdn.example.test', { all: true }, callback);
    expect((callback.mock.calls[0]![0] as Error).message).toContain(
      'Local/private network URLs are not allowed',
    );
  });

  it('runs the background job to completion on the managed transport, then strict download', async () => {
    // provider-config caches its env read per process; reset the module graph
    // so the grok key/model set below are actually resolved.
    vi.resetModules();
    const { buildGenerateVideoTool: buildTool } =
      await import('@/lib/server/agent-runtime/generate-video');
    const { defaultPersistGeneratedVideo: persistReal } =
      await import('@/lib/server/agent-runtime/generate-video');
    const urlSequence: string[] = [];
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      urlSequence.push(url);
      if (url.includes('/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'r1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (/\/videos\/r1$/.test(url)) {
        return new Response(
          JSON.stringify({
            status: 'done',
            video: { url: 'https://cdn.example.test/v.mp4', duration: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://cdn.example.test/v.mp4') {
        return new Response(MP4_BYTES, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    process.env.VIDEO_GROK_API_KEY = 'sk-grok';
    process.env.VIDEO_GROK_MODELS = 'grok-video-1';

    const pool = createFakeAssetStore();
    // Synthetic completion hook: resolves when the background job reports.
    let settleCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      settleCompletion = resolve;
    });
    const tool = buildTool({
      sessionId: 'session-owner',
      getConfiguredVideoProviders: () => ({ 'grok-video': {} }),
      persistGeneratedVideo: (input) => persistReal(input, pool.store),
      emitMediaReady: (_sessionId: string, data: MediaReadyLifecycleData) => {
        if (data.status === 'done' || data.status === 'failed') settleCompletion?.();
      },
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'A wave rolling in',
      aspectRatio: '16:9',
      durationSec: 5,
      resolution: '720p',
    })) as { isError?: boolean; details?: { ref?: string } };

    expect(result.isError).toBeFalsy();
    expect(result.details?.ref).toMatch(/^gen_vid_/);

    // Wait for the background job to land (completed or failed) before any
    // assertion on bytes, URL sequence or captured dispatchers.
    await completion;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Submit → poll → result download, in order, through the transports.
    expect(urlSequence[0]).toContain('/videos/generations');
    expect(urlSequence[1]).toMatch(/\/videos\/r1$/);
    expect(urlSequence[2]).toBe('https://cdn.example.test/v.mp4');
    // The managed submit rode a pinned dispatcher.
    const submitInit = mocks.undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(submitInit.dispatcher).toBeDefined();
    // The strict-public result download is the newest pinned agent: its
    // captured connect lookup refuses a loopback rebinding answer (the FIRST
    // generation agent is managed/allow-local by legitimate policy, so the
    // refusal is asserted on the strict downloader).
    const lookup = capturedLookup();
    const callback = vi.fn();
    lookup('cdn.example.test', { all: true }, callback);
    expect((callback.mock.calls[0]![0] as Error).message).toContain(
      'Local/private network URLs are not allowed',
    );
    // The synthetic bytes were stored by the real persistence chain.
    expect(pool.puts[0]!.bytes).toEqual(Buffer.from(MP4_BYTES));
  }, 30_000);
});
