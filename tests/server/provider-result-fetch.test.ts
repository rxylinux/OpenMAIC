/**
 * `fetchProviderResultUrl` — provider-returned URL policy and data: bounds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeDataUrl, fetchProviderResultUrl } from '@/lib/server/provider-result-fetch';
import { findUnsafeNetworkTargetError } from '@/lib/server/ssrf-guard';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn(),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

const LIMIT = 64;

describe('decodeDataUrl bounds', () => {
  it('decodes a small base64 payload under the limit', () => {
    const { bytes, mimeType } = decodeDataUrl('data:image/png;base64,AAAA', LIMIT);
    expect(bytes.byteLength).toBe(3);
    expect(mimeType).toBe('image/png');
  });

  it('refuses an over-limit base64 payload before decoding it', () => {
    // 128 base64 chars decode to 96 bytes > 64.
    const oversized = 'A'.repeat(128);
    expect(() => decodeDataUrl(`data:image/png;base64,${oversized}`, LIMIT)).toThrow(
      /exceeds the 64-byte limit/,
    );
  });

  it('computes exact UTF-8 boundaries for ASCII, percent, Latin and emoji payloads', () => {
    // Exact-limit ASCII: 64 bytes in, 64 bytes out.
    expect(decodeDataUrl(`data:text/plain,${'a'.repeat(64)}`, LIMIT).bytes.byteLength).toBe(64);
    expect(() => decodeDataUrl(`data:text/plain,${'a'.repeat(65)}`, LIMIT)).toThrow(
      /exceeds the 64-byte limit/,
    );
    // REAL percent-encoded ASCII: %61 is 'a' — 64 triplets decode to exactly
    // 64 bytes (192 chars), 65 triplets over the limit.
    expect(decodeDataUrl(`data:text/plain,${'%61'.repeat(64)}`, LIMIT).bytes.byteLength).toBe(64);
    expect(() => decodeDataUrl(`data:text/plain,${'%61'.repeat(65)}`, LIMIT)).toThrow(
      /exceeds the 64-byte limit/,
    );
    // Mixed raw + percent + multibyte at the exact boundary:
    // 2 raw 'a' + 2 percent 'a' + 28 é (2 bytes) + 1 emoji (4 bytes) = 64.
    expect(
      decodeDataUrl(`data:text/plain,aa%61%61${'é'.repeat(28)}😀`, LIMIT).bytes.byteLength,
    ).toBe(64);
    // Raw Latin-1 supplement: é is exactly 2 UTF-8 bytes — 32 fit, 33 do not.
    expect(decodeDataUrl(`data:text/plain,${'é'.repeat(32)}`, LIMIT).bytes.byteLength).toBe(64);
    expect(() => decodeDataUrl(`data:text/plain,${'é'.repeat(33)}`, LIMIT)).toThrow(
      /exceeds the 64-byte limit/,
    );
    // BMP CJK: 3 bytes each — 21 fit (63), 22 do not.
    expect(decodeDataUrl(`data:text/plain,${'中'.repeat(21)}`, LIMIT).bytes.byteLength).toBe(63);
    expect(() => decodeDataUrl(`data:text/plain,${'中'.repeat(22)}`, LIMIT)).toThrow(
      /exceeds the 64-byte limit/,
    );
    // Emoji (surrogate pair): exactly 4 UTF-8 bytes — 16 fit, 17 do not.
    expect(decodeDataUrl(`data:text/plain,${'😀'.repeat(16)}`, LIMIT).bytes.byteLength).toBe(64);
    expect(() => decodeDataUrl(`data:text/plain,${'😀'.repeat(17)}`, LIMIT)).toThrow(
      /exceeds the 64-byte limit/,
    );
    // A lone surrogate re-encodes as the 3-byte U+FFFD.
    expect(decodeDataUrl('data:text/plain,\ud83d', LIMIT).bytes.byteLength).toBe(3);
  });

  it('refuses an over-limit payload before any decode or buffer allocation', () => {
    // Spies prove the refusal happens during the synchronous pre-decode scan:
    // decodeURIComponent and Buffer.from are never reached for this input.
    const decodeSpy = vi.spyOn(globalThis, 'decodeURIComponent');
    const bufferFromSpy = vi.spyOn(Buffer, 'from');
    try {
      const oversized = '中'.repeat(1024 * 1024);
      expect(() => decodeDataUrl(`data:text/plain,${oversized}`, 64 * 1024)).toThrow(
        /exceeds the 65536-byte limit/,
      );
      // The oversized payload itself never reached the decoder or a buffer.
      expect(decodeSpy.mock.calls.some((call) => String(call[0]).length >= 1024 * 1024)).toBe(
        false,
      );
      const bufferedInputs = bufferFromSpy.mock.calls
        .map((call) => call[0])
        .filter((value): value is string => typeof value === 'string');
      expect(bufferedInputs.some((value) => value.length >= 1024 * 1024)).toBe(false);
    } finally {
      decodeSpy.mockRestore();
      bufferFromSpy.mockRestore();
    }
  });
});

describe('fetchProviderResultUrl network policy', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  it('refuses an http result URL', async () => {
    await expect(fetchProviderResultUrl('http://cdn.example.test/v.mp4')).rejects.toThrow(
      /must use http/,
    );
  });

  it('refuses a private result URL even with the operator opt-in', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    mocks.promisesLookup.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);

    const error = await fetchProviderResultUrl('https://internal.example.test/v.mp4').catch(
      (caught: unknown) => caught,
    );
    expect(findUnsafeNetworkTargetError(error)?.message).toContain('not allowed');
  });

  it('refuses a literal metadata result URL under every policy', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    const error = await fetchProviderResultUrl('https://169.254.169.254/latest/meta-data/').catch(
      (caught: unknown) => caught,
    );
    expect(findUnsafeNetworkTargetError(error)?.message).toContain(
      'Cloud instance metadata endpoints',
    );
  });

  it('bounds a transport failure to fixed text plus an allowlisted code', async () => {
    const { providerFetch } = await import('@/lib/server/provider-fetch');
    const spy = vi
      .spyOn(await import('@/lib/server/audio-provider-fetch'), 'audioProviderFetch')
      .mockRejectedValue(
        new TypeError('fetch failed', {
          cause: new Error('socket hang up https://cdn.example.test/v.mp4?Signature=MARKER-1'),
        }),
      );
    void providerFetch;
    try {
      let caught: unknown;
      try {
        await fetchProviderResultUrl('https://cdn.example.test/v.mp4');
      } catch (error) {
        caught = error;
      }
      const failure = caught as Error;
      expect(failure.message).toBe('Provider result download failed: TypeError');
      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
        'MARKER-1',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps an unknown error code/name out of the bounded message', async () => {
    const spy = vi
      .spyOn(await import('@/lib/server/audio-provider-fetch'), 'audioProviderFetch')
      .mockRejectedValue(
        Object.assign(new Error('x'), {
          code: 'MARKER-IN-CODE-2',
          name: 'MARKER-IN-NAME-2',
        }),
      );
    try {
      await expect(fetchProviderResultUrl('https://cdn.example.test/v.mp4')).rejects.toThrow(
        'Provider result download failed: transport error',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
