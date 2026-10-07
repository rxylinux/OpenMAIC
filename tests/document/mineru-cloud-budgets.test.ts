/**
 * MinerU Cloud decompression budget boundaries, driven at small limits
 * through the isolated internal test seam (`overrideMinerUCloudLimitsForTests`).
 *
 * Real DEFLATE archives, real JSZip streaming: an entry that expands past the
 * per-entry cap is stopped mid-stream (the counted bytes stay far below the
 * decompressed total), and entries past the cumulative budget are refused as
 * the running total crosses it. The shipped constants are untouched.
 */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providerFetch: vi.fn(),
  promisesLookup: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/server/provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-fetch')>();
  return { ...actual, providerFetch: mocks.providerFetch };
});

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn(),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.log }));

import { overrideMinerUCloudLimitsForTests, parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';

/** Serve a specific Response object as the result ZIP download. */
function serveZipResponse(zipResponse: Response) {
  mocks.providerFetch.mockImplementation(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/file-urls/batch')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { batch_id: 'b1', file_urls: ['https://upload.example.test/l.pdf'] },
        }),
      );
    }
    if (url === 'https://upload.example.test/l.pdf') return new Response('', { status: 200 });
    if (url.endsWith('/extract-results/batch/b1')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            extract_result: {
              file_name: 'lesson.pdf',
              state: 'done',
              full_zip_url: 'https://download.example.test/r.zip',
            },
          },
        }),
      );
    }
    if (url === 'https://download.example.test/r.zip') return zipResponse;
    throw new Error(`unexpected ${url}`);
  });
}

function serveZip(zipBuffer: Buffer) {
  mocks.providerFetch.mockImplementation(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/file-urls/batch')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { batch_id: 'b1', file_urls: ['https://upload.example.test/l.pdf'] },
        }),
      );
    }
    if (url === 'https://upload.example.test/l.pdf') return new Response('', { status: 200 });
    if (url.endsWith('/extract-results/batch/b1')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            extract_result: {
              file_name: 'lesson.pdf',
              state: 'done',
              full_zip_url: 'https://download.example.test/r.zip',
            },
          },
        }),
      );
    }
    if (url === 'https://download.example.test/r.zip') {
      return new Response(new Uint8Array(zipBuffer), {
        status: 200,
        headers: { 'content-length': String(zipBuffer.byteLength) },
      });
    }
    throw new Error(`unexpected ${url}`);
  });
}

async function parse() {
  return parseWithMinerUCloud(
    { providerId: 'mineru-cloud', apiKey: 'k', baseUrl: 'https://api.example.test' },
    Buffer.from('%PDF-1.7'),
    'lesson.pdf',
  );
}

/** Rewrite every central-header uncompressedSize field to `value`. */
function understateCentralUncompressedSizes(buffer: Buffer, value: number): Buffer {
  const out = Buffer.from(buffer);
  const CENTRAL = 0x02014b50;
  for (let i = 0; i + 46 <= out.length; i++) {
    if (out.readUInt32LE(i) !== CENTRAL) continue;
    out.writeUInt32LE(value, i + 20); // uncompressed size field
    const nameLen = out.readUInt16LE(i + 28);
    const extraLen = out.readUInt16LE(i + 30);
    const commentLen = out.readUInt16LE(i + 32);
    i += 45 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('MinerU Cloud decompression budgets (small-limit seam)', () => {
  beforeEach(() => {
    mocks.providerFetch.mockReset();
    mocks.promisesLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    for (const fn of Object.values(mocks.log)) fn.mockClear();
    overrideMinerUCloudLimitsForTests(undefined);
  });

  afterEach(() => {
    overrideMinerUCloudLimitsForTests(undefined);
  });

  it('stops a DEFLATE text entry mid-stream when it crosses the per-entry cap', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_ZIP_TEXT_ENTRY_BYTES: 8 * 1024 });
    // 512 KiB of incompressible-but-deflatable text: far past the 8 KiB cap.
    const text = 'line-of-text\n'.repeat(40_000);
    expect(text.length).toBeGreaterThan(64 * 1024);
    const zip = new JSZip();
    zip.file('full.md', text);
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    expect(buffer.byteLength).toBeLessThan(text.length); // really compressed
    serveZip(buffer);

    let caught: unknown;
    try {
      await parse();
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toMatch(/extracted (\d+) bytes, over the 8192-byte text limit/);
    // Stream-stop evidence: the counted bytes stayed far below the full
    // decompressed size — the abort happened during extraction, not after it.
    const counted = Number(message.match(/extracted (\d+) bytes/)?.[1]);
    expect(counted).toBeGreaterThanOrEqual(8 * 1024);
    expect(counted).toBeLessThan(text.length / 2);
  }, 60_000);

  it('refuses an honest archive whose declared total crosses the budget before load', async () => {
    overrideMinerUCloudLimitsForTests({
      MAX_ZIP_TEXT_ENTRY_BYTES: 256 * 1024,
      MAX_ZIP_IMAGE_ENTRY_BYTES: 256 * 1024,
      MAX_ZIP_UNCOMPRESSED_BYTES: 100 * 1024,
    });
    // Two ~64 KiB entries: the declared (honest) total crosses 100 KiB.
    const chunk = 'x'.repeat(64 * 1024);
    const zip = new JSZip();
    zip.file('full.md', chunk);
    zip.file(
      'images/a.png',
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(chunk)]),
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    serveZip(buffer);

    // The declared total is checked before any entry is decompressed; the
    // directory itself is already bounded by the preflight entry count.
    await expect(parse()).rejects.toThrow(
      /declared uncompressed size exceeds the 102400-byte limit/,
    );
  }, 60_000);

  it('executes the streamed cumulative branch when content_list re-reads one image', async () => {
    overrideMinerUCloudLimitsForTests({
      MAX_ZIP_TEXT_ENTRY_BYTES: 256 * 1024,
      MAX_ZIP_IMAGE_ENTRY_BYTES: 256 * 1024,
      MAX_ZIP_UNCOMPRESSED_BYTES: 100 * 1024,
    });
    // One honest image entry (~64 KiB) and an honest markdown: the declared
    // UNIQUE directory total (~128 KiB) stays under every declared budget, so
    // only the ACTUAL streamed accumulation — the same entry read once per
    // content_list record — can cross the cumulative budget.
    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64 * 1024, 7),
    ]);
    const zip = new JSZip();
    zip.file('full.md', '# Lesson ![i](images/only.png)');
    zip.file('images/only.png', imageBytes);
    // Two records reference the SAME image: readImage runs per record.
    zip.file(
      'lesson_content_list.json',
      JSON.stringify([
        { type: 'image', img_path: 'images/only.png' },
        { type: 'image', img_path: 'images/only.png' },
      ]),
    );
    serveZip(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

    await expect(parse()).rejects.toThrow(/extracted content exceeds the 102400-byte limit/);
  }, 60_000);

  it('enforces the streamed JSON cap when Content-Length is absent', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_JSON_BYTES: 1024 });
    // No content-length header: only the chunk-by-chunk stream cap can refuse.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048).fill(0x78));
        controller.close();
      },
    });
    mocks.providerFetch.mockResolvedValue(new Response(stream, { status: 200 }));

    await expect(parse()).rejects.toThrow(/response exceeds 1024 bytes/);
  });

  it('enforces the streamed JSON cap when Content-Length lies low', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_JSON_BYTES: 1024 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048).fill(0x78));
        controller.close();
      },
    });
    mocks.providerFetch.mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-length': '10' } }),
    );

    await expect(parse()).rejects.toThrow(/response exceeds 1024 bytes/);
  });

  it('cancels the response body when the streamed cap refuses', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_JSON_BYTES: 1024 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    });
    mocks.providerFetch.mockResolvedValue(new Response(stream, { status: 200 }));

    await expect(parse()).rejects.toThrow(/response exceeds 1024 bytes/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it('fails safe (bounded error) when declared sizes understate the real payload', async () => {
    overrideMinerUCloudLimitsForTests({
      MAX_ZIP_TEXT_ENTRY_BYTES: 256 * 1024,
      MAX_ZIP_IMAGE_ENTRY_BYTES: 256 * 1024,
      MAX_ZIP_UNCOMPRESSED_BYTES: 100 * 1024,
    });
    const chunk = 'x'.repeat(64 * 1024);
    const zip = new JSZip();
    zip.file('full.md', chunk);
    zip.file(
      'images/a.png',
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(chunk)]),
    );
    let buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    // Understate every central-directory uncompressedSize to 1 KiB: the cheap
    // declared pre-check passes, and the lying metadata makes the library's
    // own inflate framing fail — a bounded refusal, never a runaway expansion
    // past the streamed caps.
    buffer = understateCentralUncompressedSizes(buffer, 1024);
    serveZip(buffer);

    await expect(parse()).rejects.toThrow(/ZIP parse failed/);
  }, 60_000);

  it('rejects an archive whose compressed size passes the download cap before parsing', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_ZIP_BYTES: 64 });
    const zip = new JSZip();
    zip.file('full.md', '# ok');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    expect(buffer.byteLength).toBeGreaterThan(64);
    serveZip(buffer);

    await expect(parse()).rejects.toThrow(/ZIP download: response exceeds 64 bytes/);
  });

  it('enforces the ZIP download stream cap when Content-Length is absent', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_ZIP_BYTES: 2048 });
    const zip = new JSZip();
    zip.file('full.md', '# ok');
    zip.file('pad.bin', Buffer.alloc(4096, 1)); // stored: body alone exceeds the cap
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    expect(buffer.byteLength).toBeGreaterThan(2048);
    // Serve the archive with NO content-length: only the chunk-by-chunk
    // stream cap can refuse.
    serveZipResponse(new Response(new Uint8Array(buffer), { status: 200, headers: {} }));
    await expect(parse()).rejects.toThrow(/ZIP download: response exceeds 2048 bytes/);
  });

  it('enforces the ZIP download stream cap when Content-Length lies low', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_ZIP_BYTES: 2048 });
    const zip = new JSZip();
    zip.file('full.md', '# ok');
    zip.file('pad.bin', Buffer.alloc(4096, 1));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    serveZipResponse(
      new Response(new Uint8Array(buffer), {
        status: 200,
        headers: { 'content-length': '10' },
      }),
    );
    await expect(parse()).rejects.toThrow(/ZIP download: response exceeds 2048 bytes/);
  });

  it('cancels the ZIP download body when the streamed cap refuses', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_ZIP_BYTES: 2048 });
    let cancelled = false;
    const zip = new JSZip();
    zip.file('full.md', '# ok');
    zip.file('pad.bin', Buffer.alloc(4096, 1));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
      },
      cancel() {
        cancelled = true;
      },
    });
    serveZipResponse(new Response(stream, { status: 200, headers: {} }));
    await expect(parse()).rejects.toThrow(/ZIP download: response exceeds 2048 bytes/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it('stops a DEFLATE entry with an understated declared size at the small per-entry cap', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_ZIP_TEXT_ENTRY_BYTES: 8 * 1024 });
    const text = 'line-of-text\n'.repeat(40_000);
    const zip = new JSZip();
    zip.file('full.md', text);
    let buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    // Understate the declared uncompressed size: the STREAMED per-entry
    // counter must stop the entry at the small cap, not any declared check.
    buffer = understateCentralUncompressedSizes(buffer, 1024);
    serveZip(buffer);

    let caught: unknown;
    try {
      await parse();
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toMatch(/extracted (\d+) bytes, over the 8192-byte text limit/);
    const counted = Number(message.match(/extracted (\d+) bytes/)?.[1]);
    expect(counted).toBeLessThan(text.length / 2);
  }, 60_000);

  it('bounds the control-plane JSON read at the small cap', async () => {
    overrideMinerUCloudLimitsForTests({ MAX_JSON_BYTES: 1024 });
    const huge = 'x'.repeat(2048);
    mocks.providerFetch.mockResolvedValue(
      new Response(huge, { status: 200, headers: { 'content-length': String(huge.length) } }),
    );

    await expect(parse()).rejects.toThrow(/response exceeds 1024 bytes/);
  });

  it('still parses a legitimate small archive under the small caps', async () => {
    overrideMinerUCloudLimitsForTests({
      MAX_ZIP_TEXT_ENTRY_BYTES: 64 * 1024,
      MAX_ZIP_UNCOMPRESSED_BYTES: 128 * 1024,
    });
    const zip = new JSZip();
    zip.file('full.md', '# Small lesson');
    serveZip(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

    const result = await parse();
    expect(result.text).toContain('# Small lesson');
  });
});
