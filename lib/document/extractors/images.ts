import sharp from 'sharp';

export const MAX_DERIVED_IMAGES = 100;
export const MAX_DERIVED_IMAGE_BYTES = 2 * 1024 * 1024;
const DERIVED_IMAGE_ATTEMPTS = [
  { dimension: 2048, quality: 82 },
  { dimension: 1600, quality: 70 },
  { dimension: 1280, quality: 60 },
  { dimension: 960, quality: 50 },
] as const;

export interface PreparedDerivedImage {
  buffer: Buffer;
  mime: 'image/webp';
  width?: number;
  height?: number;
}

export interface PreparedPdfImage {
  buffer: Buffer;
  mime: 'image/jpeg';
  width: number;
  height: number;
}

export function limitDerivedImages<T>(assets: readonly T[]): { selected: T[]; skipped: number } {
  return {
    selected: assets.slice(0, MAX_DERIVED_IMAGES),
    skipped: Math.max(0, assets.length - MAX_DERIVED_IMAGES),
  };
}

/** Downsample and progressively compress one extracted image to the shared 2MB cap. */
export async function prepareDerivedImage(buffer: Buffer): Promise<PreparedDerivedImage | null> {
  for (const attempt of DERIVED_IMAGE_ATTEMPTS) {
    const output = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: attempt.dimension,
        height: attempt.dimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: attempt.quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (output.data.byteLength <= MAX_DERIVED_IMAGE_BYTES) {
      return {
        buffer: output.data,
        mime: 'image/webp',
        ...(output.info.width ? { width: output.info.width } : {}),
        ...(output.info.height ? { height: output.info.height } : {}),
      };
    }
  }
  return null;
}

// PDF-embedded illustrations only ever feed vision prompts (≤ MAX_VISION_IMAGES
// per call) and the 1000px-wide slide canvas, so 1280px JPEG covers every
// consumer. JPEG (not the WebP used by prepareDerivedImage) because vision
// endpoints — including GLM's — accept it universally.
const PDF_IMAGE_ATTEMPTS = [
  { dimension: 1280, quality: 78 },
  { dimension: 1024, quality: 65 },
  { dimension: 800, quality: 50 },
] as const;
const MAX_PDF_IMAGE_BYTES = 512 * 1024;

export interface RawPdfImage {
  /** Raw pixel bytes from pdf.js image decoding (Uint8ClampedArray or Buffer). */
  data: Uint8Array | Uint8ClampedArray | Buffer;
  width: number;
  height: number;
  channels: number;
}

/**
 * Compress one raw-pixel PDF image to a budgeted JPEG. Returns the POST-resize
 * dimensions — callers must record those (not the source dimensions) because
 * downstream prompt labels and vision ordering consume width/height metadata.
 */
export async function preparePdfImage(raw: RawPdfImage): Promise<PreparedPdfImage | null> {
  for (const attempt of PDF_IMAGE_ATTEMPTS) {
    const output = await sharp(
      Buffer.from(raw.data.buffer as ArrayBuffer, raw.data.byteOffset, raw.data.byteLength),
      {
        raw: {
          width: raw.width,
          height: raw.height,
          channels: raw.channels as 1 | 2 | 3 | 4,
        },
      },
    )
      .flatten({ background: '#ffffff' })
      .resize({
        width: attempt.dimension,
        height: attempt.dimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: attempt.quality })
      .toBuffer({ resolveWithObject: true });
    if (output.data.byteLength <= MAX_PDF_IMAGE_BYTES) {
      return {
        buffer: output.data,
        mime: 'image/jpeg',
        width: output.info.width,
        height: output.info.height,
      };
    }
  }
  return null;
}
