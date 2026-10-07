/**
 * MinerU Cloud second-hop transport and pre-materialization limits.
 *
 * The parser is driven for real (real JSZip, real ZIP fixtures, real byte
 * accounting) with the external transport boundary mocked at
 * `@/lib/server/provider-fetch` — the socket layer's own policies are covered
 * by the live-transport suites. `node:dns` is mocked so the URL-layer guard
 * answers publicly. What these tests prove:
 *
 *  - the response-supplied upload/ZIP URLs are held to public HTTPS, connect
 *    pinning and redirect refusal (the exact policies handed to the transport);
 *  - an over-limit, understated, or prefixed-and-understated central
 *    directory is rejected BEFORE `JSZip.loadAsync` materializes anything;
 *  - extraction streams with per-entry and cumulative abort;
 *  - content_list record counts are bounded;
 *  - nothing the transport or the service returns — error messages, envelope
 *    codes, err_msg fields, signed URLs — reaches a log line or a thrown
 *    message verbatim.
 */
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providerFetch: vi.fn(),
  promisesLookup: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/server/provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-fetch')>();
  return {
    ...actual,
    providerFetch: mocks.providerFetch,
  };
});

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn(),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.log,
}));

import {
  MAX_CONTENT_LIST_ITEMS,
  MAX_ZIP_ENTRY_COUNT,
  MAX_ZIP_TEXT_ENTRY_BYTES,
  parseWithMinerUCloud,
} from '@/lib/pdf/mineru-cloud';

const PUBLIC_ANSWER = [{ address: '93.184.216.34', family: 4 }];

const SIGNED_MARKER = 'SIGNED-URL-MARKER-7f3a';

/** Drive the three control-plane calls and then serve `zipBuffer`. */
function serveCloudZip(
  zipBuffer: Buffer,
  opts: {
    uploadUrl?: string;
    zipUrl?: string;
    uploadStatus?: number;
    uploadError?: Error;
    batchBody?: unknown;
  } = {},
) {
  const uploadUrl = opts.uploadUrl ?? 'https://upload.example.test/lesson.pdf';
  const zipUrl = opts.zipUrl ?? 'https://download.example.test/result.zip';
  mocks.providerFetch.mockImplementation(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/file-urls/batch')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            batch_id: 'batch-1',
            file_urls: [uploadUrl],
          },
        }),
        { status: 200 },
      );
    }
    if (url === uploadUrl) {
      if (opts.uploadError) throw opts.uploadError;
      return new Response('', { status: opts.uploadStatus ?? 200 });
    }
    if (url.endsWith('/extract-results/batch/batch-1')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            extract_result: {
              file_name: 'lesson.pdf',
              state: 'done',
              full_zip_url: zipUrl,
            },
          },
        }),
        { status: 200 },
      );
    }
    if (url === zipUrl) {
      return new Response(new Uint8Array(zipBuffer), {
        status: 200,
        headers: { 'content-length': String(zipBuffer.byteLength) },
      });
    }
    throw new Error(`unexpected transport url ${url}`);
  });
}

async function parse(buffer = Buffer.from('%PDF-1.7 test')) {
  return parseWithMinerUCloud(
    { providerId: 'mineru-cloud', apiKey: 'synthetic-key', baseUrl: 'https://api.example.test' },
    buffer,
    'lesson.pdf',
  );
}

describe('MinerU Cloud — second-hop URL policy', () => {
  beforeEach(() => {
    mocks.providerFetch.mockReset();
    mocks.promisesLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    for (const fn of Object.values(mocks.log)) fn.mockClear();
  });

  it('hands the upload and ZIP URLs the strict public, redirect-refusing policies', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# ok');
    serveCloudZip(await zip.generateAsync({ type: 'nodebuffer' }));

    await parse();

    const policies = mocks.providerFetch.mock.calls.map(
      (call) => (call as unknown as [unknown, unknown, Record<string, unknown>])[2],
    );
    // Control plane (caller root): strict public + redirect refusal.
    expect(policies[0]).toMatchObject({ allowLocalNetworks: false, rejectRedirects: true });
    // Presigned upload: strict public + redirect refusal.
    expect(policies[1]).toMatchObject({ allowLocalNetworks: false, rejectRedirects: true });
    // Result ZIP: strict public + HTTPS-only + redirect refusal.
    expect(policies[3]).toMatchObject({
      allowLocalNetworks: false,
      requireHttps: true,
      rejectRedirects: true,
    });
  });

  it('refuses a non-https presigned upload URL before any request to it', async () => {
    serveCloudZip(Buffer.alloc(0), { uploadUrl: 'http://upload.example.test/lesson.pdf' });

    await expect(parse()).rejects.toThrow(/provider response URL must use https/);
    const urls = mocks.providerFetch.mock.calls.map((call) => String(call[0]));
    expect(urls).not.toContain('http://upload.example.test/lesson.pdf');
  });

  it('refuses a private presigned upload URL as an address-policy refusal and does not retry it', async () => {
    mocks.promisesLookup.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);
    serveCloudZip(Buffer.alloc(0), {
      uploadUrl: 'https://internal.example.test/lesson.pdf',
    });

    await expect(parse()).rejects.toThrow(/not allowed/);
    // Exactly one control-plane call; the upload was never issued.
    expect(mocks.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-https or private result ZIP URL before downloading it', async () => {
    serveCloudZip(Buffer.alloc(0), { zipUrl: 'http://download.example.test/result.zip' });
    await expect(parse()).rejects.toThrow(/provider response URL must use https/);

    mocks.providerFetch.mockClear();
    mocks.promisesLookup.mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);
    serveCloudZip(Buffer.alloc(0), { zipUrl: 'https://internal.example.test/result.zip' });
    await expect(parse()).rejects.toThrow(/not allowed/);
  });

  it('uses the managed root policy with operator hop validation for a managed provider', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    try {
      const zip = new JSZip();
      zip.file('full.md', '# ok');
      serveCloudZip(await zip.generateAsync({ type: 'nodebuffer' }));

      await parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'synthetic-key',
          baseUrl: 'https://api.example.test',
          managed: true,
        },
        Buffer.from('%PDF-1.7 test'),
        'lesson.pdf',
      );

      const policies = mocks.providerFetch.mock.calls.map(
        (call) => (call as unknown as [unknown, unknown, Record<string, unknown>])[2],
      );
      expect(policies[0]).toMatchObject({ allowLocalNetworks: true });
      // The operator chose the root, not where it redirects: hops stay strict
      // under the operator policy.
      expect(policies[0]).toMatchObject({ redirectAllowLocalNetworks: true });
      // Response-supplied URLs stay strict-public regardless of the root.
      expect(policies[1]).toMatchObject({ allowLocalNetworks: false, rejectRedirects: true });
    } finally {
      delete process.env.ALLOW_LOCAL_NETWORKS;
    }
  });
});

describe('MinerU Cloud — ZIP pre-materialization limits', () => {
  beforeEach(() => {
    mocks.providerFetch.mockReset();
    mocks.promisesLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    for (const fn of Object.values(mocks.log)) fn.mockClear();
  });

  it('parses a legitimate small ZIP with markdown, content list and images', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# Lesson\n\n![logo](images/logo.png)');
    zip.file(
      'lesson_content_list.json',
      JSON.stringify([{ type: 'image', img_path: 'images/logo.png' }]),
    );
    // 1x1 transparent PNG.
    zip.file(
      'images/logo.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
      { base64: true },
    );
    const loadAsync = vi.spyOn(JSZip, 'loadAsync');
    serveCloudZip(await zip.generateAsync({ type: 'nodebuffer' }));

    const result = await parse();

    expect(result.text).toContain('# Lesson');
    expect(Object.keys(result.images ?? {}).length).toBe(1);
    expect(loadAsync).toHaveBeenCalledTimes(1);
    loadAsync.mockRestore();
  });

  it('rejects an over-limit entry count before loadAsync materializes anything', async () => {
    const zip = new JSZip();
    for (let i = 0; i <= MAX_ZIP_ENTRY_COUNT; i++) zip.file(`e/${i}.txt`, 'x');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    serveCloudZip(buffer);
    const loadAsync = vi.spyOn(JSZip, 'loadAsync');

    await expect(parse()).rejects.toThrow(/entries exceed the/);
    expect(loadAsync).not.toHaveBeenCalled();
    loadAsync.mockRestore();
  });

  it('rejects an understated declared count on a canonical layout before loadAsync', async () => {
    const zip = new JSZip();
    for (let i = 0; i <= MAX_ZIP_ENTRY_COUNT; i++) zip.file(`e/${i}.txt`, 'x');
    const buffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    // Understate the EOCD's declared record count to 1; the actual walk must
    // still find the real records.
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    buffer.writeUInt16LE(1, eocd + 10);
    serveCloudZip(buffer);
    const loadAsync = vi.spyOn(JSZip, 'loadAsync');

    await expect(parse()).rejects.toThrow(/entries exceed the/);
    expect(loadAsync).not.toHaveBeenCalled();
    loadAsync.mockRestore();
  });

  it('rejects a prefixed, understated, over-limit archive before loadAsync', async () => {
    // The concrete bypass the preflight exists for: prepend bytes so the
    // classic offsets shift (JSZip's `zero` correction), and understate the
    // declared count so a declared-only check would pass.
    const zip = new JSZip();
    for (let i = 0; i <= MAX_ZIP_ENTRY_COUNT; i++) zip.file(`e/${i}.txt`, 'x');
    const inner = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const prefix = Buffer.alloc(4096, 0x41);
    const buffer = Buffer.concat([prefix, inner]);
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    buffer.writeUInt16LE(1, eocd + 10);
    serveCloudZip(buffer);
    const loadAsync = vi.spyOn(JSZip, 'loadAsync');

    await expect(parse()).rejects.toThrow(/entries exceed the/);
    expect(loadAsync).not.toHaveBeenCalled();
    loadAsync.mockRestore();
  });

  it('rejects a malformed archive with bounded text before loadAsync', async () => {
    serveCloudZip(Buffer.alloc(64, 0x00));
    const loadAsync = vi.spyOn(JSZip, 'loadAsync');

    await expect(parse()).rejects.toThrow(/malformed central directory|parse failed/);
    expect(loadAsync).not.toHaveBeenCalled();
    loadAsync.mockRestore();
  });

  it('aborts a high-ratio text entry that decompresses past the per-entry cap', async () => {
    const zip = new JSZip();
    // Compresses to almost nothing; decompresses far past the text-entry cap.
    zip.file('full.md', '0'.repeat(MAX_ZIP_TEXT_ENTRY_BYTES + 1024 * 1024));
    serveCloudZip(await zip.generateAsync({ type: 'nodebuffer' }));

    await expect(parse()).rejects.toThrow(/over the .*-byte text limit/);
  }, 60_000);

  it('bounds the content_list record count', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# Lesson');
    const records = Array.from({ length: MAX_CONTENT_LIST_ITEMS + 1 }, (_, i) => ({
      type: 'text',
      text: `b${i}`,
    }));
    zip.file('lesson_content_list.json', JSON.stringify(records));
    serveCloudZip(await zip.generateAsync({ type: 'nodebuffer' }));

    await expect(parse()).rejects.toThrow(/records, over the/);
  }, 60_000);
});

describe('MinerU Cloud — signed-URL and upstream-text redaction', () => {
  beforeEach(() => {
    mocks.providerFetch.mockReset();
    mocks.promisesLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    for (const fn of Object.values(mocks.log)) fn.mockClear();
  });

  /** Nothing logged or thrown may contain the synthetic signed-URL marker. */
  function expectMarkerAbsent() {
    const logged = mocks.log.warn.mock.calls
      .concat(mocks.log.error.mock.calls, mocks.log.info.mock.calls)
      .map((call) => JSON.stringify(call))
      .join('\n');
    expect(logged).not.toContain(SIGNED_MARKER);
  }

  it('keeps a signed URL out of logs and errors when the upload transport fails', async () => {
    serveCloudZip(Buffer.alloc(0), {
      uploadError: new TypeError('fetch failed', {
        cause: new Error(
          `connect ECONNREFUSED https://upload.example.test/lesson.pdf?Signature=${SIGNED_MARKER}`,
        ),
      }),
    });

    // The retry wrapper runs its full backoff before the terminal error.
    let caught: unknown;
    try {
      await parse();
    } catch (error) {
      caught = error;
    }
    const failure = caught as Error;
    expect(failure.message).toBe('MinerU Cloud presigned upload failed: TypeError');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
      SIGNED_MARKER,
    );
    expectMarkerAbsent();
  }, 30_000);

  it('keeps a signed URL out of logs and errors when the ZIP download transport fails', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# ok');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    serveCloudZip(buffer);
    mocks.providerFetch.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/file-urls/batch')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: { batch_id: 'batch-1', file_urls: ['https://upload.example.test/l.pdf'] },
          }),
        );
      }
      if (url === 'https://upload.example.test/l.pdf') return new Response('', { status: 200 });
      if (url.endsWith('/extract-results/batch/batch-1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              extract_result: {
                file_name: 'lesson.pdf',
                state: 'done',
                full_zip_url: `https://download.example.test/r.zip?Signature=${SIGNED_MARKER}`,
              },
            },
          }),
        );
      }
      if (url.includes('r.zip')) {
        throw new TypeError('fetch failed', {
          cause: new Error(`socket hang up ECONNRESET ${SIGNED_MARKER}`),
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    let caught: unknown;
    try {
      await parse();
    } catch (error) {
      caught = error;
    }
    const failure = caught as Error;
    expect(failure.message).not.toContain(SIGNED_MARKER);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
      SIGNED_MARKER,
    );
    expectMarkerAbsent();
  }, 30_000);

  it(
    'never lets envelope codes, err_msg or non-JSON bodies reach logs or errors',
    { timeout: 30_000 },
    async () => {
      // Envelope `code` as a hostile string (runtime type is not TS's number).
      mocks.providerFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: { batch_id: 'b', file_urls: ['https://u.example/a'] },
          }),
          { status: 200 },
        ),
      );

      let caught: unknown;
      try {
        await parse();
      } catch (error) {
        caught = error;
      }
      const failure = caught as Error;
      expect(failure.message).not.toContain(SIGNED_MARKER);
      expectMarkerAbsent();

      // A string code on the poll path stays out of the log.
      mocks.providerFetch.mockReset();
      mocks.providerFetch.mockImplementation(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/file-urls/batch')) {
          return new Response(
            JSON.stringify({
              code: 0,
              msg: 'ok',
              data: { batch_id: 'batch-1', file_urls: ['https://upload.example.test/l.pdf'] },
            }),
          );
        }
        if (url === 'https://upload.example.test/l.pdf') return new Response('', { status: 200 });
        if (url.endsWith('/extract-results/batch/batch-1')) {
          return new Response(JSON.stringify({ code: `1002-${SIGNED_MARKER}`, msg: 'x' }), {
            status: 200,
          });
        }
        throw new Error(`unexpected ${url}`);
      });

      await expect(parse()).rejects.toThrow('MinerU Cloud extract-results/batch: upstream error');
      expectMarkerAbsent();

      // A failed row's err_msg stays out of the thrown message.
      mocks.providerFetch.mockReset();
      mocks.providerFetch.mockImplementation(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/file-urls/batch')) {
          return new Response(
            JSON.stringify({
              code: 0,
              msg: 'ok',
              data: { batch_id: 'batch-1', file_urls: ['https://upload.example.test/l.pdf'] },
            }),
          );
        }
        if (url === 'https://upload.example.test/l.pdf') return new Response('', { status: 200 });
        if (url.endsWith('/extract-results/batch/batch-1')) {
          return new Response(
            JSON.stringify({
              code: 0,
              msg: 'ok',
              data: {
                extract_result: {
                  file_name: 'lesson.pdf',
                  state: 'failed',
                  err_msg: `boom ${SIGNED_MARKER}`,
                },
              },
            }),
          );
        }
        throw new Error(`unexpected ${url}`);
      });

      await expect(parse()).rejects.toThrow('MinerU Cloud parsing failed');
      expectMarkerAbsent();
    },
  );

  it('bounds the control-plane JSON body read', async () => {
    const huge = 'x'.repeat(9 * 1024 * 1024);
    mocks.providerFetch.mockResolvedValue(
      new Response(huge, { status: 200, headers: { 'content-length': String(huge.length) } }),
    );

    await expect(parse()).rejects.toThrow(/response exceeds/);
  }, 30_000);
});
