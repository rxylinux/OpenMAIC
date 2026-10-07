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
  applyStageClassification,
  captureMistakes,
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
  /** Stable per-question event id (R9); absent = legacy non-idempotent capture. */
  eventId?: unknown;
  questionType?: unknown;
  question?: unknown;
  options?: unknown;
  correctAnswer?: unknown;
  analysis?: unknown;
  knowledgePoint?: unknown;
  userAnswer?: unknown;
}

interface CaptureBody {
  /**
   * Legacy single-event id for one-item payloads (applied to that item).
   * Per-item eventIds in items[] take precedence; validated identically.
   */
  eventId?: unknown;
  /**
   * Expected-owner guard (R8): the server owner id the client observed when
   * the event was created. When present and it does not match the request's
   * actual owner, the write is refused (409) — an identity switch between
   * confirmation and POST can never pollute the new owner's data.
   */
  expectedOwnerId?: unknown;
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

/**
 * Unconfigured-deployment gate (R10): a blank/absent DATABASE_URL answers
 * 503 BEFORE any provider resolution — no pool is created, no network is
 * touched. Fresh per call: a shared mutable Response would leak one owner's
 * minted Set-Cookie into every other owner's response.
 */
function notConfiguredResponse(): NextResponse {
  return apiError(
    'INTERNAL_ERROR',
    503,
    'The mistake book requires server persistence; this deployment has none.',
  );
}

/** True when the deployment carries a non-blank DATABASE_URL. */
function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

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
  if (body.eventId !== undefined && !isIdString(body.eventId, 256)) {
    return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
  }
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
    if (raw.eventId !== undefined && !isIdString(raw.eventId, 256)) {
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
    if (
      raw.knowledgePoint !== undefined &&
      (typeof raw.knowledgePoint !== 'string' || raw.knowledgePoint.length > MAX_TITLE_CHARS)
    ) {
      // Same short-string ceiling as titles: a knowledge point is a phrase,
      // not a paragraph.
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    if (raw.userAnswer === undefined) {
      return { ok: false, error: apiError('INVALID_REQUEST', 400, 'Invalid capture request body') };
    }
    items.push({
      questionId: raw.questionId,
      questionType: raw.questionType as MistakeCaptureItem['questionType'],
      question: raw.question,
      ...(raw.eventId !== undefined ? { eventId: raw.eventId } : {}),
      ...(raw.options !== undefined ? { options: raw.options } : {}),
      ...(raw.correctAnswer !== undefined ? { correctAnswer: raw.correctAnswer } : {}),
      ...(raw.analysis !== undefined ? { analysis: raw.analysis } : {}),
      ...(raw.knowledgePoint !== undefined && raw.knowledgePoint !== ''
        ? { knowledgePoint: raw.knowledgePoint }
        : {}),
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
function withOwnerHeaders(
  response: NextResponse,
  headers: Headers,
  ownerId?: string,
): NextResponse {
  for (const [key, value] of headers.entries()) {
    if (!response.headers.has(key)) response.headers.set(key, value);
  }
  // No-secret owner echo: lets the browser-side outbox bind queued events to
  // the SERVER identity (the HttpOnly cookie itself is unreadable there).
  if (ownerId) response.headers.set('x-owner-id', ownerId);
  return response;
}

async function resolveQueryable(): Promise<ConnectableQueryable | null> {
  if (!databaseConfigured()) return null; // never initialize a pool when unset
  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL!);
  return provider ? (provider.pool as unknown as ConnectableQueryable) : null;
}
async function captureAndRespond(
  queryable: ConnectableQueryable,
  ownerId: string,
  parsed: Extract<ReturnType<typeof parseCaptureBody>, { ok: true }>,
  topLevelEventId?: string,
) {
  // REAL event-contract pass-through (R9): item-level ids win; a legacy
  // top-level eventId applies to a SINGLE-item payload only; anything else is
  // a legacy non-idempotent capture (undefined per item).
  // PER-ITEM event ids (delivery addendum): a batch with mixed tagged and
  // legacy items keeps each item's own contract — a tagged item NEVER loses
  // its id because a sibling lacks one. Only a single-item payload may fall
  // back to the legacy top-level id; truly untagged items stay undefined
  // (legacy, non-idempotent).
  const eventIds = parsed.items.map((item, index) => {
    if ('eventId' in item) return (item as { eventId: string }).eventId;
    if (parsed.items.length === 1 && index === 0 && topLevelEventId) return topLevelEventId;
    return undefined;
  });
  const receipt = await captureMistakes(queryable, ownerId, parsed, parsed.items, { eventIds });
  return apiSuccess({
    data: {
      captured: receipt.created.length + receipt.counted.length,
      created: receipt.created,
      counted: receipt.counted,
      duplicates: receipt.duplicates,
    },
  });
}

export async function POST(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const queryable = await resolveQueryable();
    if (!queryable) return withOwnerHeaders(notConfiguredResponse(), responseHeaders, ownerId);

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
    if (!parsed.ok) return withOwnerHeaders(parsed.error, responseHeaders, ownerId);

    // Expected-owner defense (R8): fail closed BEFORE any write when the
    // client's confirmed identity no longer matches the request identity.
    if (typeof body.expectedOwnerId === 'string' && body.expectedOwnerId !== ownerId) {
      // Owner-mismatch is an IDENTITY refusal (recoverable when the creator
      // identity returns) — deliberately a different code from the permanent
      // event-payload conflict below.
      return withOwnerHeaders(
        apiError('OWNER_MISMATCH', 409, 'Owner identity changed; event not attributed'),
        responseHeaders,
        ownerId,
      );
    }
    try {
      return withOwnerHeaders(
        await captureAndRespond(queryable, ownerId, parsed, body.eventId as string | undefined),
        responseHeaders,
        ownerId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'EVENT_PAYLOAD_CONFLICT') {
        return withOwnerHeaders(
          apiError(
            'EVENT_PAYLOAD_CONFLICT',
            409,
            'Event id already recorded with different content',
          ),
          responseHeaders,
        );
      }
      if (message === 'DUPLICATE_EVENT_ID_IN_BATCH' || message === 'DUPLICATE_QUESTION_IN_BATCH') {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Duplicate question/event within one capture batch'),
          responseHeaders,
        );
      }
      throw error;
    }
  });
}

export async function GET(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const queryable = await resolveQueryable();
    if (!queryable) return withOwnerHeaders(notConfiguredResponse(), responseHeaders, ownerId);

    const params = new URL(req.url).searchParams;

    // Lightweight badge count (R11): unmastered rows only, no row payloads.
    if (params.get('count')) {
      const result = await queryable.query<{ n: number } & Record<string, unknown>>(
        'SELECT count(*)::int AS n FROM mistake_record WHERE owner_id = $1 AND mastered_at IS NULL',
        [ownerId],
      );
      return withOwnerHeaders(
        apiSuccess({ data: { count: result.rows[0]?.n ?? 0 } }),
        responseHeaders,
        ownerId,
      );
    }
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
    if (!queryable) return withOwnerHeaders(notConfiguredResponse(), responseHeaders, ownerId);

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

    // Variant: the single server-side classification command for one stage.
    // Tri-state per field: omitted = keep, null = clear, valid code = set.
    // Requires only server persistence (never the agent runtime); the course
    // metadata join happens inside the same command when the course exists,
    // belongs to this owner, and is alive.
    if (body.classifyStage === true) {
      if (!isIdString(body.stageId)) {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Invalid request body'),
          responseHeaders,
        );
      }
      const subject =
        body.subject === undefined || body.subject === null
          ? body.subject
          : normalizeCourseSubject(body.subject);
      const gradeSemester =
        body.gradeSemester === undefined || body.gradeSemester === null
          ? body.gradeSemester
          : normalizeGradeSemester(body.gradeSemester);
      if (body.subject !== undefined && body.subject !== null && subject === null) {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Invalid request body'),
          responseHeaders,
        );
      }
      if (
        body.gradeSemester !== undefined &&
        body.gradeSemester !== null &&
        gradeSemester === null
      ) {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Invalid request body'),
          responseHeaders,
        );
      }
      if (body.subject === undefined && body.gradeSemester === undefined) {
        return withOwnerHeaders(
          apiError('INVALID_REQUEST', 400, 'Invalid request body'),
          responseHeaders,
        );
      }

      const outcome = await applyStageClassification(
        queryable,
        { ownerId, stageId: body.stageId },
        {
          ...(subject === undefined ? {} : { subject }),
          ...(gradeSemester === undefined ? {} : { gradeSemester }),
        },
      );
      if (!outcome.matched) {
        return withOwnerHeaders(
          apiError('ASSET_NOT_FOUND', 404, 'No mistakes or course to classify for this stage'),
          responseHeaders,
        );
      }
      return withOwnerHeaders(
        apiSuccess({
          data: {
            classified: outcome.mistakeRows,
            courseUpdated: outcome.courseUpdated,
            classification: {
              subject: outcome.classification?.subject ?? null,
              gradeSemester: outcome.classification?.gradeSemester ?? null,
            },
          },
        }),
        responseHeaders,
      );
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
      return withOwnerHeaders(
        apiError('ASSET_NOT_FOUND', 404, 'No such mistake'),
        responseHeaders,
        ownerId,
      );
    }
    return withOwnerHeaders(apiSuccess({ data: { updated: true } }), responseHeaders, ownerId);
  });
}

export async function DELETE(req: NextRequest) {
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const queryable = await resolveQueryable();
    if (!queryable) return withOwnerHeaders(notConfiguredResponse(), responseHeaders, ownerId);

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
      return withOwnerHeaders(apiSuccess({ data: { deleted } }), responseHeaders, ownerId);
    }
    if (isIdString(body.stageId) && body.sceneId === undefined && body.questionId === undefined) {
      const deleted = await deleteStageMistakes(queryable, ownerId, body.stageId);
      return withOwnerHeaders(apiSuccess({ data: { deleted } }), responseHeaders, ownerId);
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
      return withOwnerHeaders(apiSuccess({ data: { deleted: 1 } }), responseHeaders, ownerId);
    }
    return withOwnerHeaders(
      apiError('INVALID_REQUEST', 400, 'Invalid request body'),
      responseHeaders,
    );
  });
}
