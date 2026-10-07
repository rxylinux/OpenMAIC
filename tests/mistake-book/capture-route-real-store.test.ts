/**
 * REAL route → REAL store → SQL integration (PGlite): the production POST
 * handler over the production store — replay idempotence, mastery guard,
 * payload-conflict refusal, and the expected-owner defense, all read back
 * from real SQL. No store mocks anywhere in this file.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('REAL route → REAL store → SQL (PGlite): replay, mastery guard, conflict, expected-owner', () => {
  // Real production route handlers over a real PGlite store: schema ensured,
  // provider primed, no store mocks. Synthetic data only.
  const hoisted: { db?: PGlite } = {};

  beforeAll(async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://pglite-route-test';
    hoisted.db = new PGlite();
    const db = hoisted.db as PGlite;
    const queryable = {
      query: (text: string, params?: unknown[]) => db.query(text as never, params),
    } as never;
    const { ensureDocumentSchema } = await import('@openmaic/storage/document/pg');
    const { ensureStageMetaSchema } = await import('@/lib/persistence/stage-meta');
    const { ensureAssetSchema } = await import('@openmaic/storage/asset/pg');
    const { ensureMistakeBookSchema } = await import('@/lib/persistence/mistake-book');
    await ensureDocumentSchema(queryable);
    await ensureStageMetaSchema(queryable);
    await ensureAssetSchema(queryable);
    await ensureMistakeBookSchema(queryable);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const poolLike = {
      query: (text: string, params?: unknown[]) => db.query(text as never, params),
      connect: async () => ({
        query: async (text: string, params?: unknown[]) => db.query(text as never, params),
        release: () => {},
      }),
      end: async () => {},
    };
    await getServerPersistenceProvider('postgres://pglite-route-test', () => poolLike as never);
    return () => {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    };
  });

  it('same event: POST twice → wrongCount 1; mastered → old POST replay keeps mastered; changed payload 409; expected-owner mismatch writes nothing', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const { listMistakes } = await import('@/lib/persistence/mistake-book');
    const db = hoisted.db!;
    const q = () => ({ query: (t: string, p?: unknown[]) => db.query(t as never, p) }) as never;
    const post = (body: unknown, cookie = '11111111-2222-4333-8444-555555555555') =>
      POST(
        new Request('http://localhost/api/mistakes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: `anonymous_id=${cookie}` },
          body: JSON.stringify(body),
        }) as never,
      );

    const body = {
      stageId: 's-real',
      stageName: '真实链路课',
      sceneId: 'sc-real',
      items: [
        { questionId: 'q1', eventId: 'e1', questionType: 'single', question: 'a', userAnswer: 'A' },
      ],
    };

    // First POST commits.
    const first = await post(body);
    expect(first.status).toBe(200);
    // Replay: no-op.
    const replay = await post(body);
    expect(((await replay.json()) as { data: { captured: number } }).data.captured).toBe(0);
    let rows = await listMistakes(q(), 'anon:11111111-2222-4333-8444-555555555555', {
      stageId: 's-real',
    });
    expect(rows[0]!.wrongCount).toBe(1);

    // Master it, then replay the OLD event: mastery must survive.
    const { setMistakeMastered } = await import('@/lib/persistence/mistake-book');
    await setMistakeMastered(
      q(),
      'anon:11111111-2222-4333-8444-555555555555',
      { stageId: 's-real', sceneId: 'sc-real', questionId: 'q1' },
      true,
    );
    await post(body);
    rows = await listMistakes(q(), 'anon:11111111-2222-4333-8444-555555555555', {
      stageId: 's-real',
    });
    expect(rows[0]!.wrongCount).toBe(1);
    expect(rows[0]!.masteredAt).not.toBeNull();

    // Same eventId, different content: 409, record untouched.
    const mutated = await post({
      ...body,
      items: [
        { questionId: 'q1', eventId: 'e1', questionType: 'single', question: 'a', userAnswer: 'Z' },
      ],
    });
    expect(mutated.status).toBe(409);
    rows = await listMistakes(q(), 'anon:11111111-2222-4333-8444-555555555555', {
      stageId: 's-real',
    });
    expect(rows[0]!.lastUserAnswer).toBe('A'); // not polluted (JSONB kept the shipped scalar)

    // Expected-owner mismatch: refused, nothing written for the other owner.
    const before = (
      await listMistakes(q(), 'anon:99999999-8888-4777-8666-555555555555', { filter: 'all' })
    ).length;
    const mismatch = await post(
      { ...body, expectedOwnerId: 'someone-else' },
      '99999999-8888-4777-8666-555555555555',
    );
    expect(mismatch.status).toBe(409);
    const after = (
      await listMistakes(q(), 'anon:99999999-8888-4777-8666-555555555555', { filter: 'all' })
    ).length;
    expect(after).toBe(before);
  });

  it('LEGAL LONG ids (hash-compressed `ev:` form, >200-char tuple) pass the REAL route and replay idempotently', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const { listMistakes } = await import('@/lib/persistence/mistake-book');
    const { encodeEventId } = await import('@/lib/mistake-book/client');
    const db = hoisted.db!;
    const q = () => ({ query: (t: string, p?: unknown[]) => db.query(t as never, p) }) as never;

    // A legal attempt id long enough that the tuple form exceeds the 200-char
    // budget — the client ships the `ev:<sha256-32>` compression.
    const longAttempt = 'att-' + 'x'.repeat(260);
    const longEventId = encodeEventId([longAttempt, 'q-long']);
    expect(longEventId.startsWith('ev:')).toBe(true); // actually the compressed lane
    expect(longEventId.length).toBeLessThanOrEqual(256); // inside the API budget

    const post = (body: unknown) =>
      POST(
        new Request('http://localhost/api/mistakes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            cookie: 'anonymous_id=12121212-3434-4145-8565-787878787878',
          },
          body: JSON.stringify(body),
        }) as never,
      );
    const body = {
      stageId: 's-long',
      stageName: '长ID课',
      sceneId: 'sc-long',
      items: [
        {
          questionId: 'q-long',
          eventId: longEventId,
          questionType: 'single',
          question: '长',
          userAnswer: 'A',
        },
      ],
    };

    const first = await post(body);
    expect(first.status).toBe(200);
    const replay = await post(body);
    expect(((await replay.json()) as { data: { captured: number } }).data.captured).toBe(0);
    const rows = await listMistakes(q(), 'anon:12121212-3434-4145-8565-787878787878', {
      stageId: 's-long',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wrongCount).toBe(1); // exact replay: no double count
  });

  it('nested key-ORDER-only changes (JSONB round-trip) are exact replays; a real value change still 409s', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const { listMistakes, setMistakeMastered } = await import('@/lib/persistence/mistake-book');
    const db = hoisted.db!;
    const q = () => ({ query: (t: string, p?: unknown[]) => db.query(t as never, p) }) as never;
    const OWNER = 'anon:21212121-4343-4545-8666-565656565656';
    const post = (body: unknown) =>
      POST(
        new Request('http://localhost/api/mistakes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            cookie: 'anonymous_id=21212121-4343-4545-8666-565656565656',
          },
          body: JSON.stringify(body),
        }) as never,
      );

    const body = {
      stageId: 's-ko',
      stageName: '键序课',
      sceneId: 'sc-ko',
      items: [
        {
          questionId: 'q-ko',
          eventId: 'e-ko',
          questionType: 'single',
          question: '键序?',
          options: [
            { label: '一', value: 'A' },
            { label: '二', value: 'B' },
          ],
          correctAnswer: ['B'],
          userAnswer: { pick: 'A', why: 'first' },
        },
      ],
    };
    // Original commits.
    expect((await post(body)).status).toBe(200);

    // Same VALUES, nested object keys reordered (the shape a JSONB course
    // recovery can legally produce): an EXACT replay, not a conflict.
    const reordered = {
      ...body,
      items: [
        {
          ...body.items[0]!,
          options: [
            { value: 'A', label: '一' },
            { value: 'B', label: '二' },
          ],
          userAnswer: { why: 'first', pick: 'A' },
        },
      ],
    };
    const replay = await post(reordered);
    expect(((await replay.json()) as { data: { captured: number } }).data.captured).toBe(0);
    let rows = await listMistakes(q(), OWNER, { stageId: 's-ko' });
    expect(rows[0]!.wrongCount).toBe(1); // no double count

    // Mastery survives a key-order replay of the OLD event.
    await setMistakeMastered(
      q(),
      OWNER,
      { stageId: 's-ko', sceneId: 'sc-ko', questionId: 'q-ko' },
      true,
    );
    await post(reordered);
    rows = await listMistakes(q(), OWNER, { stageId: 's-ko' });
    expect(rows[0]!.wrongCount).toBe(1);
    expect(rows[0]!.masteredAt).not.toBeNull();

    // A REAL value change under the same event id is still a 409 — and the
    // record is untouched.
    const mutated = await post({
      ...body,
      items: [
        {
          ...body.items[0]!,
          userAnswer: { pick: 'C', why: 'first' },
        },
      ],
    });
    expect(mutated.status).toBe(409);
    rows = await listMistakes(q(), OWNER, { stageId: 's-ko' });
    expect(rows[0]!.wrongCount).toBe(1);
    expect(rows[0]!.masteredAt).not.toBeNull();
  });

  it('MIXED tagged/legacy batch through the REAL route: per-item idempotence is kept', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const { listMistakes } = await import('@/lib/persistence/mistake-book');
    const db = hoisted.db!;
    const q = () => ({ query: (t: string, p?: unknown[]) => db.query(t as never, p) }) as never;
    const OWNER = 'anon:31313131-4545-4646-8776-565656565656';
    const post = (body: unknown) =>
      POST(
        new Request('http://localhost/api/mistakes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            cookie: 'anonymous_id=31313131-4545-4646-8776-565656565656',
          },
          body: JSON.stringify(body),
        }) as never,
      );

    const body = {
      stageId: 's-mix',
      stageName: '混合课',
      sceneId: 'sc-mix',
      items: [
        {
          questionId: 'q-tag',
          eventId: 'e-mix-tag',
          questionType: 'single',
          question: '带ID题',
          userAnswer: 'A',
        },
        {
          questionId: 'q-legacy',
          questionType: 'single',
          question: '无ID题',
          userAnswer: 'A',
        }, // no eventId: legacy, non-idempotent by contract
      ],
    };

    const first = await post(body);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { captured: number } }).data.captured).toBe(2);
    let rows = await listMistakes(q(), OWNER, { stageId: 's-mix' });
    const byId = new Map(rows.map((row) => [row.questionId, row]));
    expect(byId.get('q-tag')!.wrongCount).toBe(1);
    expect(byId.get('q-legacy')!.wrongCount).toBe(1);

    // Replay the SAME mixed batch: the tagged item no-ops (idempotent), the
    // legacy item re-counts (its contract claims no idempotence).
    const replay = await post(body);
    expect(((await replay.json()) as { data: { captured: number } }).data.captured).toBe(1);
    rows = await listMistakes(q(), OWNER, { stageId: 's-mix' });
    const after = new Map(rows.map((row) => [row.questionId, row]));
    expect(after.get('q-tag')!.wrongCount).toBe(1); // event dedupe held
    expect(after.get('q-legacy')!.wrongCount).toBe(2); // legacy re-counted
  });
});
