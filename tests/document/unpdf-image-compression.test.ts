import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

import { parsePDF } from '@/lib/pdf/pdf-providers';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function buildPdfWithLargeImage(): Promise<Buffer> {
  // 2000×1500 solid-color PNG — larger than the 1280px compression ladder so
  // the test exercises resize, not just re-encode.
  const png = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: '#3366cc' },
  })
    .png()
    .toBuffer();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  const embedded = await pdf.embedPng(png);
  page.drawImage(embedded, { x: 0, y: 0, width: 400, height: 300 });
  return Buffer.from(await pdf.save());
}

describe('parseWithUnpdf image compression', () => {
  it('emits budgeted JPEG with post-resize dimensions instead of full-size PNG', async () => {
    const pdfBuffer = await buildPdfWithLargeImage();

    const result = await parsePDF({ providerId: 'unpdf' }, pdfBuffer);

    expect(result.text).toBeDefined();
    expect(result.images).toHaveLength(1);
    expect(result.images[0].startsWith('data:image/jpeg;base64,')).toBe(true);

    const meta = result.metadata?.pdfImages?.[0];
    expect(meta).toBeDefined();
    expect(meta!.width).toBeLessThanOrEqual(1280);
    expect(meta!.height).toBeLessThanOrEqual(1280);
    // Aspect ratio is preserved: 2000×1500 → 1280×960.
    expect(meta!.width).toBe(1280);
    expect(meta!.height).toBe(960);

    // The compressed payload must be far below the per-image byte cap.
    const base64 = result.images[0].split(',')[1] ?? '';
    expect(base64.length * 0.75).toBeLessThanOrEqual(512 * 1024);
  }, 30_000);
});
