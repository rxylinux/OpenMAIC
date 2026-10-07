import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
const log = createLogger('Azure Voices');

// The voice-list base URL is explicit request input: strict public policy at
// connect (private/loopback/CGNAT and metadata refused regardless of the
// operator opt-in), connect address pinned to the vetted DNS answers, and a 3xx
// refused rather than followed.
const VOICES_POLICY: ProviderFetchPolicy = { allowLocalNetworks: false, rejectRedirects: true };

// Fixed messages: the target's status, body and transport errors are logged
// server-side only and never echoed back to the caller.
const AUTH_FAILED_MESSAGE = 'Authentication failed, please check the API Key';
const FETCH_FAILED_MESSAGE = 'Failed to fetch voices from Azure';

export const maxDuration = 30;

/**
 * Azure TTS Voice List API
 * Fetches available voices from Azure Speech Services
 */
export async function POST(req: NextRequest) {
  let baseUrl: string | undefined;
  try {
    const body = await req.json();
    const { apiKey } = body;
    baseUrl = body.baseUrl;

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'API Key is required');
    }

    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    // The voice-list base URL is always caller-supplied request input: the
    // strict public policy applies at validation and at connect, so the
    // operator's ALLOW_LOCAL_NETWORKS opt-in is not inherited by it.
    const ssrfError = await validatePublicUrlForSSRF(baseUrl);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    // Call Azure voices list endpoint through the strict provider transport
    // (connect-time DNS pinning; redirects refused).
    const response = await providerFetch(
      `${baseUrl}/cognitiveservices/voices/list`,
      {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
        },
        signal: AbortSignal.timeout(20_000),
      },
      VOICES_POLICY,
    );

    if (response.status === 401 || response.status === 403) {
      log.warn(`Azure voices list rejected credentials [status=${response.status}]`);
      await response.body?.cancel().catch(() => undefined);
      return apiError('UPSTREAM_ERROR', 502, AUTH_FAILED_MESSAGE);
    }

    if (!response.ok) {
      log.warn(`Azure voices list failed [status=${response.status}]`);
      await response.body?.cancel().catch(() => undefined);
      return apiError('UPSTREAM_ERROR', 502, FETCH_FAILED_MESSAGE);
    }

    // Only a JSON array is a voice list; anything else (an HTML error page, a
    // JSON object) is logged and refused without its body reaching the caller.
    let voices: unknown;
    try {
      voices = await response.json();
    } catch (error) {
      log.warn('Azure voices list returned a non-JSON body:', error);
      return apiError('UPSTREAM_ERROR', 502, FETCH_FAILED_MESSAGE);
    }
    if (!Array.isArray(voices)) {
      log.warn(`Azure voices list returned ${typeof voices} instead of an array`);
      return apiError('UPSTREAM_ERROR', 502, FETCH_FAILED_MESSAGE);
    }

    return apiSuccess({ voices });
  } catch (error) {
    log.error(`Azure voices fetch failed [baseUrl="${baseUrl ?? 'unknown'}"]:`, error);
    return apiError('INTERNAL_ERROR', 500, FETCH_FAILED_MESSAGE);
  }
}
