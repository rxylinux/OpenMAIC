/**
 * Loopback HTTP servers and split DNS answers for strict-transport tests.
 *
 * Tests drive real routes/adapters and the real pinned transport; the only
 * stubs are `node:dns` (so the URL-layer guard and the connect-time lookup can
 * answer differently — DNS rebinding) and the global `fetch` (a spy that must
 * never be called, proving the pinned undici transport is the one in use).
 *
 * Re-exported pieces:
 *  - `startLoopback`/`closeLoopbackServers` — real 127.0.0.1 HTTP servers;
 *  - `PUBLIC_ANSWER`/`LOOPBACK_ANSWER`/`answerWith` — DNS answer fixtures.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Answer = { address: string; family: number };

export const PUBLIC_ANSWER: Answer[] = [{ address: '93.184.216.34', family: 4 }];
export const LOOPBACK_ANSWER: Answer[] = [{ address: '127.0.0.1', family: 4 }];

/** A callback-style `dns.lookup` stand-in that always returns `addresses`. */
export function answerWith(addresses: Answer[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ): void => {
    if (options?.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  };
}

export interface LoopbackServer {
  port: number;
  origin: string;
  requests: () => number;
  lastUrl: () => string | undefined;
  lastHeaders: () => IncomingMessage['headers'] | undefined;
  lastBody: () => Buffer | undefined;
}

const servers: Server[] = [];

export async function startLoopback(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  let count = 0;
  let url: string | undefined;
  let headers: IncomingMessage['headers'] | undefined;
  let body: Buffer | undefined;
  const server = createServer((req, res) => {
    count += 1;
    url = req.url;
    headers = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length > 0) body = Buffer.concat(chunks);
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"detail":"Not Found"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests: () => count,
    lastUrl: () => url,
    lastHeaders: () => headers,
    lastBody: () => body,
  };
}

export async function closeLoopbackServers(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
