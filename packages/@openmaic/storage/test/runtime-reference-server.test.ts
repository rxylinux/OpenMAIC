import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test, vi } from 'vitest';
import type { AssetId } from '../src/asset/id.js';
import type { AssetStore } from '../src/asset/types.js';
import { BrowserRuntimeStore } from '../src/runtime/browser.js';
import { HttpRuntimeStore } from '../src/runtime/http.js';
import type { RuntimePayloadValidator, RuntimeStore } from '../src/runtime/types.js';
import { createRuntimeHttpHandler } from '../src/server/index.js';
import { RuntimeHttpError } from '../src/server/http-error.js';
import {
  createReferenceRuntimeServer,
  type ConnectableQueryable,
} from '../src/server/reference.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

const BASE_URL = 'http://runtime-reference.invalid';

function handlerFetch(
  handler: RequestListener,
  authorizationFor: (request: Request) => Promise<string | undefined>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = await authorizationFor(request);
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    if (authorization !== undefined) headers.authorization = authorization;

    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== '') yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;

    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      let responseHeaders: Record<string, string> = {};
      let responseBody: string | undefined;
      let headersSent = false;
      const fakeResponse = {
        get headersSent() {
          return headersSent;
        },
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus;
          responseHeaders = nextHeaders ?? {};
          headersSent = true;
          return this;
        },
        end(chunk?: string | Buffer) {
          responseBody = chunk === undefined ? undefined : chunk.toString();
          resolve(
            new Response(status === 204 ? null : responseBody, {
              status,
              headers: responseHeaders,
            }),
          );
          return this;
        },
        destroy(error?: Error) {
          reject(error ?? new Error('response destroyed'));
          return this;
        },
      } as unknown as ServerResponse;

      try {
        handler(fakeRequest, fakeResponse);
      } catch (error) {
        reject(error);
      }
    });
  };
}

function bearerLearner(req: IncomingMessage): { learnerKey: string } | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return undefined;
  const learnerKey = authorization.slice('Bearer '.length);
  return learnerKey === '' ? undefined : { learnerKey };
}

async function contractCredential(request: Request, store: RuntimeStore): Promise<string> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'POST' && path === '/runtime/sessions') {
    const body = (await request.clone().json()) as { learnerKey: string };
    return `Bearer ${body.learnerKey || 'invalid-envelope'}`;
  }
  const listedLearner = path.match(/^\/runtime\/stages\/[^/]+\/learners\/([^/]+)/)?.[1];
  if (listedLearner !== undefined) return `Bearer ${decodeURIComponent(listedLearner)}`;
  const sessionId = path.match(/^\/runtime\/sessions\/([^/]+)/)?.[1];
  if (sessionId !== undefined) {
    const session = await store.getSession(decodeURIComponent(sessionId));
    if (session !== undefined) return `Bearer ${session.learnerKey}`;
  }
  return 'Bearer contract-operator';
}

runRuntimeStoreContract('reference HTTP handler', () => {
  const backingStore = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
  const handler = createRuntimeHttpHandler(backingStore, {
    authenticate: async (req) => bearerLearner(req),
    authorizeMerge: async () => true,
    // The shared contract includes deleteAllRuntime, so this explicitly grants
    // its test-only operator principal access to the admin route.
    authorizeAdmin: async () => true,
  });
  return new HttpRuntimeStore({
    baseUrl: BASE_URL,
    fetch: handlerFetch(handler, (request) => contractCredential(request, backingStore)),
  });
});

describe('reference HTTP handler records-route existence concealment', () => {
  function makeHarness() {
    const backingStore = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(backingStore, {
      authenticate: async (req) => bearerLearner(req),
    });
    const fetchAs = (authorization: string) => handlerFetch(handler, async () => authorization);
    return { backingStore, fetchAs };
  }

  test('absent and foreign sessions answer the records route identically', async () => {
    const { backingStore, fetchAs } = makeHarness();
    await backingStore.createSession(
      makeSession({ id: 'victim-session', learnerKey: 'learner-victim' }),
    );

    const absent = await fetchAs('Bearer learner-probe')(
      `${BASE_URL}/runtime/sessions/no-such-session/records`,
    );
    const foreign = await fetchAs('Bearer learner-probe')(
      `${BASE_URL}/runtime/sessions/victim-session/records`,
    );

    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(((await absent.json()) as { error: { code: string } }).error.code).toBe(
      ((await foreign.json()) as { error: { code: string } }).error.code,
    );
  });

  test('the client restores empty-list semantics for the concealed 404', async () => {
    const { fetchAs } = makeHarness();
    const client = new HttpRuntimeStore({
      baseUrl: BASE_URL,
      fetch: fetchAs('Bearer learner-probe'),
    });

    await expect(client.listRecords('no-such-session')).resolves.toEqual([]);
  });
});

describe('reference HTTP handler DELETE /runtime authorization', () => {
  function makeHarness() {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async (req) => bearerLearner(req),
      authorizeAdmin: async (principal) => principal.learnerKey === 'admin',
    });
    const request = (authorization?: string) =>
      handlerFetch(handler, async () => authorization)(`${BASE_URL}/runtime`, {
        method: 'DELETE',
      });
    return { request, store };
  }

  test('denies a learner credential with 403', async () => {
    const { request } = makeHarness();
    const response = await request('Bearer learner-1');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_ADMIN' },
    });
  });

  test('denies a missing credential with 401', async () => {
    const { request } = makeHarness();
    const response = await request();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  test('allows an admin credential and empties the runtime store', async () => {
    const { request, store } = makeHarness();
    await store.createSession(makeSession({ id: 'stage-1-session' }));
    await store.appendRecord(makeRecordInit('stage-1-session'));
    await store.createSession(makeSession({ id: 'stage-2-session', stageId: 'stage-2' }));

    const response = await request('Bearer admin');

    expect(response.status).toBe(204);
    expect(await store.getSession('stage-1-session')).toBeUndefined();
    expect(await store.getSession('stage-2-session')).toBeUndefined();
    expect(await store.listRecords('stage-1-session')).toEqual([]);
  });
});

describe('reference HTTP handler principal capabilities', () => {
  test('allows admin-only and merge-only principals without a fabricated learnerKey', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({}),
      authorizeAdmin: async () => true,
      authorizeMerge: async () => true,
    });
    const request = handlerFetch(handler, async () => 'Bearer capability-only');

    const adminResponse = await request(`${BASE_URL}/runtime`, { method: 'DELETE' });
    expect(adminResponse.status).toBe(204);

    const mergeResponse = await request(`${BASE_URL}/runtime/learners/merge`, {
      method: 'POST',
      body: JSON.stringify({ fromLearnerKey: 'learner-a', toLearnerKey: 'learner-b' }),
    });
    expect(mergeResponse.status).toBe(200);
  });

  test('reference factory stays unbound and applies authorization overrides', async () => {
    const statements: string[] = [];
    const query = async (text: string) => {
      statements.push(text);
      return { rows: [] };
    };
    const pool = {
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as unknown as ConnectableQueryable;
    const server = await createReferenceRuntimeServer(pool, {
      authenticate: async () => ({}),
      authorizeAdmin: async () => true,
      authorizeMerge: async () => true,
      payloadValidators: {},
      maxBodyBytes: 64,
    });
    const handler = server.listeners('request')[0] as RequestListener;

    expect(server.listening).toBe(false);
    const response = await handlerFetch(handler, async () => 'Bearer capability-only')(
      `${BASE_URL}/runtime`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(204);
    expect(statements).toContain('DELETE FROM runtime_sessions');

    const oversized = await handlerFetch(handler, async () => 'Bearer capability-only')(
      `${BASE_URL}/runtime/learners/merge`,
      {
        method: 'POST',
        body: JSON.stringify({ padding: 'x'.repeat(100) }),
      },
    );
    expect(oversized.status).toBe(413);
  });

  test('guarded status route: 204 when latest, 409 LINEAGE_ADVANCED when a relevant newer sibling exists, 501 when unsupported', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const fetchAuth = handlerFetch(handler, async () => undefined);
    const session = await store.createSession(
      makeSession({ id: 'guarded-root', learnerKey: 'learner-a', kind: 'quizAttempt' }),
    );
    void session;
    await store.appendRecord(
      makeRecordInit('guarded-root', {
        sceneId: 'scene-1',
        payload: { payloadVersion: 1, phase: 'draft', answers: {} },
      }),
    );

    // Uncontended guarded write commits (204) and the store row changed.
    const ok = await fetchAuth(`${BASE_URL}/runtime/sessions/guarded-root/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'active',
        updatedAt: '2026-10-03T00:00:00.000Z',
        latestOnly: true,
        relevantSceneId: 'scene-1',
        expectedLastSeq: 0,
      }),
    });
    expect(ok.status).toBe(204);
    expect((await store.getSession('guarded-root'))?.status).toBe('active');
    await store.setSessionStatus('guarded-root', 'completed', '2026-10-03T00:00:01.000Z', {
      expectedLastSeq: 0,
    });

    // A genuinely newer RELEVANT sibling refuses the guarded write.
    await store.createSession(
      makeSession({
        id: 'guarded-newer',
        learnerKey: 'learner-a',
        kind: 'quizAttempt',
        createdAt: '2026-10-03T01:00:00.000Z',
        updatedAt: '2026-10-03T01:00:00.000Z',
      }),
    );
    await store.appendRecord(
      makeRecordInit('guarded-newer', {
        sceneId: 'scene-1',
        payload: { payloadVersion: 1, phase: 'draft', answers: {} },
      }),
    );
    const refused = await fetchAuth(`${BASE_URL}/runtime/sessions/guarded-root/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'active',
        updatedAt: '2026-10-03T02:00:00.000Z',
        latestOnly: true,
        relevantSceneId: 'scene-1',
      }),
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: 'LINEAGE_ADVANCED' },
    });
    expect((await store.getSession('guarded-root'))?.status).toBe('completed');

    // An UNANCHORED (generic) request is also refused by the newer sibling…
    const refusedGeneric = await fetchAuth(`${BASE_URL}/runtime/sessions/guarded-root/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'active',
        updatedAt: '2026-10-03T02:00:01.000Z',
        latestOnly: true,
      }),
    });
    expect(refusedGeneric.status).toBe(409);
    // …but the same newer sibling does NOT block a guard anchored to a
    // scene it has no records for (relevance mirrors the canonical reader).
    const otherScene = await fetchAuth(`${BASE_URL}/runtime/sessions/guarded-root/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'active',
        updatedAt: '2026-10-03T02:00:02.000Z',
        latestOnly: true,
        relevantSceneId: 'scene-OTHER',
      }),
    });
    expect(otherScene.status).toBe(204);

    // A store WITHOUT the atomic capability honestly refuses (501) instead
    // of silently downgrading to an unguarded write.
    const stubStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'setSessionStatusIfLatest') return undefined; // unsupported
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const stubHandler = createRuntimeHttpHandler(stubStore, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const stubResponse = await handlerFetch(stubHandler, async () => undefined)(
      `${BASE_URL}/runtime/sessions/guarded-root/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'completed',
          updatedAt: '2026-10-03T03:00:00.000Z',
          latestOnly: true,
        }),
      },
    );
    expect(stubResponse.status).toBe(501);
    await expect(stubResponse.json()).resolves.toMatchObject({
      error: { code: 'LINEAGE_GUARD_UNSUPPORTED' },
    });
  });

  test('returns 403 FORBIDDEN_LEARNER on learner routes without learnerKey', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, { authenticate: async () => ({}) });
    const response = await handlerFetch(
      handler,
      async () => 'Bearer admin-only',
    )(`${BASE_URL}/runtime/stages/stage-1/learners/learner-a/sessions`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_LEARNER' },
    });
  });
});

describe('reference server asset byte egress', () => {
  const bytes = Buffer.from([1, 2, 3, 4]);

  function signingAssetStore(): AssetStore {
    return {
      put: async () => 'ast_stub' as AssetId,
      identify: async () => ({ mime: 'image/png', revision: 3, byteLength: bytes.byteLength }),
      resolve: async () => ({ bytes, mime: 'image/png', revision: 3 }),
      resolveIndirect: async () => ({ url: 'https://objects.example/signed', revision: 3 }),
      remove: async () => undefined,
      replace: async () => 4,
    };
  }

  function queryable(): ConnectableQueryable {
    const query = async () => ({ rows: [] });
    return {
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as unknown as ConnectableQueryable;
  }

  async function requestAsset(byteEgress?: {
    mode: 'redirect';
    collectionGraceMs: number;
  }): Promise<Response> {
    const server = await createReferenceRuntimeServer(queryable(), {
      assetStore: signingAssetStore(),
      ...(byteEgress === undefined ? {} : { byteEgress }),
    });
    const handler = server.listeners('request')[0] as RequestListener;
    return handlerFetch(handler, async () => 'Bearer learner-a')(
      `${BASE_URL}/assets/ast_example/content`,
      {
        headers: { authorization: 'Bearer learner-a' },
        redirect: 'manual',
      },
    );
  }

  test('forwards redirect egress through the composed reference server', async () => {
    const response = await requestAsset({
      mode: 'redirect',
      collectionGraceMs: 60 * 60 * 1000,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://objects.example/signed');
  });

  test('keeps direct byte egress when the reference server option is omitted', async () => {
    const response = await requestAsset();

    expect(response.status).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(bytes));
  });
});

describe('reference HTTP handler validation boundary', () => {
  test('rejects an oversized request body with 413 and accepts an under-limit body', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'anon:device-1' }),
      maxBodyBytes: 256,
    });
    const request = handlerFetch(handler, async () => 'Bearer anon:device-1');

    const oversized = await request(`${BASE_URL}/runtime/sessions`, {
      method: 'POST',
      body: JSON.stringify({ padding: 'x'.repeat(300) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });

    const accepted = await request(`${BASE_URL}/runtime/sessions`, {
      method: 'POST',
      body: JSON.stringify(makeSession({ id: 'under-limit' })),
    });
    expect(accepted.status).toBe(201);
  });

  test.each([
    ['session id with NUL', makeSession({ id: 'bad\u0000session' })],
    ['session stageId with a lone surrogate', makeSession({ stageId: 'bad\ud800stage' })],
  ])('rejects a non-JSON-domain %s before calling the store', async (_label, init) => {
    let createCalled = false;
    const store = {
      getSession: async () => undefined,
      createSession: async () => {
        createCalled = true;
        throw new Error('must not be called');
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'anon:device-1' }),
    });
    const response = await handlerFetch(handler, async () => 'Bearer anon:device-1')(
      `${BASE_URL}/runtime/sessions`,
      { method: 'POST', body: JSON.stringify(init) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(createCalled).toBe(false);
  });

  test.each([
    ['record id with NUL', { id: 'bad\u0000record' }],
    ['record sceneId with a lone surrogate', { sceneId: 'bad\ud800scene' }],
  ])('rejects a non-JSON-domain %s before calling the store', async (_label, overrides) => {
    const session = { ...makeSession(), runtimeDslVersion: RUNTIME_DSL_VERSION };
    let appendCalled = false;
    const store = {
      getSession: async () => session,
      appendRecord: async () => {
        appendCalled = true;
        throw new Error('must not be called');
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: session.learnerKey }),
    });
    const response = await handlerFetch(handler, async () => `Bearer ${session.learnerKey}`)(
      `${BASE_URL}/runtime/sessions/${session.id}/records`,
      {
        method: 'POST',
        body: JSON.stringify(makeRecordInit(session.id, overrides)),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(appendCalled).toBe(false);
  });

  test('uses the same whole-table payload validator replacement as the injected store', async () => {
    const payloadValidators: Record<string, RuntimePayloadValidator> = {
      chat: (payload) =>
        typeof payload === 'object' && payload !== null && 'custom' in payload
          ? { valid: true }
          : { valid: false, errors: [{ path: '/payload', message: 'expected custom payload' }] },
    };
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators,
    });
    await store.createSession(makeSession());
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'anon:device-1' }),
      payloadValidators,
    });
    const response = await handlerFetch(handler, async () => 'Bearer anon:device-1')(
      `${BASE_URL}/runtime/sessions/sess-1/records`,
      {
        method: 'POST',
        body: JSON.stringify(makeRecordInit('sess-1', { payload: { custom: true } })),
      },
    );

    expect(response.status).toBe(201);
  });
});

describe('reference HTTP handler error disclosure', () => {
  test('returns a generic INTERNAL_ERROR and logs the underlying store error server-side', async () => {
    const secret = 'postgres password=do-not-reflect';
    const underlying = new Error(secret);
    const store = {
      getSession: async () => {
        throw underlying;
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await handlerFetch(
        handler,
        async () => 'Bearer learner-a',
      )(`${BASE_URL}/runtime/sessions/session-a`);
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: '@openmaic/storage: internal server error',
        },
      });
      expect(consoleError).toHaveBeenCalledWith(
        '@openmaic/storage: Runtime HTTP handler internal error',
        underlying,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('reference HTTP handler future-version semantics', () => {
  const futureSession = {
    ...makeSession({ id: 'future-session', learnerKey: 'learner-a', stageId: 'stage-1' }),
    runtimeDslVersion: '999.0.0',
  };

  test('passes future-stamped session and record reads through unchanged', async () => {
    const record = { ...makeRecordInit(futureSession.id), seq: 0 };
    const store = {
      getSession: async () => futureSession,
      listRecords: async () => [record],
      listSessions: async () => [futureSession],
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
    });
    const request = handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`);

    const sessionResponse = await request(`${BASE_URL}/runtime/sessions/${futureSession.id}`);
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toEqual(futureSession);

    const recordsResponse = await request(
      `${BASE_URL}/runtime/sessions/${futureSession.id}/records`,
    );
    expect(recordsResponse.status).toBe(200);
    await expect(recordsResponse.json()).resolves.toEqual([record]);

    const sessionsResponse = await request(
      `${BASE_URL}/runtime/stages/${futureSession.stageId}/learners/${futureSession.learnerKey}/sessions`,
    );
    expect(sessionsResponse.status).toBe(200);
    await expect(sessionsResponse.json()).resolves.toEqual([futureSession]);
  });

  test.each([
    ['session', `/runtime/sessions/${futureSession.id}`, 'deleteSession'],
    [
      'learner partition',
      `/runtime/stages/${futureSession.stageId}/learners/${futureSession.learnerKey}`,
      'deleteLearnerRuntime',
    ],
    ['stage', `/runtime/stages/${futureSession.stageId}`, 'deleteStageRuntime'],
    ['all runtime', '/runtime', 'deleteAllRuntime'],
  ] as const)('keeps the %s delete version-independent', async (_label, path, methodName) => {
    const calls: string[] = [];
    const store = {
      getSession: async () => futureSession,
      deleteSession: async () => calls.push('deleteSession'),
      deleteLearnerRuntime: async () => calls.push('deleteLearnerRuntime'),
      deleteStageRuntime: async () => calls.push('deleteStageRuntime'),
      deleteAllRuntime: async () => calls.push('deleteAllRuntime'),
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
      authorizeAdmin: async () => true,
    });
    const response = await handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`)(
      `${BASE_URL}${path}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(204);
    expect(calls).toEqual([methodName]);
  });

  test.each([
    {
      operation: 'appendRecord',
      invoke: (request: typeof globalThis.fetch) =>
        request(`${BASE_URL}/runtime/sessions/${futureSession.id}/records`, {
          method: 'POST',
          body: JSON.stringify(makeRecordInit(futureSession.id)),
        }),
    },
    {
      operation: 'setSessionStatus',
      invoke: (request: typeof globalThis.fetch) =>
        request(`${BASE_URL}/runtime/sessions/${futureSession.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed', updatedAt: '2026-01-01T00:02:00.000Z' }),
        }),
    },
  ])('$operation keeps the 409 FUTURE_VERSION write guard', async ({ operation, invoke }) => {
    const called: string[] = [];
    const store = {
      getSession: async () => futureSession,
      appendRecord: async () => called.push('appendRecord'),
      setSessionStatus: async () => {
        called.push('setSessionStatus');
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
    });
    const response = await invoke(
      handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FUTURE_VERSION' },
    });
    expect(called).not.toContain(operation);
  });

  test('mergeLearner returns 409 only after a structured future-session re-fetch', async () => {
    const storeError = new Error(
      `@openmaic/storage: session ${JSON.stringify(futureSession.id)} was written at runtime DSL ` +
        `version ${JSON.stringify(futureSession.runtimeDslVersion)}, newer than this client's ` +
        RUNTIME_DSL_VERSION,
    );
    const store = {
      getSession: async () => futureSession,
      mergeLearner: async () => {
        throw storeError;
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
      authorizeMerge: async () => true,
    });
    const response = await handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`)(
      `${BASE_URL}/runtime/learners/merge`,
      {
        method: 'POST',
        body: JSON.stringify({
          fromLearnerKey: futureSession.learnerKey,
          toLearnerKey: 'learner-b',
        }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FUTURE_VERSION' },
    });
  });
});

describe('reference HTTP handler concurrent session-write classification', () => {
  const operations = [
    {
      name: 'appendRecord',
      invoke: (request: typeof globalThis.fetch, sessionId: string) =>
        request(`${BASE_URL}/runtime/sessions/${sessionId}/records`, {
          method: 'POST',
          body: JSON.stringify(makeRecordInit(sessionId)),
        }),
    },
    {
      name: 'setSessionStatus',
      invoke: (request: typeof globalThis.fetch, sessionId: string) =>
        request(`${BASE_URL}/runtime/sessions/${sessionId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed', updatedAt: '2026-01-01T00:02:00.000Z' }),
        }),
    },
  ];

  test.each(operations)(
    '$name returns 404 when the session is deleted before the write',
    async ({ name, invoke }) => {
      const session = {
        ...makeSession({ id: `race-${name}` }),
        runtimeDslVersion: RUNTIME_DSL_VERSION,
      };
      const underlying = new Error('session does not exist');
      let reads = 0;
      const store = {
        getSession: async () => (++reads === 1 ? session : undefined),
        appendRecord: async () => {
          throw underlying;
        },
        setSessionStatus: async () => {
          throw underlying;
        },
      } as unknown as RuntimeStore;
      const handler = createRuntimeHttpHandler(store, {
        authenticate: async () => ({ learnerKey: session.learnerKey }),
      });
      const response = await invoke(
        handlerFetch(handler, async () => `Bearer ${session.learnerKey}`),
        session.id,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'SESSION_NOT_FOUND' },
      });
      expect(reads).toBe(2);
    },
  );

  test.each(operations)(
    '$name returns 400 with the current status when the session completes before the write',
    async ({ name, invoke }) => {
      const session = {
        ...makeSession({ id: `race-${name}` }),
        runtimeDslVersion: RUNTIME_DSL_VERSION,
      };
      const completed = { ...session, status: 'completed' as const };
      const underlying = new Error('session not active');
      let reads = 0;
      const store = {
        getSession: async () => (++reads === 1 ? session : completed),
        appendRecord: async () => {
          throw underlying;
        },
        setSessionStatus: async () => {
          throw underlying;
        },
      } as unknown as RuntimeStore;
      const handler = createRuntimeHttpHandler(store, {
        authenticate: async () => ({ learnerKey: session.learnerKey }),
      });
      const response = await invoke(
        handlerFetch(handler, async () => `Bearer ${session.learnerKey}`),
        session.id,
      );
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.message).toContain("current status is 'completed'");
      expect(reads).toBe(2);
    },
  );

  test.each(operations)(
    '$name preserves 500 for an unclassified store failure',
    async ({ name, invoke }) => {
      const session = {
        ...makeSession({ id: `race-${name}` }),
        runtimeDslVersion: RUNTIME_DSL_VERSION,
      };
      const underlying = new Error('unexpected write failure');
      let reads = 0;
      const store = {
        getSession: async () => {
          reads += 1;
          return session;
        },
        appendRecord: async () => {
          throw underlying;
        },
        setSessionStatus: async () => {
          throw underlying;
        },
      } as unknown as RuntimeStore;
      const handler = createRuntimeHttpHandler(store, {
        authenticate: async () => ({ learnerKey: session.learnerKey }),
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const response = await invoke(
          handlerFetch(handler, async () => `Bearer ${session.learnerKey}`),
          session.id,
        );

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: 'INTERNAL_ERROR' },
        });
        expect(reads).toBe(2);
        expect(consoleError).toHaveBeenCalledWith(
          '@openmaic/storage: Runtime HTTP handler internal error',
          underlying,
        );
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});

describe('reference HTTP handler cross-learner rejection matrix', () => {
  function makeCrossLearnerHarness() {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
      authorizeMerge: async (principal, fromKey) => principal.learnerKey === fromKey,
    });
    const request = handlerFetch(handler, async () => 'Bearer learner-a');
    return { store, request };
  }

  const cases: {
    route: string;
    expectedStatus: 403 | 404;
    expectedCode: 'FORBIDDEN_LEARNER' | 'SESSION_NOT_FOUND';
    invoke(request: typeof globalThis.fetch): Promise<Response>;
  }[] = [
    {
      route: 'get session',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) => request(`${BASE_URL}/runtime/sessions/session-b`),
    },
    {
      route: 'list records',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) => request(`${BASE_URL}/runtime/sessions/session-b/records`),
    },
    {
      route: 'append record',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/sessions/session-b/records`, {
          method: 'POST',
          body: JSON.stringify(makeRecordInit('session-b')),
        }),
    },
    {
      route: 'set session status',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/sessions/session-b/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed', updatedAt: '2026-01-01T00:02:00.000Z' }),
        }),
    },
    {
      route: 'delete session',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/sessions/session-b`, {
          method: 'DELETE',
        }),
    },
    {
      route: 'list stage learner sessions',
      expectedStatus: 403,
      expectedCode: 'FORBIDDEN_LEARNER',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/stages/stage-1/learners/learner-b/sessions`),
    },
    {
      route: 'delete stage learner runtime',
      expectedStatus: 403,
      expectedCode: 'FORBIDDEN_LEARNER',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/stages/stage-1/learners/learner-b`, {
          method: 'DELETE',
        }),
    },
    {
      route: 'merge learner',
      expectedStatus: 403,
      expectedCode: 'FORBIDDEN_LEARNER',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/learners/merge`, {
          method: 'POST',
          body: JSON.stringify({ fromLearnerKey: 'learner-b', toLearnerKey: 'learner-a' }),
        }),
    },
  ];

  test.each(cases)('$route returns $expectedStatus $expectedCode', async (testCase) => {
    const { store, request } = makeCrossLearnerHarness();
    await store.createSession(
      makeSession({ id: 'session-b', learnerKey: 'learner-b', stageId: 'stage-1' }),
    );
    await store.appendRecord(makeRecordInit('session-b'));

    const response = await testCase.invoke(request);

    expect(response.status).toBe(testCase.expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: testCase.expectedCode },
    });
  });
});

describe('reference HTTP handler ownership ordering', () => {
  test('returns concealed 404 before classifying another learner future-version session', async () => {
    const futureSession = {
      ...makeSession({ id: 'future-b', learnerKey: 'learner-b' }),
      runtimeDslVersion: '999.0.0',
    };
    const store = { getSession: async () => futureSession } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const response = await handlerFetch(
      handler,
      async () => 'Bearer learner-a',
    )(`${BASE_URL}/runtime/sessions/future-b`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  test('re-checks ownership immediately before delete and rejects a concurrent merge', async () => {
    const owned = { ...makeSession({ id: 'moving' }), runtimeDslVersion: RUNTIME_DSL_VERSION };
    const moved = { ...owned, learnerKey: 'learner-b' };
    let reads = 0;
    let deleted = false;
    const store = {
      getSession: async () => (++reads === 1 ? owned : moved),
      deleteSession: async () => {
        deleted = true;
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: owned.learnerKey }),
    });
    const response = await handlerFetch(handler, async () => `Bearer ${owned.learnerKey}`)(
      `${BASE_URL}/runtime/sessions/moving`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(404);
    expect(reads).toBe(2);
    expect(deleted).toBe(false);
  });
});

// --- final review: ≥500 redaction is preserved; only the deliberate
// unsupported-guard sentinel keeps its fixed public fields at ≥500 ----------

describe('reference HTTP handler internal-error redaction boundary', () => {
  test('a sensitive ≥500 RuntimeHttpError from a STORE callback is redacted to generic INTERNAL_ERROR', async () => {
    const secret = 'postgres password=do-not-reflect';
    const dsn = 'postgres://user:supersecret@db.internal:5432/prod';
    const underlying = new RuntimeHttpError(500, 'DB_INTERNAL', secret, { dsn });
    const store = {
      getSession: async () => {
        throw underlying;
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await handlerFetch(
        handler,
        async () => 'Bearer learner-a',
      )(`${BASE_URL}/runtime/sessions/session-a`);
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(dsn);
      expect(text).not.toContain('DB_INTERNAL');
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: '@openmaic/storage: internal server error',
        },
      });
      // The server-side operator log keeps the underlying failure.
      expect(consoleError).toHaveBeenCalledWith(
        '@openmaic/storage: Runtime HTTP handler internal error',
        underlying,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test('a sensitive ≥500 RuntimeHttpError from the AUTH callback is redacted too', async () => {
    const secret = 'oidc client secret=do-not-reflect';
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => {
        throw new RuntimeHttpError(500, 'AUTH_INTERNAL', secret, { audience: 'do-not-reflect' });
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await handlerFetch(
        handler,
        async () => 'Bearer learner-a',
      )(`${BASE_URL}/runtime/sessions/session-a`);
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(text).not.toContain('do-not-reflect');
      expect(JSON.parse(text)).toEqual({
        error: { code: 'INTERNAL_ERROR', message: '@openmaic/storage: internal server error' },
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  test('the deliberate unsupported-guard 501 still reaches the client with its FIXED fields', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    await store.createSession(makeSession({ id: 'guarded-501', learnerKey: 'learner-a' }));
    const stubStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'setSessionStatusIfLatest') return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const handler = createRuntimeHttpHandler(stubStore, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const response = await handlerFetch(handler, async () => undefined)(
      `${BASE_URL}/runtime/sessions/guarded-501/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'active',
          updatedAt: '2026-10-03T00:00:00.000Z',
          latestOnly: true,
          relevantSceneId: 'scene-1',
        }),
      },
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'LINEAGE_GUARD_UNSUPPORTED',
        message: '@openmaic/storage: this runtime store does not support the atomic lineage guard',
      },
    });
  });
});

// --- final review: anchored relevance through the route mirrors the reader --

describe('reference HTTP handler guarded-status anchored reader-equivalence', () => {
  test('a malformed latest tail does not block (204); a valid latest record does (409)', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const fetchAuth = handlerFetch(handler, async () => undefined);
    const quizSession = (id: string, createdAt: string) =>
      makeSession({
        id,
        learnerKey: 'learner-a',
        kind: 'quizAttempt',
        createdAt,
        updatedAt: createdAt,
      });
    await store.createSession(quizSession('anchored-root', '2026-10-03T00:00:00.000Z'));
    await store.appendRecord(
      makeRecordInit('anchored-root', {
        sceneId: 'scene-1',
        payload: { payloadVersion: 1, phase: 'draft', answers: {} },
      }),
    );
    await store.createSession(quizSession('anchored-newer', '2026-10-03T01:00:00.000Z'));
    // seq 0: a valid scene-1 draft; seq 1: a malformed scene-1 TAIL (no
    // payloadVersion — stored by the skeleton gate, never reader-adopted).
    await store.appendRecord(
      makeRecordInit('anchored-newer', {
        sceneId: 'scene-1',
        payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'A' } },
      }),
    );
    await store.appendRecord(
      makeRecordInit('anchored-newer', {
        sceneId: 'scene-1',
        payload: { phase: 'draft', answers: { q1: 'A' } },
      }),
    );

    const patch = (body: unknown) =>
      fetchAuth(`${BASE_URL}/runtime/sessions/anchored-root/status`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

    // The reader skips the malformed-tail sibling: the guarded write commits.
    const tailMalformed = await patch({
      status: 'active',
      updatedAt: '2026-10-03T02:00:00.000Z',
      latestOnly: true,
      relevantSceneId: 'scene-1',
    });
    expect(tailMalformed.status).toBe(204);

    // A VALID latest scene record now exists: the same write is refused with
    // 409 LINEAGE_ADVANCED and nothing is written.
    await store.appendRecord(
      makeRecordInit('anchored-newer', {
        sceneId: 'scene-1',
        payload: { payloadVersion: 1, phase: 'submitted', answers: { q1: 'A' } },
      }),
    );
    await store.setSessionStatus('anchored-root', 'completed', '2026-10-03T02:00:01.000Z');
    const refused = await patch({
      status: 'active',
      updatedAt: '2026-10-03T03:00:00.000Z',
      latestOnly: true,
      relevantSceneId: 'scene-1',
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: 'LINEAGE_ADVANCED' },
    });
    expect((await store.getSession('anchored-root'))?.status).toBe('completed');
  });
});
