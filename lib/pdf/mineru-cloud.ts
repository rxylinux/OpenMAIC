/**
 * MinerU Cloud API (v4) — https://mineru.net/api/v4
 *
 * Flow: POST /file-urls/batch → PUT presigned URL → poll /extract-results/batch/{id} → download ZIP
 * ZIP contains: full.md + images/ + content_list.json
 */

import JSZip from 'jszip';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { extractMinerUResult } from './mineru-parser';
import { MINERU_CLOUD_DEFAULT_BASE } from './constants';
import {
  getExtensionsForMimes,
  getExtensionsForProviders,
  MINERU_IMAGE_MIMES,
} from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import {
  isRejectedRedirectError,
  providerFetch,
  resolveAllowLocalNetworks,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';
import { safeErrorCode } from '@/lib/utils/safe-error-code';
import {
  findUnsafeNetworkTargetError,
  UnsafeNetworkTargetError,
  validateUrlForSSRFWithPolicy,
} from '@/lib/server/ssrf-guard';

const log = createLogger('MinerUCloud');

const TIMEOUTS = {
  batch: 60_000,
  upload: 180_000,
  poll: 30_000,
  zip: 180_000,
} as const;

// Hard cap on the result ZIP read. The largest accepted input is bounded by
// MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES (50 MiB); a parsed result bundles the
// markdown, content list and extracted images, so the cap is set comfortably
// above the widest legitimate result while still bounding the download.
export const MAX_ZIP_BYTES = 256 * 1024 * 1024; // 256 MiB
// JSON control-plane responses (batch creation / poll) only carry envelope
// fields, so a small cap is enough and a runaway body cannot be buffered.
export const MAX_JSON_BYTES = 8 * 1024 * 1024; // 8 MiB
// Decompressed-result limits. The compressed archive is already capped by
// limits.MAX_ZIP_BYTES, but a small archive can still expand to a far larger payload,
// so the entry count, the declared uncompressed total and the actual bytes read
// while extracting are each bounded. Text entries are the markdown and content
// list; every other extracted entry is treated as an image.
export const MAX_ZIP_ENTRY_COUNT = 10_000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MiB
export const MAX_ZIP_TEXT_ENTRY_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_ZIP_IMAGE_ENTRY_BYTES = 32 * 1024 * 1024; // 32 MiB
// The content_list.json control file carries one record per extracted block;
// the JSON read is already byte-capped, and this bounds the record count so a
// dense list cannot fan out into unbounded downstream work per record.
export const MAX_CONTENT_LIST_ITEMS = 50_000;

/**
 * The active limit values. Production reads these through {@link limits} so a
 * test can shrink them (via {@link overrideMinerUCloudLimitsForTests}) and
 * exercise the boundary conditions without weakening the shipped constants.
 */
const limits = {
  MAX_ZIP_BYTES,
  MAX_JSON_BYTES,
  MAX_ZIP_ENTRY_COUNT,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  MAX_ZIP_TEXT_ENTRY_BYTES,
  MAX_ZIP_IMAGE_ENTRY_BYTES,
  MAX_CONTENT_LIST_ITEMS,
};

/** Test-only: shrink the active limits; `undefined` entries restore defaults. */
export function overrideMinerUCloudLimitsForTests(
  overrides: Partial<typeof limits> | undefined,
): void {
  Object.assign(limits, {
    MAX_ZIP_BYTES,
    MAX_JSON_BYTES,
    MAX_ZIP_ENTRY_COUNT,
    MAX_ZIP_UNCOMPRESSED_BYTES,
    MAX_ZIP_TEXT_ENTRY_BYTES,
    MAX_ZIP_IMAGE_ENTRY_BYTES,
    MAX_CONTENT_LIST_ITEMS,
    ...overrides,
  });
}

const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_MS = 15 * 60 * 1_000; // 15 minutes

// Extension → MIME for image types MinerU can emit inside its result zip.
// Derived from MINERU_IMAGE_MIMES so this table can't drift from the accept
// list; used only to build `data:MIME;base64,…` URLs for embedded images.
const MIME_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const mime of MINERU_IMAGE_MIMES) {
    for (const ext of getExtensionsForMimes([mime])) {
      map[ext] = mime;
    }
  }
  return map;
})();

// Match every image extension MinerU may include as an asset in the result
// zip. Kept in lockstep with MIME_MAP by deriving from the same source.
const IMAGE_EXTENSION_RE = new RegExp(`\\.(${Object.keys(MIME_MAP).join('|')})$`, 'i');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function extToMime(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

function isRetryable(err: unknown): boolean {
  // An address-policy refusal is a deterministic decision about the target, not
  // a transient transport failure: retrying the same URL cannot change it.
  if (findUnsafeNetworkTargetError(err)) return false;
  // A refused redirect is likewise deterministic: the target answered 3xx and
  // the request was configured to reject that, so a retry re-issues the same
  // rejected request. Undici reports it as `TypeError: fetch failed` with an
  // `Error('unexpected redirect')` cause, which must not look retryable.
  if (isRejectedRedirectError(err)) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return ['fetch failed', 'econnreset', 'etimedout', 'timeout', 'aborted'].some((s) =>
    msg.includes(s),
  );
}

/**
 * Whether `err` is one of this module's own bounded errors (JSON envelope,
 * size-limit, ZIP-structure failures): instances of the internal typed class
 * whose messages are fixed text this module authored, so they can be logged
 * and rethrown verbatim. A message prefix is not trust: upstream text can
 * start with the same words.
 */
function isOwnBoundedError(err: unknown): err is MinerUBoundedError {
  return err instanceof MinerUBoundedError;
}

async function fetchWithRetry<T>(fn: () => Promise<T>, context: string, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts) break;
      // Never log the raw error for a transport failure: its message (or a
      // `cause`) can embed the signed upload/archive URL. Fixed bounded
      // context/code only.
      log.warn(
        `[MinerU Cloud] ${context} — retry ${i}/${attempts}: ${
          isOwnBoundedError(err) ? err.message : safeErrorCode(err)
        }`,
      );
      await sleep(400 * i);
    }
  }
  // Preserve an address-policy refusal as its original typed error so callers
  // can map it to a 403 instead of an opaque transport failure (its message is
  // the guard's fixed text). This module's own bounded errors keep their
  // message. A transport-level failure gets a fixed context plus the error's
  // code/class only — never its message or cause, which can carry the signed
  // URL of the returned upload or archive target.
  const blocked = findUnsafeNetworkTargetError(lastErr);
  if (blocked) throw blocked;
  if (isOwnBoundedError(lastErr)) throw lastErr;
  throw new Error(`MinerU Cloud ${context} failed: ${safeErrorCode(lastErr)}`);
}

// ── API envelope ──────────────────────────────────────────────────────────────

interface MinerUEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

// ── Bounded response reads ────────────────────────────────────────────────────

/**
 * Read a response body into a Buffer, refusing to buffer more than `maxBytes`.
 * A declared `content-length` over the cap is rejected before the body is
 * touched; the streamed path enforces the same cap chunk by chunk so a body
 * without a length (or with a lying one) still cannot exhaust memory.
 */
async function readBoundedBody(res: Response, maxBytes: number, context: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new MinerUBoundedError(`MinerU Cloud ${context}: response exceeds ${maxBytes} bytes`);
  }
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new MinerUBoundedError(`MinerU Cloud ${context}: response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * An error this module authored: its message is fixed text written here, so it
 * can be logged and rethrown verbatim. Anything else — including envelope
 * fields echoed by the service — must be classified with `safeErrorCode`
 * instead, because upstream text can embed a provider-returned signed URL.
 */
class MinerUBoundedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinerUBoundedError';
  }
}

async function readMinerUJson<T>(res: Response, context: string): Promise<T> {
  const text = (await readBoundedBody(res, limits.MAX_JSON_BYTES, context)).toString('utf8');
  let json: MinerUEnvelope<T>;
  try {
    json = JSON.parse(text) as MinerUEnvelope<T>;
  } catch {
    // Neither the log nor the error quotes the body: upstream text can embed
    // credentials or signed URLs, so only its (bounded) length is recorded.
    log.warn(`[MinerU Cloud] ${context}: non-JSON body (HTTP ${res.status}, ${text.length} bytes)`);
    throw new MinerUBoundedError(
      `MinerU Cloud ${context}: invalid JSON response (HTTP ${res.status})`,
    );
  }
  if (!res.ok) {
    // The service's `msg` and envelope `code` are upstream text and stay out
    // of caller-facing errors (the parse routes relay them); the code is only
    // logged after runtime validation as a bounded integer.
    log.warn(`[MinerU Cloud] ${context}: HTTP ${res.status} (code ${boundedCode(json.code)})`);
    throw new MinerUBoundedError(`MinerU Cloud ${context}: HTTP ${res.status}`);
  }
  if (json.code !== 0) {
    log.warn(`[MinerU Cloud] ${context}: code ${boundedCode(json.code)}`);
    throw new MinerUBoundedError(`MinerU Cloud ${context}: upstream error`);
  }
  return json.data;
}

/**
 * The envelope `code` as a bounded integer token for the log, or a fixed
 * fallback. TypeScript's `number` is not a runtime guarantee: a hostile
 * envelope can carry any string (including a signed-URL marker), so the raw
 * value is never interpolated.
 */
function boundedCode(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1e12) {
    return String(value);
  }
  return 'n/a';
}

// ── Response-URL policy ───────────────────────────────────────────────────────

/**
 * Response-supplied MinerU URLs (the presigned upload URL and the result ZIP
 * URL) must be public HTTPS endpoints in every legitimate flow, whatever the
 * origin policy for the configured API root is. This checks the scheme and runs
 * the URL through the strict public address policy before any request; the
 * strict transport then re-validates redirect hops and pins connect-time DNS.
 *
 * Failures are thrown as {@link UnsafeNetworkTargetError} so the retry wrapper
 * treats them as terminal rather than a transient transport error.
 */
async function assertPublicHttpsResponseUrl(rawUrl: string, context: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`MinerU Cloud ${context}: provider response contained an invalid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`MinerU Cloud ${context}: provider response URL must use https`);
  }
  const ssrfError = await validateUrlForSSRFWithPolicy(parsed.href, { allowLocalNetworks: false });
  if (ssrfError) throw new UnsafeNetworkTargetError(ssrfError);
}

// ── Filename sanitization ─────────────────────────────────────────────────────

const MINERU_CLOUD_SUPPORTED_EXTENSIONS = new Set(getExtensionsForProviders(['mineru-cloud']));

function sanitizeFileName(name: string | undefined): string {
  const fallback = 'document.pdf';
  const raw = (name ?? fallback).split(/[/\\]/).pop()?.trim() ?? fallback;
  const trimmed = raw.slice(0, 240);
  if (trimmed.includes('..')) return fallback;
  const extension = trimmed.split('.').pop()?.toLowerCase();
  if (!extension || !MINERU_CLOUD_SUPPORTED_EXTENSIONS.has(extension)) return fallback;
  return trimmed || fallback;
}

// ── ZIP parsing ───────────────────────────────────────────────────────────────

interface BatchExtractRow {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
}

/**
 * JSZip 3.10 exposes `internalStream` at runtime but omits it from its bundled
 * type declarations, which only surface `async`/`nodeStream`. This is the
 * narrow slice of the stream-helper API the streaming reader relies on.
 */
interface StreamingZipEntry extends JSZip.JSZipObject {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}

/**
 * Declared uncompressed size for a loaded JSZip entry. JSZip exposes it only on
 * the internal `_data` object (`CompressedObject.uncompressedSize`), so it is
 * read defensively and treated as a hint only: a declared size can understate
 * the real payload, which is why the extracted length is checked too.
 */
function declaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as { _data?: { uncompressedSize?: unknown } })._data;
  const size = data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : null;
}

// ── Pre-materialization central-directory preflight ───────────────────────────
//
// `JSZip.loadAsync` constructs a ZipObject for every central-directory record
// before any caller-side limit runs, so a 256 MiB archive of millions of tiny
// entries would exhaust memory inside the library. The preflight below reads
// the archive's own directory — the classic EOCD, the ZIP64 EOCD when the
// classic fields are saturated, and then the actual central-directory records
// — and rejects an over-limit or malformed directory before `loadAsync` is
// ever called. Declared counts can understate, so the actual walked count
// wins when it is larger.

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_MAX_COMMENT_PLUS_EOCD = 65_535 + ZIP_EOCD_MIN_LENGTH;

/** Read a ZIP64 8-byte little-endian field as a finite number. */
function readZip64Uint64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(value);
}

/**
 * The number of central-directory records the archive would hand to
 * `JSZip.loadAsync`, counted the way the library itself counts. JSZip's reader
 * carries a `zero` correction for prepended data (`eocd − (offset + size)`,
 * always applied when positive), starts its walk
 * at `zero + centralDirOffset`, follows central-file-header signatures without
 * consulting the declared record count, and tolerates understated EOCD counts.
 * The preflight mirrors every one of those rules so a prefixed or understated
 * directory cannot bypass the limit, and it stops walking the moment the count
 * passes the limit so a multi-million-entry archive is never fully scanned.
 * Throws on a malformed or ambiguous directory.
 */
function countZipEntries(buffer: Buffer): number {
  if (buffer.length < ZIP_EOCD_MIN_LENGTH) {
    throw new Error('archive is too small to contain a central directory');
  }
  let eocd = -1;
  const scanFloor = Math.max(0, buffer.length - ZIP_MAX_COMMENT_PLUS_EOCD);
  for (let i = buffer.length - ZIP_EOCD_MIN_LENGTH; i >= scanFloor; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('end-of-central-directory record not found');

  let declaredCount = buffer.readUInt16LE(eocd + 10);
  let directoryOffset = buffer.readUInt32LE(eocd + 16);
  let directorySize = buffer.readUInt32LE(eocd + 12);
  let zip64Trailer = 0;

  // ZIP64: the classic fields saturate at 0xFFFF / 0xFFFFFFFF and the real
  // values live in the ZIP64 EOCD, located by the record just before the EOCD.
  if (declaredCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new Error('saturated classic fields without a ZIP64 locator');
    }
    const zip64Eocd = readZip64Uint64(buffer, locator + 8);
    if (!Number.isSafeInteger(zip64Eocd) || zip64Eocd + 56 > buffer.length) {
      throw new Error('ZIP64 end-of-central-directory record is outside the archive');
    }
    if (buffer.readUInt32LE(zip64Eocd) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error('ZIP64 locator does not point at a ZIP64 EOCD record');
    }
    const zip64RecordSize = readZip64Uint64(buffer, zip64Eocd + 4);
    if (!Number.isSafeInteger(zip64RecordSize)) {
      throw new Error('ZIP64 EOCD declares an unreadable record size');
    }
    declaredCount = readZip64Uint64(buffer, zip64Eocd + 32);
    directorySize = readZip64Uint64(buffer, zip64Eocd + 40);
    directoryOffset = readZip64Uint64(buffer, zip64Eocd + 48);
    // JSZip adds the locator (20 bytes) and the ZIP64 record itself to the
    // expected span before the classic EOCD when computing its correction.
    zip64Trailer = 20 + 12 + zip64RecordSize;
  }

  for (const value of [directoryOffset, directorySize]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('central-directory offset or size is unreadable');
    }
  }

  // JSZip's prepend correction: bytes that sit between the directory the EOCD
  // describes and the EOCD itself. A negative value is a truncated archive;
  // a positive one is prepended data, and the installed library always shifts
  // its reader's zero by it — its isSignature check runs at the EOCD position,
  // which by construction holds the EOCD signature, never a central file
  // header, so the unshifted branch is unreachable for any archive whose EOCD
  // was located by its signature.
  const expectedSpan = directoryOffset + directorySize + zip64Trailer;
  const extraBytes = eocd - expectedSpan;
  if (extraBytes < 0) throw new Error('central directory extends past the EOCD');
  const directoryStart = extraBytes + directoryOffset;
  if (directoryStart > buffer.length) {
    throw new Error('central-directory start is outside the archive');
  }

  // Walk the actual records exactly as JSZip does — signature-driven, not
  // bounded by the declared size — but leave the moment the limit is passed so
  // a hostile multi-million-entry archive is never scanned in full.
  let walked = 0;
  let position = directoryStart;
  while (
    position + 46 <= buffer.length &&
    buffer.readUInt32LE(position) === ZIP_CENTRAL_HEADER_SIGNATURE
  ) {
    walked += 1;
    if (walked > limits.MAX_ZIP_ENTRY_COUNT) return walked;
    position +=
      46 +
      buffer.readUInt16LE(position + 28) +
      buffer.readUInt16LE(position + 30) +
      buffer.readUInt16LE(position + 32);
  }

  if (walked === 0 && declaredCount > 0) {
    // JSZip treats this as corrupt ("expected records but found none"); the
    // layout is ambiguous under its correction rules, so refuse it here.
    throw new Error('declared records exist but no central header is reachable');
  }

  return Math.max(walked, declaredCount);
}

/**
 * Reject an archive whose central directory carries more entries than the
 * configured budget, before `JSZip.loadAsync` materializes them.
 */
function assertZipEntryPreflight(zipBuffer: Buffer): void {
  let count: number;
  try {
    count = countZipEntries(zipBuffer);
  } catch {
    // A malformed directory would make JSZip fail anyway; refuse it here with
    // bounded text instead of letting the library surface raw parse detail.
    throw new MinerUBoundedError('MinerU Cloud ZIP: malformed central directory');
  }
  if (count > limits.MAX_ZIP_ENTRY_COUNT) {
    throw new MinerUBoundedError(
      `MinerU Cloud ZIP: ${count} entries exceed the ${limits.MAX_ZIP_ENTRY_COUNT}-entry limit`,
    );
  }
}

/**
 * Reject a loaded archive when the total declared uncompressed size is beyond
 * the configured budget. The declared total is untrusted but cheap, and it
 * bounds an archive that honestly declares a very large payload; the streamed
 * readers enforce the real per-entry and cumulative caps while extracting.
 */
function assertZipEntryBudget(zip: JSZip): void {
  const paths = Object.keys(zip.files);
  if (paths.length > limits.MAX_ZIP_ENTRY_COUNT) {
    throw new Error(
      `MinerU Cloud ZIP: ${paths.length} entries exceed the ${limits.MAX_ZIP_ENTRY_COUNT}-entry limit`,
    );
  }
  let declaredTotal = 0;
  for (const path of paths) {
    const declared = declaredUncompressedSize(zip.files[path]!);
    if (declared === null) continue;
    declaredTotal += declared;
    if (declaredTotal > limits.MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new Error(
        `MinerU Cloud ZIP: declared uncompressed size exceeds the ${limits.MAX_ZIP_UNCOMPRESSED_BYTES}-byte limit`,
      );
    }
  }
}

async function parseMinerUZip(zipUrl: string): Promise<ParsedPdfContent> {
  await assertPublicHttpsResponseUrl(zipUrl, 'ZIP download');
  log.info('[MinerU Cloud] Downloading result ZIP...');

  const zipRes = await fetchWithRetry(
    () =>
      providerFetch(
        zipUrl,
        { signal: AbortSignal.timeout(TIMEOUTS.zip) },
        { allowLocalNetworks: false, requireHttps: true, rejectRedirects: true },
      ),
    'ZIP download',
  );
  if (!zipRes.ok) {
    await zipRes.body?.cancel().catch(() => undefined);
    throw new Error(`MinerU Cloud ZIP download failed (${zipRes.status})`);
  }

  const zipBuf = await readBoundedBody(zipRes, limits.MAX_ZIP_BYTES, 'ZIP download');
  // Reject an over-limit or malformed central directory before the library
  // materializes a ZipObject per record.
  assertZipEntryPreflight(zipBuf);
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch {
    // The library's raw parse detail stays out of caller-facing errors.
    throw new MinerUBoundedError('MinerU Cloud ZIP parse failed');
  }

  assertZipEntryBudget(zip);

  const filePaths = Object.keys(zip.files).filter((p) => !zip.files[p]!.dir);
  const fullMdPath = filePaths.find((p) => /(^|\/)full\.md$/i.test(p));
  const contentListPath = filePaths.find(
    (p) => p.endsWith('_content_list.json') || /(^|\/)content_list\.json$/i.test(p),
  );

  if (!fullMdPath) {
    throw new Error(
      `MinerU Cloud ZIP: full.md not found. Files: ${filePaths.slice(0, 10).join(', ')}`,
    );
  }

  // Actual decompressed bytes read so far. The declared sizes above are only a
  // cheap pre-check; an archive can understate them, so each entry is measured
  // and the running total is bounded while it is streamed out of the
  // decompressor — the cap is enforced before the full entry is buffered.
  let extractedBytes = 0;
  async function readEntry(entry: JSZip.JSZipObject, kind: 'text' | 'image'): Promise<Buffer> {
    const cap =
      kind === 'text' ? limits.MAX_ZIP_TEXT_ENTRY_BYTES : limits.MAX_ZIP_IMAGE_ENTRY_BYTES;
    const stream = (entry as StreamingZipEntry).internalStream('uint8array');
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      let done = false;
      stream
        .on('data', (chunk: Uint8Array) => {
          if (done) return;
          entryBytes += chunk.byteLength;
          if (entryBytes > cap) {
            done = true;
            stream.pause();
            reject(
              new Error(
                `MinerU Cloud ZIP: entry "${entry.name}" extracted ${entryBytes} bytes, over the ${cap}-byte ${kind} limit`,
              ),
            );
            return;
          }
          if (extractedBytes + entryBytes > limits.MAX_ZIP_UNCOMPRESSED_BYTES) {
            done = true;
            stream.pause();
            reject(
              new Error(
                `MinerU Cloud ZIP: extracted content exceeds the ${limits.MAX_ZIP_UNCOMPRESSED_BYTES}-byte limit`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        })
        .on('error', (err: Error) => {
          if (done) return;
          done = true;
          reject(err);
        })
        .on('end', () => {
          if (done) return;
          done = true;
          extractedBytes += entryBytes;
          resolve(Buffer.concat(chunks));
        })
        .resume();
    });
  }

  const mdContent = (await readEntry(zip.file(fullMdPath)!, 'text')).toString('utf8');
  const dirPrefix = fullMdPath.includes('/')
    ? fullMdPath.slice(0, fullMdPath.lastIndexOf('/') + 1)
    : '';

  // Parse content_list.json if present
  let contentList: unknown;
  if (contentListPath) {
    const raw = (await readEntry(zip.file(contentListPath)!, 'text')).toString('utf8');
    try {
      contentList = JSON.parse(raw);
    } catch {
      log.warn('[MinerU Cloud] content_list JSON parse failed, continuing with markdown only');
    }
    if (Array.isArray(contentList) && contentList.length > limits.MAX_CONTENT_LIST_ITEMS) {
      throw new Error(
        `MinerU Cloud ZIP: content_list carries ${contentList.length} records, over the ${limits.MAX_CONTENT_LIST_ITEMS}-record limit`,
      );
    }
  }

  // Helper to read an image from the ZIP by relative path
  async function readImage(relPath: string): Promise<string | null> {
    const normalized = relPath.replace(/^\.?\//, '');
    for (const candidate of [dirPrefix + normalized, normalized]) {
      const entry = zip.file(candidate);
      if (!entry) continue;
      const buf = await readEntry(entry, 'image');
      const ext = candidate.split('.').pop() ?? 'png';
      return `data:${extToMime(ext)};base64,${buf.toString('base64')}`;
    }
    return null;
  }

  // Extract images referenced in content_list
  const imageData: Record<string, string> = {};
  if (Array.isArray(contentList)) {
    for (const item of contentList as Array<Record<string, unknown>>) {
      if (item.type === 'image' && typeof item.img_path === 'string') {
        const base64 = await readImage(item.img_path);
        if (base64) {
          const basename = (item.img_path as string).split('/').pop() ?? item.img_path;
          imageData[basename as string] = base64;
        }
      }
    }
  }

  // Also scan for image files not in content_list (fallback)
  for (const p of filePaths) {
    if (IMAGE_EXTENSION_RE.test(p)) {
      const basename = p.split('/').pop() ?? p;
      if (!imageData[basename]) {
        const base64 = await readImage(p);
        if (base64) imageData[basename] = base64;
      }
    }
  }

  // Build a synthetic fileResult compatible with extractMinerUResult
  const parsed = extractMinerUResult({
    md_content: mdContent,
    images: imageData,
    content_list: contentList,
  });
  return {
    ...parsed,
    metadata: {
      ...(parsed.metadata ?? { pageCount: 0 }),
      parser: 'mineru-cloud',
    },
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Parse a document using the MinerU Cloud v4 API.
 *
 * @param config - Must have `apiKey` (required) and optionally `baseUrl` (defaults to mineru.net/api/v4)
 * @param documentBuffer - Raw document bytes
 * @param sourceFileName - Original filename for the upload
 */
export async function parseWithMinerUCloud(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  sourceFileName?: string,
): Promise<ParsedPdfContent> {
  const token = config.apiKey;
  if (!token) {
    throw new Error('MinerU Cloud API key is required');
  }

  const apiRoot = (config.baseUrl || MINERU_CLOUD_DEFAULT_BASE).replace(/\/+$/, '');
  const uploadFileName = sanitizeFileName(sourceFileName);

  // The API root policy follows endpoint provenance:
  //  - a server-managed root is operator configuration and may reach a local
  //    network without the opt-in; its redirect hops are still validated and
  //    pinned under the operator policy (the operator chose the root, not
  //    where it redirects);
  //  - a request-supplied root is arbitrary caller input: strict public policy
  //    and redirects refused outright;
  //  - the default catalog root (mineru.net) keeps the operator policy.
  // The response-supplied upload and ZIP URLs are always held to the strict
  // public policy regardless of the root's provenance.
  // An unmanaged provider with an explicit base URL is caller-supplied by
  // default: server-internal callers resolve server config only and mark
  // themselves managed, so this default cannot mislabel operator endpoints.
  const callerSuppliedRoot =
    config.callerSuppliedBaseUrl ?? (Boolean(config.baseUrl) && !config.managed);
  const firstHopPolicy: ProviderFetchPolicy = config.managed
    ? { allowLocalNetworks: true, redirectAllowLocalNetworks: resolveAllowLocalNetworks() }
    : callerSuppliedRoot
      ? { allowLocalNetworks: false, rejectRedirects: true }
      : { allowLocalNetworks: undefined };

  log.info(`[MinerU Cloud] Starting parse: ${uploadFileName} (${documentBuffer.byteLength} bytes)`);

  // Step 1: Create batch — request presigned upload URL
  const batchData = await fetchWithRetry(async () => {
    const res = await providerFetch(
      `${apiRoot}/file-urls/batch`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [{ name: uploadFileName }],
          enable_formula: true,
          enable_table: true,
          model_version: 'vlm',
          language: 'ch',
        }),
        signal: AbortSignal.timeout(TIMEOUTS.batch),
      },
      firstHopPolicy,
    );
    return readMinerUJson<{ batch_id: string; file_urls?: string[]; files?: string[] }>(
      res,
      'file-urls/batch',
    );
  }, 'create batch');

  const uploadUrls = batchData.file_urls ?? batchData.files;
  if (!batchData.batch_id || !uploadUrls?.length) {
    throw new Error('MinerU Cloud batch response missing batch_id or upload URLs');
  }

  log.info(`[MinerU Cloud] Batch ${batchData.batch_id} created, uploading document...`);

  // Step 2: Upload document to presigned URL
  await assertPublicHttpsResponseUrl(uploadUrls[0]!, 'presigned upload');
  const putRes = await fetchWithRetry(
    () =>
      providerFetch(
        uploadUrls[0]!,
        {
          method: 'PUT',
          body: new Blob([
            documentBuffer.buffer.slice(
              documentBuffer.byteOffset,
              documentBuffer.byteOffset + documentBuffer.byteLength,
            ) as ArrayBuffer,
          ]),
          signal: AbortSignal.timeout(TIMEOUTS.upload),
          // No Content-Type — presigned OSS URLs are sensitive to headers in the signature
        },
        // A presigned URL identifies one exact destination: a 3xx answer is a
        // hard failure and must never be followed.
        { allowLocalNetworks: false, rejectRedirects: true },
      ),
    'presigned upload',
    5,
  );
  if (!putRes.ok) {
    await putRes.body?.cancel().catch(() => undefined);
    throw new Error(`MinerU Cloud upload failed (${putRes.status})`);
  }

  // Give the backend a moment to register the upload
  await sleep(1_500);

  // Step 3: Poll for completion
  log.info(`[MinerU Cloud] Upload complete, polling for results...`);
  const deadline = Date.now() + POLL_MAX_MS;
  let lastState = '';

  while (Date.now() < deadline) {
    const statusData = await fetchWithRetry(
      async () => {
        const res = await providerFetch(
          `${apiRoot}/extract-results/batch/${batchData.batch_id}`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUTS.poll),
          },
          firstHopPolicy,
        );
        return readMinerUJson<{ extract_result?: BatchExtractRow | BatchExtractRow[] }>(
          res,
          'extract-results/batch',
        );
      },
      'poll batch',
      3,
    );

    const rows = statusData.extract_result;
    const list: BatchExtractRow[] = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const row =
      list.find((r) => r.file_name === uploadFileName) ||
      list.find((r) => r.file_name?.toLowerCase() === uploadFileName.toLowerCase()) ||
      list[0];

    if (!row?.state) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (row.state !== lastState) {
      lastState = row.state;
      log.info(`[MinerU Cloud] Batch ${batchData.batch_id} → ${row.state}`);
    }

    if (row.state === 'failed') {
      // `err_msg` is upstream text and stays out of caller-facing errors.
      throw new MinerUBoundedError('MinerU Cloud parsing failed');
    }

    if (row.state === 'done' && row.full_zip_url) {
      return parseMinerUZip(row.full_zip_url);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `MinerU Cloud timed out after ${POLL_MAX_MS / 1000}s (batch: ${batchData.batch_id})`,
  );
}
