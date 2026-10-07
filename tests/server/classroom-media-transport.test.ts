/**
 * Classroom media generation wiring on the REAL pinned transports.
 *
 * Only the external boundaries are stubbed — `undici` (the socket layer) and
 * `node:dns`. Server-configured image and video providers (env keys, as a
 * deployment configures them) are driven through the real
 * `generateMediaForClassroom` flow: the adapters ride the managed pinned
 * transport with the dispatcher attached, the provider-returned media URLs
 * download through the strict public result policy, and the captured strict
 * dispatcher's connect lookup refuses a loopback rebinding answer. File
 * writes are intercepted (the media dir stays untouched); the bytes are
 * synthetic.
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

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  downloadToBuffer,
  generateMediaForClassroom,
} from '@/lib/server/classroom-media-generation';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import { findUnsafeNetworkTargetError } from '@/lib/server/ssrf-guard';
import { answerWith, LOOPBACK_ANSWER, PUBLIC_ANSWER } from '@/tests/helpers/loopback-servers';

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

/** The captured pinned Agent's connect lookup (newest Agent). */
function capturedLookup(): (...args: unknown[]) => void {
  const options = mocks.agentOptions.at(-1) as
    | { connect?: { lookup?: (...args: unknown[]) => void } }
    | undefined;
  const lookup = options?.connect?.lookup;
  expect(lookup).toBeTypeOf('function');
  return lookup!;
}

describe('classroom media generation wiring (real pinned transports)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.undiciFetch.mockReset();
    mocks.agentOptions.length = 0;
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    // Connect-time answers would be loopback in a rebinding attack.
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    destroyAudioProviderDispatchersForTests();
  });

  it('generates an image through the managed pinned transport and downloads the result strictly', async () => {
    vi.stubEnv('IMAGE_SEEDREAM_API_KEY', 'sk-seedream');
    const pngBytes = new Uint8Array([1, 2, 3, 4]);
    const urlSequence: string[] = [];
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      urlSequence.push(url);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/i.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://cdn.example.test/i.png') {
        return new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(pngBytes.length) },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const { generateMediaForClassroom: generate } =
      await import('@/lib/server/classroom-media-generation');
    const outlines = [
      {
        id: 'o1',
        type: 'slide',
        title: 'S',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type: 'image', prompt: 'a cat', elementId: 'gen_img_1' }],
      },
    ] as never;

    const mediaMap = await generate(outlines, 'cls-wired', 'http://localhost');

    expect(mediaMap['gen_img_1']).toBe(
      'http://localhost/api/classroom-media/cls-wired/media/gen_img_1.png',
    );
    // Submit then result download, both through pinned dispatchers.
    expect(urlSequence).toEqual([
      expect.stringContaining('/images/generations'),
      'https://cdn.example.test/i.png',
    ]);
    for (const call of mocks.undiciFetch.mock.calls) {
      expect((call[1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    }
    // The newest Agent is the strict-public result downloader: its captured
    // connect lookup refuses a loopback rebinding answer.
    const lookup = capturedLookup();
    const callback = vi.fn();
    lookup('cdn.example.test', { all: true }, callback);
    expect((callback.mock.calls[0]![0] as Error).message).toContain(
      'Local/private network URLs are not allowed',
    );
  });

  it('generates a video through the managed pinned transport and downloads the result strictly', async () => {
    vi.stubEnv('VIDEO_GROK_API_KEY', 'sk-grok');
    const mp4Bytes = new Uint8Array([9, 8, 7]);
    const urlSequence: string[] = [];
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      urlSequence.push(url);
      if (url.includes('/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'r9' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (/\/videos\/r9$/.test(url)) {
        return new Response(
          JSON.stringify({
            status: 'done',
            video: { url: 'https://cdn.example.test/v.mp4', duration: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://cdn.example.test/v.mp4') {
        return new Response(mp4Bytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(mp4Bytes.length) },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const { generateMediaForClassroom: generate } =
      await import('@/lib/server/classroom-media-generation');
    const outlines = [
      {
        id: 'o1',
        type: 'slide',
        title: 'S',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type: 'video', prompt: 'a wave', elementId: 'gen_vid_1' }],
      },
    ] as never;

    const mediaMap = await generate(outlines, 'cls-wired', 'http://localhost');

    expect(mediaMap['gen_vid_1']).toBe(
      'http://localhost/api/classroom-media/cls-wired/media/gen_vid_1.mp4',
    );
    expect(urlSequence[0]).toContain('/videos/generations');
    expect(urlSequence[1]).toMatch(/\/videos\/r9$/);
    expect(urlSequence[2]).toBe('https://cdn.example.test/v.mp4');
    for (const call of mocks.undiciFetch.mock.calls) {
      expect((call[1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    }
    const lookup = capturedLookup();
    const callback = vi.fn();
    lookup('cdn.example.test', { all: true }, callback);
    expect((callback.mock.calls[0]![0] as Error).message).toContain(
      'Local/private network URLs are not allowed',
    );
  }, 30_000);

  it('refuses an http provider-returned classroom result URL', async () => {
    vi.stubEnv('IMAGE_SEEDREAM_API_KEY', 'sk-seedream');
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'http://cdn.example.test/i.png' }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const { generateMediaForClassroom: generate } =
      await import('@/lib/server/classroom-media-generation');
    const outlines = [
      {
        id: 'o1',
        type: 'slide',
        title: 'S',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type: 'image', prompt: 'a cat', elementId: 'gen_img_1' }],
      },
    ] as never;

    // The failed generation is skipped: no media entry, only the submit leg.
    const mediaMap = await generate(outlines, 'cls-http', 'http://localhost');
    expect(mediaMap).toEqual({});
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
  });

  it('issues no adapter calls when no providers are configured', async () => {
    const media = await generateMediaForClassroom(
      [{ mediaGenerations: [{ type: 'image', prompt: 'p', elementId: 'e1' }] }] as never,
      'classroom-x',
      'http://localhost:3000',
    );
    expect(media).toEqual({});
  });
});

describe('classroom downloadToBuffer policy', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
  });

  afterEach(() => {
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  it('refuses an http result URL', async () => {
    await expect(downloadToBuffer('http://cdn.example.test/v.mp4')).rejects.toThrow(
      /must use http/,
    );
  });

  it('refuses a private result URL even with the operator opt-in', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    mocks.promisesLookup.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);

    const error = await downloadToBuffer('https://internal.example.test/v.mp4').catch(
      (caught: unknown) => caught,
    );
    expect(findUnsafeNetworkTargetError(error)?.message).toContain('not allowed');
  });

  it('refuses a literal metadata result URL under every policy', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const error = await downloadToBuffer('https://169.254.169.254/x').catch(
      (caught: unknown) => caught,
    );
    expect(findUnsafeNetworkTargetError(error)?.message).toContain(
      'Cloud instance metadata endpoints',
    );
  });

  it('decodes a small data: URL locally within the cap', async () => {
    const bytes = await downloadToBuffer('data:text/plain,abc');
    expect(bytes.toString('utf8')).toBe('abc');
  });
});
