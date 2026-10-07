/**
 * R9 formal tests: owner-scoped event dedupe, payload-conflict rejection,
 * batch atomicity, and the mixed-review integration boundary — against a
 * REAL PostgreSQL via PGlite (real SQL semantics: ON CONFLICT, transactions,
 * rollback), all synthetic data.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { Queryable } from '@openmaic/storage/document/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  captureMistakes,
  ensureMistakeBookSchema,
  listMistakes,
  setMistakeMastered,
  type MistakeCaptureContext,
  type MistakeCaptureItem,
} from '@/lib/persistence/mistake-book';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
    const result = await this.db.query<TRow>(text, params);
    return { rows: (result.rows ?? []) as TRow[] };
  }

  async connect() {
    return {
      query: async <TRow extends Record<string, unknown>>(text: string, params?: unknown[]) => {
        const result = await this.db.query<TRow>(text, params);
        return { rows: (result.rows ?? []) as TRow[] };
      },
      release: () => {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const OWNER = 'owner-events';
const OTHER = 'owner-other';

const CONTEXT: MistakeCaptureContext = {
  stageId: 's-evt',
  stageName: '合成课',
  sceneId: 'sc-evt',
  subject: 'math',
  gradeSemester: 'grade-1-up',
};

const item = (questionId: string, answer = 'A'): MistakeCaptureItem => ({
  questionId,
  questionType: 'single',
  question: `${questionId}?`,
  correctAnswer: ['B'],
  userAnswer: answer,
  eventId: `evt-${CONTEXT.stageId}-${CONTEXT.sceneId}-${questionId}-attempt1`,
});

describe('R9 capture event idempotence (real SQL)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  const queryable = (): Queryable => ({
    query: (text, params) => pool.query(text as never, params) as never,
  });

  beforeAll(async () => {
    db = new PGlite();
    pool = new PGlitePool(db);
    await ensureDocumentSchema(queryable());
    await ensureStageMetaSchema(queryable());
    await ensureAssetSchema(queryable());
    await ensureMistakeBookSchema(queryable());
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE mistake_record, mistake_classification, mistake_capture_event CASCADE' as never,
    );
  });

  const rows = async (ownerId = OWNER) =>
    (await listMistakes(queryable(), ownerId, { stageId: CONTEXT.stageId, filter: 'all' })).map(
      (record) => ({ id: record.questionId, wrongCount: record.wrongCount }),
    );

  it('a replayed event is a no-op: no extra count, no mastery reset', async () => {
    const first = await captureMistakes(pool, OWNER, CONTEXT, [item('q1')], {
      eventIds: ['evt-attempt1-q1'],
    });
    expect(first).toMatchObject({ created: ['q1'], counted: [], duplicates: [] });

    // Master the question, then replay the SAME event.
    await setMistakeMastered(
      queryable(),
      OWNER,
      {
        stageId: CONTEXT.stageId,
        sceneId: CONTEXT.sceneId,
        questionId: 'q1',
      },
      true,
    );

    const replay = await captureMistakes(pool, OWNER, CONTEXT, [item('q1')], {
      eventIds: ['evt-attempt1-q1'],
    });
    expect(replay).toMatchObject({ created: [], counted: [], duplicates: ['q1'] });
    expect(await rows()).toEqual([{ id: 'q1', wrongCount: 1 }]); // count unchanged
    const mastered = (await listMistakes(queryable(), OWNER, { stageId: CONTEXT.stageId }))[0]!;
    expect(mastered.masteredAt).not.toBeNull(); // mastery NOT reset by replay
  });

  it('the same eventId with DIFFERENT content is rejected, records untouched', async () => {
    await captureMistakes(pool, OWNER, CONTEXT, [item('q2')], { eventIds: ['evt-x'] });
    await expect(
      captureMistakes(pool, OWNER, CONTEXT, [item('q2', 'C')], { eventIds: ['evt-x'] }),
    ).rejects.toThrow('EVENT_PAYLOAD_CONFLICT');
    expect(await rows()).toEqual([{ id: 'q2', wrongCount: 1 }]);
  });

  it('a genuinely NEW event increments and clears mastery', async () => {
    await captureMistakes(pool, OWNER, CONTEXT, [item('q3')], { eventIds: ['evt-q3-a1'] });
    await setMistakeMastered(
      queryable(),
      OWNER,
      {
        stageId: CONTEXT.stageId,
        sceneId: CONTEXT.sceneId,
        questionId: 'q3',
      },
      true,
    );
    const again = await captureMistakes(pool, OWNER, CONTEXT, [item('q3')], {
      eventIds: ['evt-q3-a2'],
    });
    expect(again).toMatchObject({ created: [], counted: ['q3'], duplicates: [] });
    const record = (await listMistakes(queryable(), OWNER, { stageId: CONTEXT.stageId }))[0]!;
    expect(record.wrongCount).toBe(2);
    expect(record.masteredAt).toBeNull();
  });

  it('two owners with the same eventId are independent', async () => {
    await captureMistakes(pool, OWNER, CONTEXT, [item('q4')], { eventIds: ['evt-shared'] });
    const other = await captureMistakes(pool, OTHER, CONTEXT, [item('q4')], {
      eventIds: ['evt-shared'],
    });
    expect(other).toMatchObject({ created: ['q4'] }); // first time for OTHER
    expect(await rows(OWNER)).toEqual([{ id: 'q4', wrongCount: 1 }]);
    expect(await rows(OTHER)).toEqual([{ id: 'q4', wrongCount: 1 }]);
  });

  it('duplicate question id INSIDE one batch is rejected whole (no partial commit)', async () => {
    // Same question twice under two DIFFERENT event ids is equally malformed:
    // one answer cannot count twice in one submission.
    await expect(
      captureMistakes(pool, OWNER, CONTEXT, [item('q5'), item('q5', 'C')], {
        eventIds: ['evt-q5-a', 'evt-q5-b'],
      }),
    ).rejects.toThrow('DUPLICATE_QUESTION_IN_BATCH');
    expect(await rows()).toEqual([]); // nothing committed
  });

  it('a fault on the second item rolls back the first (batch atomicity)', async () => {
    // Force the second item's insert to fail by dropping a column mid-flight
    // is intrusive; instead inject through a poisoned context: an item whose
    // options cannot be JSON-encoded throws inside the same transaction.
    const poisoned: MistakeCaptureItem = {
      ...item('q8'),
      options: { bad: BigInt(1) } as unknown as Record<string, unknown>, // JSON.stringify throws
    };
    await expect(
      captureMistakes(pool, OWNER, CONTEXT, [item('q7'), poisoned], {
        eventIds: ['evt-q7', 'evt-q8'],
      }),
    ).rejects.toThrow();
    expect(await rows()).toEqual([]); // q7 NOT partially committed
    // And the event rows were rolled back too — retrying q7 alone works.
    const retry = await captureMistakes(pool, OWNER, CONTEXT, [item('q7')], {
      eventIds: ['evt-q7'],
    });
    expect(retry).toMatchObject({ created: ['q7'] });
  });

  it('legacy payloads (no eventId) are never treated as idempotent', async () => {
    const legacy = (questionId: string): MistakeCaptureItem => {
      const { eventId: _drop, ...rest } = item(questionId);
      return rest;
    };
    await captureMistakes(pool, OWNER, CONTEXT, [legacy('q9')]);
    await captureMistakes(pool, OWNER, CONTEXT, [legacy('q9')]);
    expect(await rows()).toEqual([{ id: 'q9', wrongCount: 2 }]); // honest double count, no dedupe claim
  });

  it('mixed review: choice captured now, short answer captured on recovery — no double count', async () => {
    // First review: choice confirmed wrong (captured), short answer ungraded.
    await captureMistakes(pool, OWNER, CONTEXT, [item('q-choice')], {
      eventIds: ['evt-mixed-q-choice'],
    });
    // Recovery review: choice NOT re-captured (same event id, replay), the
    // newly-decided short answer captures under ITS own event id.
    const recovery = await captureMistakes(
      pool,
      OWNER,
      CONTEXT,
      [item('q-choice'), { ...item('q-short'), questionType: 'short_answer' }],
      { eventIds: ['evt-mixed-q-choice', 'evt-mixed-q-short'] },
    );
    expect(recovery).toMatchObject({
      created: ['q-short'], // new fact
      counted: [],
      duplicates: ['q-choice'], // replay of the first review's event
    });
    const finalRows = await rows();
    expect(finalRows).toHaveLength(2);
    expect(finalRows).toContainEqual({ id: 'q-choice', wrongCount: 1 }); // NOT re-counted
    expect(finalRows).toContainEqual({ id: 'q-short', wrongCount: 1 });
  });
});
