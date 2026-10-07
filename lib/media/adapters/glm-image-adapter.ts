/**
 * GLM (Zhipu BigModel) Image Generation Adapter
 *
 * Zhipu exposes an OpenAI-compatible Images API:
 * Endpoint: https://open.bigmodel.cn/api/paas/v4/images/generations
 *
 * CogView models accept a fixed set of `size` values; requested dimensions are
 * snapped to the closest supported resolution before sending.
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { mediaFetchFor } from '../media-fetch';
import { probeAuth } from '../probe-auth';
import { requireModel } from '../require-model';

const DEFAULT_MODEL = 'cogview-3-flash';
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/** CogView-supported resolutions (width x height), per BigModel docs. */
const SUPPORTED_SIZES: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1024, height: 1024 },
  { width: 768, height: 1344 },
  { width: 864, height: 1152 },
  { width: 1344, height: 768 },
  { width: 1152, height: 864 },
  { width: 1440, height: 720 },
  { width: 720, height: 1440 },
];

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

/** Snap requested dimensions to the CogView size with the closest aspect ratio. */
function resolveCogViewSize(options: ImageGenerationOptions): string {
  const width = options.width || 1024;
  const height = options.height || 1024;
  const target = width / height;
  let best = SUPPORTED_SIZES[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const size of SUPPORTED_SIZES) {
    const delta = Math.abs(size.width / size.height - target);
    if (delta < bestDelta) {
      best = size;
      bestDelta = delta;
    }
  }
  return `${best.width}x${best.height}`;
}

export async function testGlmImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchImpl = mediaFetchFor(config);
  return probeAuth({
    providerName: 'GLM Image',
    request: () =>
      fetchImpl(`${baseUrl}/images/generations`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODEL,
          prompt: '',
          n: 1,
        }),
      }),
  });
}

export async function generateWithGlmImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchImpl = mediaFetchFor(config);

  const response = await fetchImpl(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: requireModel(config.model, 'GLM Image'),
      prompt: options.prompt,
      n: 1,
      size: resolveCogViewSize(options),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GLM image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // OpenAI-compatible response format: { data: [{ url, b64_json }] }
  const imageData = data.data?.[0];
  if (!imageData) {
    throw new Error('GLM returned empty image response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width: options.width || 1024,
    height: options.height || 1024,
  };
}
