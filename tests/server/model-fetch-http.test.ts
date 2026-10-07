import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { fetchModels } from '@/lib/server/model-fetch';
import { createProviderFetch } from '@/lib/server/provider-fetch';

it('aborts a real stalled response body before succeeding on one retry', async () => {
  // The DEFAULT transport is strict-public (discovery URLs are caller input),
  // so this self-hosted-shape run rides an operator-policy pinned transport —
  // the same transport, address policy as a configured deployment.
  const operatorPinned = createProviderFetch({
    allowLocalNetworks: undefined,
    rejectRedirects: true,
  });
  process.env.ALLOW_LOCAL_NETWORKS = 'true';
  try {
    let requests = 0;
    let closedFirstResponse = false;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (requests === 1) {
        res.on('close', () => {
          closedFirstResponse = true;
        });
        res.write('{"data":['); // Headers and partial JSON arrive, but the body never ends.
      } else {
        res.end('{"data":[{"id":"recovered"}]}');
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address() as AddressInfo;
      const started = Date.now();
      const models = await fetchModels(`http://127.0.0.1:${address.port}`, '', {
        fetchImpl: operatorPinned,
      });
      expect(models).toEqual([{ id: 'recovered', ownedBy: undefined }]);
      expect(requests).toBe(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(14_900);
      await expect.poll(() => closedFirstResponse).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    delete process.env.ALLOW_LOCAL_NETWORKS;
  }
}, 25_000);
