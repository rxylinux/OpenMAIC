/**
 * Route-level tests for `/api/generate/similar-question`. The LLM call and
 * model resolution are mocked; the generation-package prompt + normalization
 * run for real, so these pin the HTTP contract end to end (validation, the
 * fail-closed 502, and the normalized question shape).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

function modelAnswer(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

const VALID_BODY = {
  questionType: 'single',
  question: '2 + 3 = ?',
  options: [
    { label: '4', value: 'A' },
    { label: '5', value: 'B' },
  ],
  correctAnswer: ['B'],
  analysis: '2 加 3 等于 5。',
  knowledgePoint: '10 以内加法',
};

const MODEL_SINGLE = modelAnswer({
  id: 'q_model',
  type: 'single',
  question: '4 + 3 = ?',
  options: [
    { label: '6', value: 'A' },
    { label: '7', value: 'B' },
    { label: '8', value: 'C' },
  ],
  answer: ['B'],
  analysis: '4 加 3 等于 7。',
  knowledgePoint: '10 以内加法',
  points: 10,
});

async function post(body: unknown) {
  const { POST } = await import('@/app/api/generate/similar-question/route');
  const request = new Request('http://localhost/api/generate/similar-question', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

beforeEach(() => {
  mocks.callLLM.mockReset().mockResolvedValue({ text: MODEL_SINGLE });
  mocks.resolveModelFromRequest.mockReset().mockResolvedValue({
    model: 'test-model',
    thinkingConfig: undefined,
  });
});

describe('POST /api/generate/similar-question', () => {
  it('returns the normalized fresh question', async () => {
    const response = await post(VALID_BODY);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.question).toMatchObject({
      type: 'single',
      question: '4 + 3 = ?',
      answer: ['B'],
      knowledgePoint: '10 以内加法',
      hasAnswer: true,
    });
    expect(json.question.id).toMatch(/^q_similar_/);
  });

  it('routes the LLM call through the similar-question stage', async () => {
    await post(VALID_BODY);
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model' }),
      'similar-question',
      undefined,
      undefined,
    );
  });

  it('answers 400 for an invalid body', async () => {
    for (const body of [
      { ...VALID_BODY, questionType: 'essay' },
      { ...VALID_BODY, question: '' },
      { ...VALID_BODY, options: { A: 'nope' } },
      { ...VALID_BODY, knowledgePoint: 'x'.repeat(201) },
      { ...VALID_BODY, analysis: 42 },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('answers 502, never a fabricated question, on unparseable output', async () => {
    mocks.callLLM.mockResolvedValue({ text: 'definitely not json' });
    const response = await post(VALID_BODY);
    expect(response.status).toBe(502);
  });

  it('answers 502 when the model drifts to another question type', async () => {
    mocks.callLLM.mockResolvedValue({
      text: modelAnswer({ ...JSON.parse(MODEL_SINGLE), type: 'short_answer' }),
    });
    const response = await post(VALID_BODY);
    expect(response.status).toBe(502);
  });

  it('falls back to the input knowledge point when the model omits it', async () => {
    mocks.callLLM.mockResolvedValue({
      text: modelAnswer({ ...JSON.parse(MODEL_SINGLE), knowledgePoint: undefined }),
    });
    const response = await post(VALID_BODY);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.question.knowledgePoint).toBe('10 以内加法');
  });
});
