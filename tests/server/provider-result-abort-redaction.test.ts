/**
 * Abort/timeout redaction in `fetchProviderResultUrl`, driven through the
 * external undici boundary only.
 *
 * The helper's contract: abort/timeout keep their recognizable standard names
 * (so legitimate cancel/timeout semantics survive for the Agent/classroom
 * consumers), but as NEW fixed-message errors — the original message, `cause`
 * and custom fields can all carry the signed result URL. These tests throw
 * `AbortError`/`TimeoutError` (with synthetic signed markers in message,
 * cause AND a custom field) from the undici boundary and prove no marker
 * reaches the thrown error; the consumer suites prove the names survive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  agentOptions: [] as unknown[],
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.log }));

import { fetchProviderResultUrl } from '@/lib/server/provider-result-fetch';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import { answerWith, LOOPBACK_ANSWER, PUBLIC_ANSWER } from '@/tests/helpers/loopback-servers';

const URL_ = 'https://cdn.example.test/v.mp4';
const MARKER = 'SIGNED-URL-MARKER-ABORT';

/** An AbortError/TimeoutError carrying the marker in every possible field. */
function poisoned(name: 'AbortError' | 'TimeoutError'): Error {
  const error = new DOMException(
    `aborted while fetching ${URL_}?Signature=${MARKER}`,
    name,
  ) as unknown as { cause?: unknown; customField?: unknown };
  error.cause = new Error(`socket state: ${URL_}?Signature=${MARKER}`);
  error.customField = `${URL_}?Signature=${MARKER}`;
  return error as Error;
}

describe('fetchProviderResultUrl abort/timeout redaction (undici boundary only)', () => {
  beforeEach(() => {
    mocks.undiciFetch.mockReset();
    mocks.agentOptions.length = 0;
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    destroyAudioProviderDispatchersForTests();
    for (const fn of Object.values(mocks.log)) fn.mockClear();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
  });

  afterEach(() => {
    destroyAudioProviderDispatchersForTests();
  });

  it.each(['AbortError', 'TimeoutError'] as const)(
    'replaces a poisoned %s with a fixed-message error of the same standard name',
    async (name) => {
      mocks.undiciFetch.mockRejectedValue(poisoned(name));

      let caught: unknown;
      try {
        await fetchProviderResultUrl(URL_);
      } catch (error) {
        caught = error;
      }

      const failure = caught as DOMException;
      expect(failure).toBeInstanceOf(DOMException);
      expect(failure.name).toBe(name);
      expect(failure.message).toBe(
        name === 'AbortError'
          ? 'Provider result download aborted'
          : 'Provider result download timed out',
      );
      // No marker anywhere on the replacement — including cause/custom fields.
      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(MARKER);
      expect((failure as { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it('keeps legitimate caller-abort semantics recognizable downstream', async () => {
    // A genuine caller abort surfaces through the boundary as undici's own
    // standard AbortError; the replacement keeps the standard name so
    // consumers classify cancellation exactly as before.
    mocks.undiciFetch.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    const controller = new AbortController();
    controller.abort();
    await expect(fetchProviderResultUrl(URL_, { signal: controller.signal })).rejects.toMatchObject(
      {
        name: 'AbortError',
        message: 'Provider result download aborted',
      },
    );
  });

  it('keeps timeout semantics recognizable with the fixed message', async () => {
    mocks.undiciFetch.mockRejectedValue(
      Object.assign(new Error('Headers Timeout Error'), { name: 'TimeoutError' }),
    );

    await expect(fetchProviderResultUrl(URL_)).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Provider result download timed out',
    });
  });

  it('leaves no marker in any log line for the poisoned abort branch', async () => {
    mocks.undiciFetch.mockRejectedValue(poisoned('AbortError'));

    await expect(fetchProviderResultUrl(URL_)).rejects.toThrow('aborted');
    const logged = JSON.stringify([
      ...mocks.log.info.mock.calls,
      ...mocks.log.warn.mock.calls,
      ...mocks.log.error.mock.calls,
    ]);
    expect(logged).not.toContain(MARKER);
  });
});

describe('consumer surfaces keep names and never see the marker', () => {
  beforeEach(() => {
    mocks.undiciFetch.mockReset();
    mocks.agentOptions.length = 0;
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    destroyAudioProviderDispatchersForTests();
    for (const fn of Object.values(mocks.log)) fn.mockClear();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
  });

  afterEach(() => {
    destroyAudioProviderDispatchersForTests();
    vi.unstubAllEnvs();
    delete process.env.IMAGE_SEEDREAM_API_KEY;
    delete process.env.IMAGE_SEEDREAM_MODELS;
  });

  it('the Agent image tool reports the abort name with no marker in result or logs', async () => {
    mocks.undiciFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: URL_ }] }), { status: 200 });
      }
      if (url === URL_) throw poisoned('AbortError');
      throw new Error(`unexpected ${url}`);
    });
    process.env.IMAGE_SEEDREAM_API_KEY = 'sk-seedream';
    process.env.IMAGE_SEEDREAM_MODELS = 'seedream-4-0';

    const { buildGenerateImageTool, defaultPersistGeneratedImage } =
      await import('@/lib/server/agent-runtime/generate-image');
    const { createFakeAssetStore } = await import('../agent-runtime/_fake-asset-store');
    const pool = createFakeAssetStore();
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ seedream: {} }),
      persistGeneratedImage: (input) => defaultPersistGeneratedImage(input, pool.store),
    });

    const result = (await tool.execute('call-1', {
      stageId: 'stage-owner',
      prompt: 'A cat',
    })) as { isError?: boolean; content?: { text?: string }[] };

    expect(result.isError).toBe(true);
    const serialized =
      JSON.stringify(result) +
      JSON.stringify([
        ...mocks.log.info.mock.calls,
        ...mocks.log.warn.mock.calls,
        ...mocks.log.error.mock.calls,
      ]);
    expect(serialized).not.toContain(MARKER);
    expect(serialized).not.toContain('Signature=');
    expect(pool.puts).toHaveLength(0);
  });

  it('the classroom download surfaces the fixed abort message with no marker', async () => {
    mocks.undiciFetch.mockRejectedValue(poisoned('TimeoutError'));

    const { downloadToBuffer } = await import('@/lib/server/classroom-media-generation');
    let caught: unknown;
    try {
      await downloadToBuffer(URL_);
    } catch (error) {
      caught = error;
    }
    const failure = caught as DOMException;
    expect(failure.name).toBe('TimeoutError');
    expect(failure.message).toBe('Provider result download timed out');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(MARKER);
    const logged = JSON.stringify([
      ...mocks.log.info.mock.calls,
      ...mocks.log.warn.mock.calls,
      ...mocks.log.error.mock.calls,
    ]);
    expect(logged).not.toContain(MARKER);
  });
});
