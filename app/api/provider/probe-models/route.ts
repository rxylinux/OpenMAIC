import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import { fetchModels, ModelFetchError } from '@/lib/server/model-fetch';
import { isRejectedRedirectError } from '@/lib/server/provider-fetch';

const log = createLogger('ProbeModels');

// Fixed messages: the provider's body, status text and transport errors are
// logged server-side only and never echoed back to the caller.
const CONNECTION_FAILED_MESSAGE = 'Cannot connect to the provider, please check the Base URL';

/** Model ids that are not chat models — filtered out of probe results. */
const NON_CHAT_PATTERN = /(tts|asr|whisper|embedding|rerank|mineru|image|video|voxcpm|moderation)/i;

/**
 * POST /api/provider/probe-models
 *
 * Discovers the chat models a base URL + key exposes, via the OpenAI-compatible
 * /models endpoint (with multi-candidate fallback). Returns the lit-up list, or
 * a typed status so the UI can fall back to manual model entry.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { baseUrl, apiKey, modelsUrl } = body as {
      baseUrl?: string;
      apiKey?: string;
      modelsUrl?: string;
    };

    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'baseUrl is required');
    }

    // Both the base URL and an explicit models URL override are caller input:
    // the strict public policy applies (the operator's ALLOW_LOCAL_NETWORKS
    // opt-in is not inherited by request URLs).
    for (const url of [baseUrl, modelsUrl].filter(Boolean) as string[]) {
      const ssrfError = await validatePublicUrlForSSRF(url);
      if (ssrfError) return apiError('INVALID_REQUEST', 400, ssrfError);
    }

    const models = await fetchModels(baseUrl, apiKey || '', { modelsUrlOverride: modelsUrl });
    const chatModels = models.filter((m) => !NON_CHAT_PATTERN.test(m.id));

    return apiSuccess({
      models: chatModels.map((m) => ({ id: m.id, ownedBy: m.ownedBy })),
      total: models.length,
      filtered: models.length - chatModels.length,
    });
  } catch (error) {
    if (error instanceof ModelFetchError) {
      if (error.status >= 300 && error.status < 400) {
        return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
      }
      if (error.status === 401 || error.status === 403) {
        return apiError('INVALID_REQUEST', 401, 'API key is invalid or expired');
      }
      if (error.status === 404) {
        // No /models endpoint — signal the UI (via 404) to use manual model entry.
        return apiError('INVALID_REQUEST', 404, 'This provider does not expose a model list');
      }
      log.warn(`Model probe failed [status=${error.status}]: ${error.message}`);
      return apiError('UPSTREAM_ERROR', 502, `The provider answered HTTP ${error.status}`);
    }
    if (isRejectedRedirectError(error)) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }
    log.error('Model probe failed:', error);
    // Refused, unresolvable, timed-out and policy-blocked targets all get the
    // same answer so the probe cannot be used to map internal services.
    return apiError('UPSTREAM_ERROR', 502, CONNECTION_FAILED_MESSAGE);
  }
}
