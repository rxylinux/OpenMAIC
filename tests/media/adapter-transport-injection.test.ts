/**
 * All-17 media adapter transport-injection matrix (every adapter shipped under
 * lib/media/adapters).
 *
 * For every adapter the exported connectivity probe AND the generate flow are
 * driven with a server-injected `fetchImpl` (the seam `withMediaProviderFetch`
 * installs). The injected spy stands in for the socket boundary; the adapters
 * run for real, so the matrix proves each one issues its submit / poll /
 * content / connectivity requests through the injected transport — never the
 * global fetch (stubbed here to fail loudly). Polled flows return their
 * terminal state on the first poll; long poll intervals are covered by the
 * per-test timeout budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  testComfyuiImageConnectivity,
  generateWithComfyuiImage,
} from '@/lib/media/adapters/comfyui-image-adapter';
import {
  testGlmImageConnectivity,
  generateWithGlmImage,
} from '@/lib/media/adapters/glm-image-adapter';
import {
  testGrokImageConnectivity,
  generateWithGrokImage,
} from '@/lib/media/adapters/grok-image-adapter';
import {
  testGrokVideoConnectivity,
  generateWithGrokVideo,
} from '@/lib/media/adapters/grok-video-adapter';
import {
  testHappyHorseConnectivity,
  generateWithHappyHorse,
} from '@/lib/media/adapters/happyhorse-adapter';
import { testKlingConnectivity, generateWithKling } from '@/lib/media/adapters/kling-adapter';
import {
  testLemonadeImageConnectivity,
  generateWithLemonadeImage,
} from '@/lib/media/adapters/lemonade-image-adapter';
import {
  testMiniMaxImageConnectivity,
  generateWithMiniMaxImage,
} from '@/lib/media/adapters/minimax-image-adapter';
import {
  testMiniMaxVideoConnectivity,
  generateWithMiniMaxVideo,
} from '@/lib/media/adapters/minimax-video-adapter';
import {
  testNanoBananaConnectivity,
  generateWithNanoBanana,
} from '@/lib/media/adapters/nano-banana-adapter';
import {
  testOpenAIImageConnectivity,
  generateWithOpenAIImage,
} from '@/lib/media/adapters/openai-image-adapter';
import {
  testOpenRouterImageConnectivity,
  generateWithOpenRouterImage,
} from '@/lib/media/adapters/openrouter-image-adapter';
import {
  testOpenRouterVideoConnectivity,
  generateWithOpenRouterVideo,
} from '@/lib/media/adapters/openrouter-video-adapter';
import {
  testQwenImageConnectivity,
  generateWithQwenImage,
} from '@/lib/media/adapters/qwen-image-adapter';
import {
  testSeedanceConnectivity,
  generateWithSeedance,
} from '@/lib/media/adapters/seedance-adapter';
import {
  testSeedreamConnectivity,
  generateWithSeedream,
} from '@/lib/media/adapters/seedream-adapter';
import { testVeoConnectivity, generateWithVeo } from '@/lib/media/adapters/veo-adapter';

import type { MediaProviderFetch } from '@/lib/media/types';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const IMG_OPTS = { prompt: 'a cat' };
const VID_OPTS = { prompt: 'a wave' };

interface Case {
  name: string;
  probe: (fetchImpl: MediaProviderFetch) => Promise<unknown>;
  generate: (fetchImpl: MediaProviderFetch) => Promise<unknown>;
  /** Substrings of the URLs the adapter must hit through the transport. */
  expectUrls: string[];
  timeout?: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const CASES: Case[] = [
  {
    name: 'comfyui-image',
    probe: (f) => testComfyuiImageConnectivity(imageConfig('http://comfyui.example.test', f)),
    generate: (f) =>
      generateWithComfyuiImage(
        {
          providerId: 'comfyui-image',
          apiKey: '',
          baseUrl: 'http://comfyui.example.test',
          model: 'comfyui-workflow.json',
          fetchImpl: f,
        },
        IMG_OPTS,
      ),
    expectUrls: ['/system_stats', '/prompt', '/history/', '/view?'],
    timeout: 30_000,
  },
  {
    name: 'glm-image',
    probe: (f) => testGlmImageConnectivity(imageConfig('https://glm.example.test', f)),
    generate: (f) => generateWithGlmImage(imageConfig('https://glm.example.test', f), IMG_OPTS),
    expectUrls: ['/images/generations'],
  },
  {
    name: 'grok-image',
    probe: (f) => testGrokImageConnectivity(imageConfig('https://grok.example.test', f)),
    generate: (f) => generateWithGrokImage(imageConfig('https://grok.example.test', f), IMG_OPTS),
    expectUrls: ['/images/generations'],
  },
  {
    name: 'grok-video',
    probe: (f) => testGrokVideoConnectivity(videoConfig('https://grokv.example.test', f)),
    generate: (f) => generateWithGrokVideo(videoConfig('https://grokv.example.test', f), VID_OPTS),
    expectUrls: ['/videos/generations', '/videos/r1'],
    timeout: 30_000,
  },
  {
    name: 'happyhorse',
    probe: (f) => testHappyHorseConnectivity(videoConfig('https://hh.example.test', f)),
    generate: (f) => generateWithHappyHorse(videoConfig('https://hh.example.test', f), VID_OPTS),
    expectUrls: ['/video-synthesis', '/tasks/'],
    timeout: 40_000,
  },
  {
    name: 'kling',
    probe: (f) => testKlingConnectivity(videoConfig('https://kling.example.test', f, 'ak:sk')),
    generate: (f) =>
      generateWithKling(videoConfig('https://kling.example.test', f, 'ak:sk'), VID_OPTS),
    expectUrls: ['/text2video', '/text2video/'],
    timeout: 30_000,
  },
  {
    name: 'lemonade-image',
    probe: (f) => testLemonadeImageConnectivity(imageConfig('http://lemonade.example.test', f)),
    generate: (f) =>
      generateWithLemonadeImage(imageConfig('http://lemonade.example.test', f), IMG_OPTS),
    expectUrls: ['/models', '/images/generations'],
  },
  {
    name: 'minimax-image',
    probe: (f) => testMiniMaxImageConnectivity(imageConfig('https://mm.example.test', f)),
    generate: (f) => generateWithMiniMaxImage(imageConfig('https://mm.example.test', f), IMG_OPTS),
    expectUrls: ['/image_generation'],
  },
  {
    name: 'minimax-video',
    probe: (f) => testMiniMaxVideoConnectivity(videoConfig('https://mmv.example.test', f)),
    generate: (f) => generateWithMiniMaxVideo(videoConfig('https://mmv.example.test', f), VID_OPTS),
    expectUrls: ['/video_generation', '/files/retrieve'],
    timeout: 30_000,
  },
  {
    name: 'nano-banana',
    probe: (f) => testNanoBananaConnectivity(imageConfig('https://nb.example.test', f)),
    generate: (f) => generateWithNanoBanana(imageConfig('https://nb.example.test', f), IMG_OPTS),
    expectUrls: ['/v1beta/models', ':generateContent'],
  },
  {
    name: 'openai-image',
    probe: (f) => testOpenAIImageConnectivity(imageConfig('https://oai.example.test', f)),
    generate: (f) => generateWithOpenAIImage(imageConfig('https://oai.example.test', f), IMG_OPTS),
    expectUrls: ['/models/', '/images/generations'],
  },
  {
    name: 'openrouter-image',
    probe: (f) => testOpenRouterImageConnectivity(imageConfig('https://ori.example.test', f)),
    generate: (f) =>
      generateWithOpenRouterImage(imageConfig('https://ori.example.test', f), IMG_OPTS),
    expectUrls: ['/key', '/images'],
  },
  {
    name: 'openrouter-video',
    probe: (f) => testOpenRouterVideoConnectivity(videoConfig('https://orv.example.test', f)),
    generate: (f) =>
      generateWithOpenRouterVideo(videoConfig('https://orv.example.test', f), VID_OPTS),
    expectUrls: ['/key', '/videos'],
    timeout: 30_000,
  },
  {
    name: 'qwen-image',
    probe: (f) => testQwenImageConnectivity(imageConfig('https://qwen.example.test', f)),
    generate: (f) => generateWithQwenImage(imageConfig('https://qwen.example.test', f), IMG_OPTS),
    expectUrls: ['/multimodal-generation/generation'],
  },
  {
    name: 'seedance',
    probe: (f) => testSeedanceConnectivity(videoConfig('https://sd.example.test', f)),
    generate: (f) => generateWithSeedance(videoConfig('https://sd.example.test', f), VID_OPTS),
    expectUrls: ['/contents/generations/tasks'],
    timeout: 30_000,
  },
  {
    name: 'seedream',
    probe: (f) => testSeedreamConnectivity(imageConfig('https://sr.example.test', f)),
    generate: (f) => generateWithSeedream(imageConfig('https://sr.example.test', f), IMG_OPTS),
    expectUrls: ['/images/generations'],
  },
  {
    name: 'veo',
    probe: (f) => testVeoConnectivity(videoConfig('https://veo.example.test', f)),
    generate: (f) => generateWithVeo(videoConfig('https://veo.example.test', f), VID_OPTS),
    expectUrls: [':predictLongRunning', ':fetchPredictOperation'],
    timeout: 30_000,
  },
];

function imageConfig(baseUrl: string, fetchImpl: MediaProviderFetch) {
  return { providerId: 'openai-image', apiKey: 'k', baseUrl, model: 'm', fetchImpl } as const;
}

function videoConfig(baseUrl: string, fetchImpl: MediaProviderFetch, apiKey = 'k') {
  return { providerId: 'grok-video', apiKey, baseUrl, model: 'm', fetchImpl } as const;
}

describe('media adapter transport injection matrix (17 adapters)', () => {
  const globalFetch = vi.fn();

  beforeEach(() => {
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(CASES)(
    '$name: connectivity probe and generate flow ride the injected transport',
    async (testCase) => {
      const seen: string[] = [];
      const fetchImpl: MediaProviderFetch = async (input, init) => {
        const url = String(input);
        seen.push(url);
        void init;
        return scripted(url);
      };

      // The probe runs first and must itself ride the transport: a generate
      // flow cannot mask missing probe wiring.
      const probeSeen = seen.length;
      const probeResult = (await testCase.probe(fetchImpl)) as { success: boolean };
      expect(seen.length).toBeGreaterThan(probeSeen);

      await testCase.generate(fetchImpl);

      expect(globalFetch).not.toHaveBeenCalled();
      void probeResult;
      for (const fragment of testCase.expectUrls) {
        expect(
          seen.some((url) => url.includes(fragment)),
          `expected a request containing "${fragment}", saw: ${seen.join(', ')}`,
        ).toBe(true);
      }
    },
    // Generous per-case timeout: polled adapters sleep between submit and poll.
    40_000,
  );
});

/**
 * One scripted socket boundary per adapter family: submit answers a task id,
 * polls answer the terminal state, downloads answer bytes, everything else
 * answers a benign success-shaped JSON.
 */
function scripted(url: string): Response {
  // grok-video submit/poll
  if (url.endsWith('/videos/generations') && !url.includes('/videos/r')) {
    return json({ request_id: 'r1' });
  }
  if (/\/videos\/r1$/.test(url)) {
    return json({ status: 'done', video: { url: 'https://cdn.example.test/v.mp4', duration: 6 } });
  }
  // happyhorse submit/poll
  if (url.includes('/video-synthesis')) {
    return json({ output: { task_id: 't1' }, usage: { duration: 5 } });
  }
  if (/\/tasks\/t1$/.test(url) || url.includes('/tasks/connectivity-test')) {
    return json({
      output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example.test/h.mp4' },
      usage: { duration: 5, ratio: '16:9' },
    });
  }
  // kling submit/poll
  if (/\/text2video$/.test(url)) return json({ code: 0, data: { task_id: 'k1' } });
  if (/\/text2video\/k1$/.test(url) || url.includes('/text2video/connectivity-test')) {
    return json({
      code: 0,
      data: {
        task_status: 'succeed',
        task_result: { videos: [{ url: 'https://cdn.example.test/k.mp4', duration: '5' }] },
      },
    });
  }
  // minimax video: v1 submit → file_id; poll → Success; retrieve → download url
  if (url.includes('/v1/video_generation')) {
    return json({ base_resp: { status_code: 0 }, task_id: 'm1', file_id: undefined });
  }
  if (url.includes('/v1/query/video_generation')) {
    return json({
      base_resp: { status_code: 0 },
      status: 'Success',
      file_id: 'f1',
      video_width: 1920,
      video_height: 1080,
    });
  }
  if (url.includes('/v1/files/retrieve')) {
    return json({
      base_resp: { status_code: 0 },
      file: { download_url: 'https://cdn.example.test/m.mp4' },
    });
  }
  // openrouter video: submit answers pending, the poll answers completed, and
  // only then does the content download run — all three legs are exercised.
  if (/\/videos\/j1\/content\?index=0$/.test(url)) {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    });
  }
  if (/\/videos\/j1$/.test(url)) {
    return json({ id: 'j1', status: 'completed' });
  }
  if (url.endsWith('/videos')) return json({ id: 'j1', status: 'pending' });
  // seedance: submit is POST .../tasks (url ends with /tasks); poll is GET .../tasks/s1
  if (/\/contents\/generations\/tasks$/.test(url)) {
    return json({ id: 's1' });
  }
  if (/\/tasks\/s1$/.test(url) || url.includes('connectivity-test-nonexistent')) {
    return json({
      id: 's1',
      status: 'succeeded',
      content: { video_url: 'https://cdn.example.test/s.mp4' },
      usage: { ratio: '16:9', resolution: '720p', duration: 5 },
      ratio: '16:9',
      resolution: '720p',
      duration: 5,
    });
  }
  // veo
  if (url.includes(':predictLongRunning')) {
    return json({ name: 'ops/1', done: false });
  }
  if (url.includes(':fetchPredictOperation')) {
    return json({
      name: 'ops/1',
      done: true,
      response: {
        videos: [{ bytesBase64Encoded: Buffer.from('v').toString('base64') }],
      },
    });
  }
  // comfyui
  if (url.endsWith('/system_stats')) return json({ system: {} });
  if (url.endsWith('/prompt')) return json({ prompt_id: 'p1', number: 1 });
  if (url.includes('/history/p1')) {
    return json({
      p1: {
        status: { status_str: 'success', completed: true },
        outputs: { n1: { images: [{ filename: 'img.png', subfolder: '', type: 'output' }] } },
      },
    });
  }
  if (url.includes('/view?')) {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }
  // image generation families
  if (url.includes(':generateContent')) {
    return json({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: { data: Buffer.from('img').toString('base64'), mimeType: 'image/png' },
              },
            ],
          },
        },
      ],
    });
  }
  if (url.includes('/v1/image_generation')) {
    // MiniMax Image reads data.data.image_urls.
    return json({
      data: { image_urls: ['https://cdn.example.test/i.png'] },
      base_resp: { status_code: 0 },
    });
  }
  if (url.includes('/images/generations') || url.endsWith('/images')) {
    return json({
      data: [
        { url: 'https://cdn.example.test/i.png', b64_json: Buffer.from('i').toString('base64') },
      ],
      images: ['https://cdn.example.test/i.png'],
      base_resp: { status_code: 0 },
    });
  }
  if (url.includes('/multimodal-generation/generation')) {
    return json({
      output: {
        choices: [{ message: { content: [{ image: 'https://cdn.example.test/q.png' }] } }],
      },
    });
  }
  // model lists / key metadata / lemonade models
  if (url.endsWith('/models') || url.includes('/models/') || url.endsWith('/key')) {
    return json({ data: [{ id: 'm' }], owned_by: 'x' });
  }
  return json({ ok: true });
}
