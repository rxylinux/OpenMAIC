/**
 * Persistence-level regressions for the knowledge_point column: the capture
 * INSERT carries the point, the upsert keeps an existing point when the new
 * event ships none (COALESCE), and the event fingerprint stays
 * byte-identical for payloads frozen before the field existed.
 *
 * The pool is a fake that routes by SQL prefix — these tests pin the SQL
 * contract, not PostgreSQL behavior.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

interface RecordedQuery {
  text: string;
  params: unknown[];
}

function fakePool() {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params: params ?? [] });
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(text)) return { rows: [] };
      // Event receipt creation: pretend the insert won the race.
      if (/INSERT INTO mistake_capture_event/.test(text)) return { rows: [{ event_id: 'e' }] };
      // The mistake upsert: report "new row inserted".
      if (/INSERT INTO mistake_record/.test(text)) return { rows: [{ inserted: true }] };
      return { rows: [] };
    },
    release: vi.fn(),
  };
  return { pool: { connect: async () => client }, queries };
}

const CONTEXT = {
  stageId: 's1',
  stageName: '数学',
  sceneId: 'sc1',
  subject: 'math',
};

describe('captureMistakes knowledge_point', () => {
  it('writes the item knowledge point into the upsert', async () => {
    const { captureMistakes } = await import('@/lib/persistence/mistake-book');
    const { pool, queries } = fakePool();

    await captureMistakes(pool, 'owner-1', CONTEXT, [
      {
        questionId: 'q1',
        questionType: 'single',
        question: '3+2=?',
        knowledgePoint: '10 以内加法',
        userAnswer: 'A',
      },
    ]);

    const insert = queries.find((q) => /INSERT INTO mistake_record/.test(q.text));
    expect(insert).toBeDefined();
    // The column list and the COALESCE retention rule are part of the contract.
    expect(insert!.text).toContain('knowledge_point');
    expect(insert!.text).toContain(
      'COALESCE(EXCLUDED.knowledge_point, mistake_record.knowledge_point)',
    );
    expect(insert!.params).toContain('10 以内加法');
  });

  it('ships NULL for a legacy item instead of erasing the column', async () => {
    const { captureMistakes } = await import('@/lib/persistence/mistake-book');
    const { pool, queries } = fakePool();

    await captureMistakes(pool, 'owner-1', CONTEXT, [
      { questionId: 'q1', questionType: 'single', question: '3+2=?', userAnswer: 'A' },
    ]);

    const insert = queries.find((q) => /INSERT INTO mistake_record/.test(q.text))!;
    // NULL (not undefined, not "") is what COALESCE needs to keep the old value.
    const knowledgeIndex = insert.text
      .replace(/\s+/g, ' ')
      .split('(')[1]!
      .split(',')
      .findIndex((column) => column.trim() === 'knowledge_point');
    expect(insert.params[knowledgeIndex]).toBeNull();
  });
});

describe('canonicalEventContent hash compatibility', () => {
  const context = {
    stageId: 's1',
    stageName: '数学',
    sceneId: 'sc1',
  };
  const baseItem = {
    questionId: 'q1',
    questionType: 'single' as const,
    question: '3+2=?',
    options: [{ label: '5', value: 'B' }],
    correctAnswer: ['B'],
    analysis: '加法',
    userAnswer: 'A',
  };

  it('omits knowledgePoint for legacy items so their fingerprint never changes', async () => {
    const { canonicalEventContent } = await import('@/lib/persistence/mistake-book');
    const legacy = canonicalEventContent(context, [baseItem]) as {
      items: Array<Record<string, unknown>>;
    };
    expect('knowledgePoint' in legacy.items[0]!).toBe(false);
    // Same bytes as before the field shipped: the canonical object for a
    // legacy payload is exactly the historical shape.
    expect(Object.keys(legacy.items[0]!).sort()).toEqual([
      'analysis',
      'correctAnswer',
      'options',
      'question',
      'questionId',
      'questionType',
      'userAnswer',
    ]);
  });

  it('includes knowledgePoint only when the payload carries it', async () => {
    const { canonicalEventContent } = await import('@/lib/persistence/mistake-book');
    const modern = canonicalEventContent(context, [
      { ...baseItem, knowledgePoint: '10 以内加法' },
    ]) as { items: Array<Record<string, unknown>> };
    expect(modern.items[0]!.knowledgePoint).toBe('10 以内加法');
  });
});
