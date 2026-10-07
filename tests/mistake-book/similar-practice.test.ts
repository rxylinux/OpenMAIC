// @vitest-environment jsdom

/**
 * SimilarPractice — the mistake card's same-point practice block.
 *
 * The client module is mocked (the outbox/IndexedDB pipeline is out of scope
 * here); the retry-upload controller and the local grading run for real, so
 * these pin the practice contract: generate → answer → verdict, correct
 * marks mastered, wrong ships the original snapshot under a 'similar'
 * event, short answers go through AI grading with a self-assess fallback
 * when no verdict comes back.
 */
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    // Interpolate the point label so the knowledge point is assertable in DOM.
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'point' in options ? `${key}:${String(options.point)}` : key,
    locale: 'zh-CN',
  }),
}));

const mocks = vi.hoisted(() => ({
  grade: vi.fn(),
  onWrongByPage: vi.fn(),
}));

vi.mock('@/lib/quiz/ai-grade', () => ({ gradeShortAnswerQuestion: mocks.grade }));
vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({ modelString: 'm', apiKey: 'k', baseUrl: '', providerType: '' }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Only what SimilarPractice itself consumes; the page-level fetch wrappers
// are replaced with inert stubs because this suite renders the block only.
vi.mock('@/lib/mistake-book/client', () => ({
  encodeEventId: (parts: readonly string[]) => JSON.stringify(parts),
  buildRetryPayload: (
    record: { questionId: string },
    picked: readonly string[],
    eventId: string,
  ) => ({ eventId, items: [{ questionId: record.questionId, userAnswer: picked }] }),
  classifyStage: vi.fn(async () => true),
  deleteMistakeRecord: vi.fn(async () => true),
  fetchMistakes: vi.fn(async () => ({ mistakes: [], configured: true })),
  reportRetryWrong: mocks.onWrongByPage,
  setMistakeMastered: vi.fn(async () => true),
}));

import type { MistakeRecordView } from '@/lib/persistence/mistake-book';
import { SimilarPractice } from '@/app/mistake-book/page';

const RECORD = {
  stageId: 's1',
  stageName: '数学',
  sceneId: 'sc1',
  sceneTitle: '课后练习',
  sceneOrder: 9,
  subject: 'math',
  gradeSemester: null,
  questionId: 'q1',
  questionType: 'single',
  question: '3+2=?',
  options: [
    { label: '4', value: 'A' },
    { label: '5', value: 'B' },
  ],
  correctAnswer: ['B'],
  analysis: '加法',
  knowledgePoint: '10 以内加法',
  lastUserAnswer: ['A'],
  wrongCount: 1,
  firstWrongAt: '2026-10-01T00:00:00.000Z',
  lastWrongAt: '2026-10-01T00:00:00.000Z',
  masteredAt: null,
} as MistakeRecordView;

const GENERATED_SINGLE = {
  id: 'q_similar_1',
  type: 'single',
  question: '4+3=?',
  options: [
    { label: '6', value: 'A' },
    { label: '7', value: 'B' },
  ],
  answer: ['B'],
  analysis: '4 加 3 等于 7。',
  knowledgePoint: '10 以内加法',
  hasAnswer: true,
  points: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn(async () => jsonResponse({ question: GENERATED_SINGLE }));
  vi.stubGlobal('fetch', fetchMock);
  mocks.grade.mockReset();
  mocks.onWrongByPage.mockReset();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

type SimilarPracticeProps = {
  record: MistakeRecordView;
  onMastered: (record: MistakeRecordView, mastered: boolean) => Promise<boolean>;
  onSimilarWrong: (payload: unknown, eventId: string) => Promise<boolean>;
};

async function renderPractice(overrides: Partial<SimilarPracticeProps> = {}) {
  const onMastered = vi.fn(async () => true);
  const onSimilarWrong = vi.fn(async () => true);
  act(() => {
    root!.render(
      createElement(SimilarPractice, {
        record: RECORD,
        onMastered,
        onSimilarWrong,
        ...overrides,
      } as SimilarPracticeProps),
    );
  });
  return { onMastered, onSimilarWrong };
}

/** Type into a controlled textarea the way React's tracker accepts. */
function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttons() {
  return Array.from(container!.querySelectorAll<HTMLButtonElement>('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`button "${text}" not found`);
  return found;
}

/** Click generate and wait for the question to render. */
async function generateQuestion() {
  await act(async () => {
    buttonByText('mistakeBook.practiceGenerate').click();
  });
}

describe('SimilarPractice', () => {
  it('sends the record snapshot (with knowledge point) to the generation API', async () => {
    await renderPractice();
    await generateQuestion();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/generate/similar-question');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      questionType: 'single',
      question: '3+2=?',
      knowledgePoint: '10 以内加法',
      language: 'zh-CN',
    });
    // The fresh question and its knowledge point render.
    expect(container!.textContent).toContain('4+3=?');
    expect(container!.textContent).toContain('mistakeBook.practicePoint:10 以内加法');
  });

  it('marks the record mastered when the fresh question is answered correctly', async () => {
    const { onMastered, onSimilarWrong } = await renderPractice();
    await generateQuestion();

    await act(async () => {
      buttonByText('7').click(); // B — the correct value
    });
    await act(async () => {
      buttonByText('mistakeBook.practiceSubmit').click();
    });

    expect(onMastered).toHaveBeenCalledWith(RECORD, true);
    expect(onSimilarWrong).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('mistakeBook.practiceCorrect');
  });

  it('reports a wrong practice answer as a similar-wrong event with the original snapshot', async () => {
    const { onMastered, onSimilarWrong } = await renderPractice();
    await generateQuestion();

    await act(async () => {
      buttonByText('6').click(); // A — wrong
    });
    await act(async () => {
      buttonByText('mistakeBook.practiceSubmit').click();
    });

    expect(onMastered).not.toHaveBeenCalled();
    expect(onSimilarWrong).toHaveBeenCalledTimes(1);
    const [payload, eventId] = onSimilarWrong.mock.calls[0] as unknown as [
      { eventId: string; items: Array<{ questionId: string; userAnswer: string[] }> },
      string,
    ];
    // The mock payload builder froze the ORIGINAL question id with this
    // attempt's answer; the event id lives in the 'similar' domain.
    expect(payload.items[0]).toMatchObject({ questionId: 'q1', userAnswer: ['A'] });
    expect(JSON.parse(eventId)[0]).toBe('similar');
    expect(container!.textContent).toContain('mistakeBook.practiceWrong');
  });

  it('shows the honest failure copy when generation fails, without losing the retry', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'GENERATION_FAILED' }, 502));
    await renderPractice();
    await generateQuestion();

    expect(container!.textContent).toContain('mistakeBook.practiceGenerateFailed');
    // The generate button remains for a retry.
    expect(buttonByText('mistakeBook.practiceGenerate')).toBeDefined();
  });

  it('grades short answers through AI and marks mastered on a passing verdict', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        question: {
          ...GENERATED_SINGLE,
          type: 'short_answer',
          options: undefined,
          answer: undefined,
          hasAnswer: false,
          commentPrompt: 'Rubric',
        },
      }),
    );
    mocks.grade.mockResolvedValue({
      questionId: 'q_similar_1',
      correct: true,
      status: 'correct',
      earned: 1,
    });
    const { onMastered } = await renderPractice();
    await generateQuestion();

    const textarea = container!.querySelector('textarea')!;
    await act(async () => {
      typeIntoTextarea(textarea, '比 10 大的数都可以');
    });
    await act(async () => {
      buttonByText('mistakeBook.practiceSubmit').click();
    });

    expect(mocks.grade).toHaveBeenCalledTimes(1);
    expect(onMastered).toHaveBeenCalledWith(RECORD, true);
  });

  it('falls back to reference + self-assessment when AI grading returns no verdict', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        question: {
          ...GENERATED_SINGLE,
          type: 'short_answer',
          options: undefined,
          answer: undefined,
          hasAnswer: false,
        },
      }),
    );
    mocks.grade.mockResolvedValue({
      questionId: 'q_similar_1',
      correct: null,
      status: 'ungraded',
      earned: 0,
      aiComment: '评分未完成',
    });
    const { onMastered } = await renderPractice();
    await generateQuestion();

    const textarea = container!.querySelector('textarea')!;
    await act(async () => {
      typeIntoTextarea(textarea, '12');
    });
    await act(async () => {
      buttonByText('mistakeBook.practiceSubmit').click();
    });

    // No verdict: honest undetermined state plus the self-assess escape hatch.
    expect(onMastered).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('mistakeBook.retryUndetermined');
    await act(async () => {
      buttonByText('mistakeBook.selfMarkMastered').click();
    });
    expect(onMastered).toHaveBeenCalledWith(RECORD, true);
  });

  it('grades a choice question with an unverifiable answer key as undetermined — no verdict, no upload', async () => {
    // The generated key aligns with no option (fail-closed resolver): the
    // practice must end in the honest undetermined state, not a guessed one.
    fetchMock.mockResolvedValue(jsonResponse({ question: { ...GENERATED_SINGLE, answer: ['Z'] } }));
    const { onMastered, onSimilarWrong } = await renderPractice();
    await generateQuestion();

    await act(async () => {
      buttonByText('6').click();
    });
    await act(async () => {
      buttonByText('mistakeBook.practiceSubmit').click();
    });

    expect(container!.textContent).toContain('mistakeBook.retryUndetermined');
    expect(onMastered).not.toHaveBeenCalled();
    expect(onSimilarWrong).not.toHaveBeenCalled();
  });

  it('reports an AI-graded wrong short answer as a similar-wrong event with the text answer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        question: {
          ...GENERATED_SINGLE,
          type: 'short_answer',
          options: undefined,
          answer: undefined,
          hasAnswer: false,
        },
      }),
    );
    mocks.grade.mockResolvedValue({
      questionId: 'q_similar_1',
      correct: false,
      status: 'incorrect',
      earned: 0,
    });
    const { onMastered, onSimilarWrong } = await renderPractice();
    await generateQuestion();

    const textarea = container!.querySelector('textarea')!;
    await act(async () => {
      typeIntoTextarea(textarea, '12');
    });
    await act(async () => {
      buttonByText('mistakeBook.practiceSubmit').click();
    });

    expect(onMastered).not.toHaveBeenCalled();
    expect(onSimilarWrong).toHaveBeenCalledTimes(1);
    const [payload, eventId] = onSimilarWrong.mock.calls[0] as unknown as [
      { eventId: string; items: Array<{ questionId: string; userAnswer: string[] }> },
      string,
    ];
    // The written answer ships as the attempt under the 'similar' domain.
    expect(payload.items[0]).toMatchObject({ questionId: 'q1', userAnswer: ['12'] });
    expect(JSON.parse(eventId)[0]).toBe('similar');
    expect(container!.textContent).toContain('mistakeBook.practiceWrong');
  });
});
