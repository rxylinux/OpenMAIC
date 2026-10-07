/**
 * `fetchAliDocMindImageAsBase64` — provider-returned OSS URL policy on the
 * REAL strict transport.
 *
 * Only the socket boundary (`undici`) and `node:dns` are stubbed: the pinned
 * dispatcher, its address policy, redirect refusal and the streaming byte
 * caps all run for real. What this proves for the OSS branch: public-HTTPS
 * allowlist, the strict public pinned policy, redirect refusal, DNS-rebinding
 * refusal, the 10 MiB streaming cap with cancellation, a successful
 * legitimate download, and signed queries staying out of every log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  agentOptions: [] as unknown[],
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

// sharp decodes the downloaded bytes on success.
vi.mock('sharp', () => ({
  default: (buf: Buffer) => ({
    png: () => ({ toBuffer: async () => Buffer.concat([Buffer.from('png:'), buf]) }),
  }),
}));

import { fetchAliDocMindImageAsBase64 } from '@/lib/pdf/pdf-providers';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import { answerWith, LOOPBACK_ANSWER, PUBLIC_ANSWER } from '@/tests/helpers/loopback-servers';

const SIGNED = 'https://bkt.oss-cn-hangzhou.aliyuncs.com/img.png?Signature=SIGNED-MARKER-OSS';

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('fetchAliDocMindImageAsBase64 (real strict transport, socket mocked)', () => {
  beforeEach(() => {
    mocks.undiciFetch.mockReset();
    mocks.agentOptions.length = 0;
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    for (const fn of Object.values(mocks.log)) fn.mockClear();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(PUBLIC_ANSWER));
  });

  afterEach(() => {
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
  });

  it('downloads a legitimate image through the pinned strict transport', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mocks.undiciFetch.mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
      }),
    );

    const result = await fetchAliDocMindImageAsBase64(SIGNED);

    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(result!.split(',')[1]!, 'base64').subarray(0, 4)).toEqual(
      Buffer.from('png:'),
    );
    // The request rode undici's fetch with the pinned dispatcher installed.
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
    const init = mocks.undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown; redirect?: string };
    expect(init.dispatcher).toBeDefined();
    expect(init.redirect).toBe('error');
    expect(mocks.agentOptions.length).toBeGreaterThan(0);
  });

  it('refuses a non-OSS host and an http OSS URL without any socket', async () => {
    await expect(
      fetchAliDocMindImageAsBase64('https://169.254.169.254/latest/meta-data'),
    ).resolves.toBeNull();
    await expect(
      fetchAliDocMindImageAsBase64('http://bkt.oss-cn-hangzhou.aliyuncs.com/img.png'),
    ).resolves.toBeNull();
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
  });

  it('installs a connect-time lookup that refuses a loopback rebinding answer', async () => {
    // The URL-layer answer stays public; the connect-time resolver answers
    // loopback, as in a rebinding attack.
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    mocks.undiciFetch.mockResolvedValue(new Response(new Uint8Array(0), { status: 404 }));

    await fetchAliDocMindImageAsBase64(SIGNED);

    // The pinned Agent's connect lookup is installed; feeding it the DNS
    // answer set a rebinding attack would produce (loopback) is refused
    // before any socket could use it.
    const options = mocks.agentOptions.at(-1) as
      | { connect?: { lookup?: (...args: unknown[]) => void } }
      | undefined;
    const lookup = options?.connect?.lookup;
    expect(lookup).toBeTypeOf('function');
    const callback = vi.fn();
    lookup!('bkt.oss-cn-hangzhou.aliyuncs.com', { all: true }, callback);
    expect(callback).toHaveBeenCalled();
    const error = callback.mock.calls[0]![0] as Error;
    expect(error.message).toContain('Local/private network URLs are not allowed');
  });

  it('refuses a redirect answer instead of following it', async () => {
    mocks.undiciFetch.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    );

    await expect(fetchAliDocMindImageAsBase64(SIGNED)).resolves.toBeNull();
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
    // The signed query never entered the log, and the sanitized path did.
    const logged = JSON.stringify(mocks.log.warn.mock.calls);
    expect(logged).not.toContain('SIGNED-MARKER-OSS');
    expect(logged).toContain('bkt.oss-cn-hangzhou.aliyuncs.com/img.png');
  });

  it('aborts an oversized stream with no Content-Length and cancels the body', async () => {
    let cancelled = false;
    // 12 × 1 MiB chunks = 12 MiB > 10 MiB cap, streamed with no content-length.
    const oneMiB = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 12; i++) controller.enqueue(oneMiB);
      },
      cancel() {
        cancelled = true;
      },
    });
    mocks.undiciFetch.mockResolvedValue(new Response(stream, { status: 200, headers: {} }));

    await expect(fetchAliDocMindImageAsBase64(SIGNED)).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it('rejects a declared oversized Content-Length up front', async () => {
    mocks.undiciFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-length': String(20 * 1024 * 1024) },
      }),
    );

    await expect(fetchAliDocMindImageAsBase64(SIGNED)).resolves.toBeNull();
  });

  it('keeps a signed URL out of the log when the transport fails with it embedded', async () => {
    mocks.undiciFetch.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new Error(`socket hang up ${SIGNED}`),
      }),
    );

    await expect(fetchAliDocMindImageAsBase64(SIGNED)).resolves.toBeNull();
    const logged = JSON.stringify(mocks.log.warn.mock.calls);
    expect(logged).not.toContain('SIGNED-MARKER-OSS');
    expect(logged).toContain('bkt.oss-cn-hangzhou.aliyuncs.com/img.png');
  });
});
