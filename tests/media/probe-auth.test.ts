import { describe, expect, it, vi } from 'vitest';

import { probeAuth } from '@/lib/media/probe-auth';

describe('probeAuth', () => {
  it.each([200, 299])('treats HTTP %i as connected without reading the body', async (status) => {
    const response = new Response('unused', { status });
    const textSpy = vi.spyOn(response, 'text');
    const request = vi.fn().mockResolvedValue(response);

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: true,
      message: 'Connected to Example',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it.each([400, 429, 500])(
    'reports HTTP %i as a fixed connectivity failure without reading the body',
    async (status) => {
      const response = new Response('internal-secret-marker', { status });
      const textSpy = vi.spyOn(response, 'text');
      const request = vi.fn().mockResolvedValue(response);

      await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
        success: false,
        message: `Example connectivity error: HTTP ${status}`,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(textSpy).not.toHaveBeenCalled();
    },
  );

  it('treats a dummy-id 404 as reachable (default reachable status)', async () => {
    const response = new Response('task not found', { status: 404 });
    const textSpy = vi.spyOn(response, 'text');
    const request = vi.fn().mockResolvedValue(response);

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: true,
      message: 'Connected to Example',
    });
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('honours an explicit reachable-statuses list', async () => {
    const request = vi.fn().mockResolvedValue(new Response('bad request body', { status: 400 }));

    await expect(
      probeAuth({ providerName: 'Example', request, reachableStatuses: [400] }),
    ).resolves.toEqual({ success: true, message: 'Connected to Example' });
  });

  it.each([300, 301, 302, 303, 304, 307, 308, 399])(
    'rejects HTTP %i redirects without reading the response body',
    async (status) => {
      const response = new Response(status === 304 ? null : 'unused', { status });
      const textSpy = vi.spyOn(response, 'text');
      const request = vi.fn().mockResolvedValue(response);

      await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
        success: false,
        message: 'Example connectivity error: Redirects are not allowed',
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(textSpy).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])(
    'reports HTTP %i as a fixed auth failure without the body',
    async (status) => {
      const response = new Response('internal-secret-marker', { status });
      const textSpy = vi.spyOn(response, 'text');
      const request = vi.fn().mockResolvedValue(response);

      await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
        success: false,
        message: `Example auth failed (${status})`,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(textSpy).not.toHaveBeenCalled();
    },
  );

  it('converts request errors into fixed connectivity failures', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline: internal-secret-marker'));

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: false,
      message: 'Example connectivity error: request failed',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected-redirect transport error to the redirect contract', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      );

    await expect(probeAuth({ providerName: 'Example', request })).resolves.toEqual({
      success: false,
      message: 'Example connectivity error: Redirects are not allowed',
    });
  });
});
