/**
 * Real route → store event-contract tests (C early review): the production
 * route genuinely passes the item/top-level event contract into the store
 * call (store mocked at the LAST boundary only), replays surface as
 * duplicates, and the expected-owner guard refuses mismatches before any
 * write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('route → store event-contract pass-through (store mocked at the LAST boundary only — parameter wiring, NOT a store-behavior proof)', () => {
  const mocks = vi.hoisted(() => ({
    captureMistakes: vi.fn(),
    listMistakes: vi.fn(),
    setMistakeMastered: vi.fn(),
    deleteMistake: vi.fn(),
    deleteStageMistakes: vi.fn(),
    deleteAllMistakes: vi.fn(),
    applyStageClassification: vi.fn(),
    mistakeRecordView: vi.fn((record: { questionId: string }) => ({ ...record })),
  }));

  vi.mock('@/lib/persistence/mistake-book', () => ({
    MISTAKE_QUESTION_TYPES: ['single', 'multiple', 'short_answer'],
    captureMistakes: mocks.captureMistakes,
    applyStageClassification: mocks.applyStageClassification,
    listMistakes: mocks.listMistakes,
    setMistakeMastered: mocks.setMistakeMastered,
    deleteMistake: mocks.deleteMistake,
    deleteStageMistakes: mocks.deleteStageMistakes,
    deleteAllMistakes: mocks.deleteAllMistakes,
    mistakeRecordView: mocks.mistakeRecordView,
  }));

  vi.mock('@/lib/persistence/server-provider', () => ({
    getServerPersistenceProvider: vi.fn(async () => ({ pool: {} })),
  }));

  vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }));

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgres://test-configured';
    mocks.captureMistakes
      .mockReset()
      .mockResolvedValue({ created: [], counted: [], duplicates: [] });
  });

  it('item-level eventIds reach the store verbatim; top-level applies to one item; mixed batch stays per-item', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const post = (body: unknown) =>
      POST(
        new Request('http://localhost/api/mistakes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }) as never,
      );

    // Per-item ids pass through as the eventIds array.
    await post({
      stageId: 's',
      stageName: 'x',
      sceneId: 'sc',
      items: [
        { questionId: 'q1', eventId: 'e1', questionType: 'single', question: 'a', userAnswer: 'A' },
        { questionId: 'q2', eventId: 'e2', questionType: 'single', question: 'b', userAnswer: 'B' },
      ],
    });
    expect(mocks.captureMistakes).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      { eventIds: ['e1', 'e2'] },
    );

    // Legacy top-level id applies ONLY to a single-item payload.
    await post({
      stageId: 's',
      stageName: 'x',
      sceneId: 'sc',
      eventId: 'top-1',
      items: [{ questionId: 'q3', questionType: 'single', question: 'c', userAnswer: 'A' }],
    });
    expect(mocks.captureMistakes).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      { eventIds: ['top-1'] },
    );

    // No ids anywhere: honest undefined per item (legacy, no idempotence).
    await post({
      stageId: 's',
      stageName: 'x',
      sceneId: 'sc',
      items: [
        { questionId: 'q4', questionType: 'single', question: 'd', userAnswer: 'A' },
        { questionId: 'q5', questionType: 'single', question: 'e', userAnswer: 'A' },
      ],
    });
    expect(mocks.captureMistakes).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      { eventIds: [undefined, undefined] },
    );
  });

  it('a replayed event routes to a no-op receipt (route response surfaces duplicates)', async () => {
    mocks.captureMistakes.mockResolvedValueOnce({ created: [], counted: [], duplicates: ['q1'] });
    const { POST } = await import('@/app/api/mistakes/route');
    const response = await POST(
      new Request('http://localhost/api/mistakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageId: 's',
          stageName: 'x',
          sceneId: 'sc',
          items: [
            {
              questionId: 'q1',
              eventId: 'e1',
              questionType: 'single',
              question: 'a',
              userAnswer: 'A',
            },
          ],
        }),
      }) as never,
    );
    const json = (await response.json()) as { data: { captured: number; duplicates: string[] } };
    expect(response.status).toBe(200);
    expect(json.data.captured).toBe(0); // replay counted nothing
    expect(json.data.duplicates).toEqual(['q1']);
  });

  it('mixed tagged/legacy batch: per-item event ids — a legacy sibling never downgrades tagged items', async () => {
    const tagged = (questionId: string) => ({
      questionId,
      eventId: `evt-tagged-${questionId}`,
      questionType: 'single',
      question: 'tagged',
      userAnswer: 'A',
    });
    const legacy = (questionId: string) => ({
      questionId,
      questionType: 'single',
      question: 'legacy',
      userAnswer: 'A',
    });
    const { POST } = await import('@/app/api/mistakes/route');
    await POST(
      new Request('http://localhost/api/mistakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageId: 's',
          stageName: 'x',
          sceneId: 'sc',
          items: [tagged('q1'), legacy('q2'), tagged('q3')],
        }),
      }) as never,
    );
    expect(mocks.captureMistakes).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      { eventIds: ['evt-tagged-q1', undefined, 'evt-tagged-q3'] },
    );
  });

  it('single legacy item falls back to the top-level eventId', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    await POST(
      new Request('http://localhost/api/mistakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageId: 's',
          stageName: 'x',
          sceneId: 'sc',
          eventId: 'top-level-legacy',
          items: [
            { questionId: 'q1', questionType: 'single', question: 'legacy', userAnswer: 'A' },
          ],
        }),
      }) as never,
    );
    expect(mocks.captureMistakes).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      { eventIds: ['top-level-legacy'] },
    );
  });

  it('expectedOwnerId mismatch is refused before the store is touched', async () => {
    const { POST } = await import('@/app/api/mistakes/route');
    const response = await POST(
      new Request('http://localhost/api/mistakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageId: 's',
          stageName: 'x',
          sceneId: 'sc',
          expectedOwnerId: 'someone-else',
          items: [
            {
              questionId: 'q1',
              eventId: 'e1',
              questionType: 'single',
              question: 'a',
              userAnswer: 'A',
            },
          ],
        }),
      }) as never,
    );
    expect(response.status).toBe(409);
    expect(mocks.captureMistakes).not.toHaveBeenCalled();
  });
});
