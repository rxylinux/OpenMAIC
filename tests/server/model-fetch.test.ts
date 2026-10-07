/**
 * `fetchModels` unit contract on an injected transport.
 *
 * The default transport is the pinned provider fetch (see
 * `model-fetch-http.test.ts` and `tests/api/probe-models.test.ts` for its
 * live-socket coverage); these tests inject `fetchImpl` so the candidate
 * ordering, redirect refusal, fallback, error-status and error-hygiene
 * contracts stay pinned independently of the socket layer.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildModelsUrlCandidates, fetchModels, ModelFetchError } from '@/lib/server/model-fetch';

describe('buildModelsUrlCandidates', () => {
  it('builds v1/models for a plain base url', () => {
    expect(buildModelsUrlCandidates('https://api.example.com')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('uses models directly for a versioned base url', () => {
    expect(buildModelsUrlCandidates('https://api.example.com/v4')).toEqual([
      'https://api.example.com/v4/models',
      'https://api.example.com/v4/v1/models',
    ]);
  });

  it('adds stripped-root candidates for a known anthropic-compat suffix', () => {
    const c = buildModelsUrlCandidates('https://gw.example.com/api/anthropic');
    expect(c).toContain('https://gw.example.com/v1/models');
    expect(c).toContain('https://gw.example.com/models');
  });

  it('throws on empty base url', () => {
    expect(() => buildModelsUrlCandidates('   ')).toThrow();
  });

  it('dedupes candidates preserving order', () => {
    const c = buildModelsUrlCandidates('https://api.example.com');
    expect(new Set(c).size).toBe(c.length);
  });
});

describe('fetchModels', () => {
  it('returns a sorted model list from a successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'z-model', owned_by: 'provider' }, { id: 'a-model' }],
      }),
    } as unknown as Response);

    await expect(
      fetchModels('https://api.example.com', 'test-key', { fetchImpl: fetchMock }),
    ).resolves.toEqual([
      { id: 'a-model', ownedBy: undefined },
      { id: 'z-model', ownedBy: 'provider' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-key' },
        redirect: 'manual',
      }),
    );
  });

  it.each([301, 302, 307, 308])(
    'rejects upstream %i without reading its body or trying another candidate',
    async (status) => {
      const text = vi.fn().mockResolvedValue('redirect response body');
      const json = vi.fn().mockResolvedValue({ data: [{ id: 'should-not-be-read' }] });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status,
        text,
        json,
      } as unknown as Response);

      const error = await fetchModels('https://gateway.example.com/api/anthropic', 'test-key', {
        fetchImpl: fetchMock,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ModelFetchError);
      expect(error).toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    },
  );

  it('maps a redirect refusal from the strict transport to the redirect contract', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      );

    const error = await fetchModels('https://api.example.com', 'test-key', {
      fetchImpl: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelFetchError);
    expect(error).toMatchObject({ status: 302, message: 'Redirects are not allowed' });
  });

  it('does not retry a redirect refusal from the strict transport', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      );

    await fetchModels('https://api.example.com', 'test-key', {
      fetchImpl: fetchMock,
    }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([404, 405])('falls back after %i without reading the error body', async (status) => {
    const firstText = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status, text: firstText } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [{ id: 'fallback-model' }] }),
      } as unknown as Response);

    await expect(
      fetchModels('https://gateway.example.com/api/anthropic', 'test-key', {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([{ id: 'fallback-model', ownedBy: undefined }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstText).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    'keeps upstream %i terminal, preserves its status and never carries the body',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status,
        // A Response whose body is cancelled instead of read: the provider's
        // error text must never reach the caller.
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      } as unknown as Response);

      const error = await fetchModels('https://api.example.com', 'bad-key', {
        fetchImpl: fetchMock,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ModelFetchError);
      expect(error).toMatchObject({ status });
      expect((error as ModelFetchError).message).toBe(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('reports a non-2xx status without the provider body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Response);

    const error = await fetchModels('https://api.example.com', 'key', {
      fetchImpl: fetchMock,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 500, message: 'HTTP 500' });
  });
});
