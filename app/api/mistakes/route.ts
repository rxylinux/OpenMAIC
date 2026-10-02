/**
 * `/api/mistakes` — owner-scoped mistake book (错题本) API.
 *
 * POST   capture a graded batch of wrong answers (upsert)
 * GET    list mistakes (filter: all | unmastered | mastered, optional stageId)
 * PATCH  mark one mistake mastered / un-mastered
 * DELETE one mistake | every mistake of a stage | all of the owner's
 *
 * Backed by the server persistence provider's PostgreSQL; a deployment
 * without `DATABASE_URL` answers 503 on every method so the client can
 * silently skip capture and hide the entry point.
 */
import type { NextRequest, NextResponse } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import {
  MISTAKE_QUESTION_TYPES,
  captureMistakes,
  classifyStageMistakes,
  deleteAllMistakes,
  deleteMistake,
  deleteStageMistakes,
  listMistakes,
  mistakeRecordView,
  setMistakeMastered,
  type MistakeCaptureItem,
  type MistakeListFilter,
} from '@/lib/persistence/mistake-book';
import { normalizeCourseSubject, normalizeGradeSemester } from '@/lib/curriculum/taxonomy';

export const runtime = 'nodejs';

const MAX_ITEMS_PER_BATCH = 100;
const MAX_QUESTION_CHARS = 32 * 1024;
const MAX_ANALYSIS_CHARS = 16 * 1024;
const MAX_ID_CHARS = 128;
const MAX_TITLE_CHARS = 200;

const LIST_FILTERS: readonly MistakeListFilter[] = ['all', 'unmastered', 'mastered'];

interface CaptureItemBody {
  questionId?: unknown;
  questionType?: unknown;
  question?: unknown;
  options?: unknown;
  correctAnswer?: unknown;
  analysis?: unknown;
  userAnswer?: unknown;
}

interface CaptureBody {
  stageId?: unknown;
  stageName?: unknown;
  sceneId?: unknown;
  sceneTitle?: unknown;
  sceneOrder?: unknown;
  subject?: unknown;
  gradeSemester?: unknown;
  items?: unknown;
}

interface KeyBody {
  stageId?: unknown;
  sceneId?: unknown;
  questionId?: unknown;
  mastered?: unknown;
  all?: unknown;
  /** PATCH variant flag: bulk-set the curriculum classification of a stage. */
  classifyStage?: unknown;
  subject?: unknown;
  gradeSemester?: unknown;
}

/** Static message: owner-scoped responses never echo caller-controlled input. */
const NOT_CONFIGURED = apiError(
  'INTERNAL_ERROR',
  503,
  'The mistake book requires server persistence; this deployment has none.',
);

function isIdString(value: unknown, max = MAX_ID_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseCaptureBody(body: CaptureBody):
  | {
      ok: true;
      stageId: string;
      stageName: string;
      sceneId: string;
      sceneTitle?: string;
      sceneOrder?: number;
      subject?: string;
      gradeSemester?: string;
      items: MistakeCaptureItem[];
    }
  | { ok: false; error: NextResponse } {
  if (!isIdString(body.stageId)) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
  if (!isIdString(body.sceneId)) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
  if (
    typeof body.stageName !== 'string' ||
    !body.stageName.trim() ||
    body.stageName.length > MAX_TITLE_CHARS
  ) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
  if (body.sceneTitle !== undefined && typeof body.sceneTitle !== 'string') {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
  if (
    body.sceneOrder !== undefined &&
    (typeof body.sceneOrder !== 'number' || !Number.isInteger(body.sceneOrder))
  ) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
  // Closed-list codes; undefined is fine (unclassified course), an invalid
  // token is a client bug worth a 400 rather than a silent NULL.
  if (body.subject !== undefined && normalizeCourseSubject(body.subject) === null) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
  if (body.gradeSemester !== undefined && normalizeGradeSemester(body.gradeSemester) === null) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
  if (
    !Array.isArray(body.items) ||
    body.items.length === 0 ||
    body.items.length > MAX_ITEMS_PER_BATCH
  ) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }

  const items: MistakeCaptureItem[] = [];
  for (const raw of body.items as CaptureItemBody[]) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    if (!isIdString(raw.questionId)) {
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    if (
      typeof raw.questionType !== 'string' ||
      !MISTAKE_QUESTION_TYPES.includes(raw.questionType as never)
    ) {
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    if (
      typeof raw.question !== 'string' ||
      !raw.question.trim() ||
      raw.question.length > MAX_QUESTION_CHARS
    ) {
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    if (
      raw.analysis !== undefined &&
      (typeof raw.analysis !== 'string' || raw.analysis.length > MAX_ANALYSIS_CHARS)
    ) {
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    if (raw.userAnswer === undefined) {
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    items.push({
      questionId: raw.questionId,
      questionType: raw.questionType as MistakeCaptureItem['questionType'],
      question: raw.question,
      ...(raw.options !== undefined ? { options: raw.options } : {}),
      ...(raw.correctAnswer !== undefined ? { correctAnswer: raw.correctAnswer } : {}),
      ...(raw.analysis !== undefined ? { analysis: raw.analysis } : {}),
      userAnswer: raw.userAnswer,
    });
  }

  return {
    ok: true,
    stageId: body.stageId,
    stageName: body.stageName,
    sceneId: body.sceneId,
    ...(body.sceneTitle !== undefined && body.sceneTitle !== ''
      ? { sceneTitle: body.sceneTitle.slice(0, MAX_TITLE_CHARS) }
      : {}),
    ...(body.sceneOrder !== undefined ? { sceneOrder: body.sceneOrder } : {}),
    ...(body.subject !== undefined ? { subject: normalizeCourseSubject(body.subject)! } : {}),
    ...(body.gradeSemester !== undefined
      ? { gradeSemester: normalizeGradeSemester(body.gradeSemester)! }
      : {}),
    items,
  };
}

/** Propagate the owner-identity headers the owner wrapper may have set. */
function withOwnerHeaders(response: NextResponse, headers: Headers): NextResponse {
  for (const [key, value] of headers.entries()) {
    if (!response.headers.has(key)) response.headers.set(key, value);
  }
  return response;
}

async function resolveQueryable(): Promise<ConnectableQueryable | null> {
  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return provider ? (provider.pool as unknown as ConnectableQueryable) : null;
}

export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const queryable = await resolveQueryable();
    if (!queryable) return withOwnerHeaders(NOT_CONFIGURED, responseHeaders);

    let body: CaptureBody;
    try {
      body = (await req.json()) as CaptureBody;
    } catch {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid capture request body'),
        responseHeaders,
      );
    }
    if (typeof body !== 'object' || body === null) {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid capture request body'),
        responseHeaders,
      );
    }

    const parsed = parseCaptureBody(body);
    if (!parsed.ok) return withOwnerHeaders(parsed.error, responseHeaders);

    await captureMistakes(queryable, ownerId, parsed, parsed.items);
    return withOwnerHeaders(
      apiSuccess({ data: { captured: parsed.items.length } }),
      responseHeaders,
    );
  });
}

export async function GET(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const queryable = await resolveQueryable();
    if (!queryable) return withOwnerHeaders(NOT_CONFIGURED, responseHeaders);

    const params = new URL(req.url).searchParams;
    const filterParam = params.get('filter') ?? 'all';
    const filter = LIST_FILTERS.includes(filterParam as MistakeListFilter)
      ? (filterParam as MistakeListFilter)
      : 'all';
    const stageId = params.get('stageId') ?? undefined;
    if (stageId !== undefined && !isIdString(stageId)) {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid list request'),
        responseHeaders,
      );
    }

    const records = await listMistakes(queryable, ownerId, { filter, stageId });
    return withOwnerHeaders(
      apiSuccess({ data: { mistakes: records.map(mistakeRecordView) } }),
      responseHeaders,
    );
  });
}

export async function PATCH(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const queryable = await resolveQueryable();
    if (!queryable) return withOwnerHeaders(NOT_CONFIGURED, responseHeaders);

    let body: KeyBody;
    try {
      body = (await req.json()) as KeyBody;
    } catch {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid request body'),
        responseHeaders,
      );
    }
    if (typeof body !== 'object' || body === null) {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid request body'),
        responseHeaders,
      );
    }

    // Variant: bulk curriculum classification of one stage's mistakes.
    // { classifyStage: true, stageId, subject?, gradeSemester? } — the caller
    // also PATCHes the stage metadata itself, so future captures agree.
    if (body.classifyStage === true) {
      if (!isIdString(body.stageId)) {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Invalid request body'),
          responseHeaders,
        );
      }
      if (
        body.subject !== undefined &&
        body.subject !== null &&
        normalizeCourseSubject(body.subject) === null
      ) {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Invalid request body'),
          responseHeaders,
        );
      }
      if (
        body.gradeSemester !== undefined &&
        body.gradeSemester !== null &&
        normalizeGradeSemester(body.gradeSemester) === null
      ) {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Invalid request body'),
          responseHeaders,
        );
      }
      const updated = await classifyStageMistakes(queryable, ownerId, body.stageId, {
        ...(body.subject !== undefined
          ? { subject: body.subject === null ? undefined : normalizeCourseSubject(body.subject)! }
          : {}),
        ...(body.gradeSemester !== undefined
          ? {
              gradeSemester:
                body.gradeSemester === null
                  ? undefined
                  : normalizeGradeSemester(body.gradeSemester)!,
            }
          : {}),
      });
      return withOwnerHeaders(apiSuccess({ data: { classified: updated } }), responseHeaders);
    }

    if (
      !isIdString(body.stageId) ||
      !isIdString(body.sceneId) ||
      !isIdString(body.questionId) ||
      typeof body.mastered !== 'boolean'
    ) {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid request body'),
        responseHeaders,
      );
    }

    const updated = await setMistakeMastered(
      queryable,
      ownerId,
      { stageId: body.stageId, sceneId: body.sceneId, questionId: body.questionId },
      body.mastered,
    );
    if (!updated) {
      return withOwnerHeaders(apiError('ASSET_NOT_FOUND', 404, 'No such mistake'), responseHeaders);
    }
    return withOwnerHeaders(apiSuccess({ data: { updated: true } }), responseHeaders);
  });
}

export async function DELETE(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const queryable = await resolveQueryable();
    if (!queryable) return withOwnerHeaders(NOT_CONFIGURED, responseHeaders);

    let body: KeyBody;
    try {
      body = (await req.json()) as KeyBody;
    } catch {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid request body'),
        responseHeaders,
      );
    }
    if (typeof body !== 'object' || body === null) {
      return withOwnerHeaders(
        apiError('INVALID_REQUEST', 400, 'Invalid request body'),
        responseHeaders,
      );
    }

    // Three mutually exclusive scopes: one row, one stage, everything.
    if (body.all === true) {
      const deleted = await deleteAllMistakes(queryable, ownerId);
      return withOwnerHeaders(apiSuccess({ data: { deleted } }), responseHeaders);
    }
    if (isIdString(body.stageId) && body.sceneId === undefined && body.questionId === undefined) {
      const deleted = await deleteStageMistakes(queryable, ownerId, body.stageId);
      return withOwnerHeaders(apiSuccess({ data: { deleted } }), responseHeaders);
    }
    if (isIdString(body.stageId) && isIdString(body.sceneId) && isIdString(body.questionId)) {
      const removed = await deleteMistake(queryable, ownerId, {
        stageId: body.stageId,
        sceneId: body.sceneId,
        questionId: body.questionId,
      });
      if (!removed) {
        return withOwnerHeaders(
          apiError('ASSET_NOT_FOUND', 404, 'No such mistake'),
          responseHeaders,
        );
      }
      return withOwnerHeaders(apiSuccess({ data: { deleted: 1 } }), responseHeaders);
    }
    return withOwnerHeaders(
      apiError('INVALID_REQUEST', 400, 'Invalid request body'),
      responseHeaders,
    );
  });
}
