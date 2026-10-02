import { describe, expect, it, vi } from 'vitest';

import { documentArtifactToParsedPdfContent, parsedPdfToDocumentArtifact } from '@/lib/document';
import type { DocumentArtifact } from '@/lib/document';
import type { DocumentAsset } from '@/lib/document/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { MAX_PARSED_IMAGE_PAYLOAD_CHARS } from '@/lib/constants/generation';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('PDF compatibility adapter', () => {
  it('normalizes parsed PDF output into a document artifact', () => {
    const parsed: ParsedPdfContent = {
      text: '# Safety Checklist\n\nInspect the device before calibration.',
      images: ['data:image/png;base64,abc'],
      metadata: {
        pageCount: 2,
        parser: 'mineru',
        imageMapping: {
          img_1: 'data:image/png;base64,abc',
        },
        pdfImages: [
          {
            id: 'img_1',
            src: 'data:image/png;base64,abc',
            pageNumber: 1,
            description: 'Device overview',
            width: 640,
            height: 480,
          },
        ],
        taskId: 'mineru-task-1',
      },
      tables: [{ page: 1, data: [['Tool', 'State']], caption: 'Inspection table' }],
      formulas: [
        {
          page: 2,
          latex: 'v = IR',
          position: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
      layout: [
        {
          page: 1,
          type: 'title',
          content: 'Safety Checklist',
          position: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
    };

    const artifact = parsedPdfToDocumentArtifact(parsed, {
      buffer: Buffer.from('pdf'),
      fileName: 'manual.pdf',
      fileSize: 123,
      mimeType: 'application/pdf',
      config: { providerId: 'mineru' },
    });

    expect(artifact.metadata).toMatchObject({
      fileName: 'manual.pdf',
      fileSize: 123,
      mimeType: 'application/pdf',
      pageCount: 2,
      providerId: 'mineru',
    });
    expect(artifact.metadata).not.toHaveProperty('pdfImages');
    expect(artifact.metadata).not.toHaveProperty('imageMapping');
    expect(artifact.metadata).not.toHaveProperty('parser');
    expect(artifact.blocks).toEqual([
      {
        id: 'document-text',
        type: 'markdown',
        text: '# Safety Checklist\n\nInspect the device before calibration.',
      },
      {
        id: 'table_1',
        type: 'table',
        text: 'Inspection table',
        pageNumber: 1,
        metadata: { data: [['Tool', 'State']], caption: 'Inspection table' },
      },
      {
        id: 'formula_1',
        type: 'formula',
        text: 'v = IR',
        pageNumber: 2,
        bbox: { x: 1, y: 2, width: 3, height: 4 },
      },
      {
        id: 'layout_1',
        type: 'layout',
        text: 'Safety Checklist',
        pageNumber: 1,
        bbox: { x: 0, y: 0, width: 100, height: 20 },
        metadata: { layoutType: 'title' },
      },
    ]);
    expect(artifact.assets).toEqual([
      {
        id: 'img_1',
        type: 'image',
        mimeType: 'image/png',
        data: 'data:image/png;base64,abc',
        pageNumber: 1,
        description: 'Device overview',
        width: 640,
        height: 480,
      },
    ]);
  });

  it('normalizes MinerU Cloud markdown output into a markdown document block', () => {
    const parsed: ParsedPdfContent = {
      text: '# Cloud Parsed Lesson',
      images: [],
      metadata: {
        pageCount: 1,
        parser: 'mineru-cloud',
      },
    };

    const artifact = parsedPdfToDocumentArtifact(parsed, {
      buffer: Buffer.from('docx'),
      fileName: 'lesson.docx',
      fileSize: 456,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      config: { providerId: 'mineru-cloud' },
    });

    expect(artifact.blocks[0]).toMatchObject({
      id: 'document-text',
      type: 'markdown',
      text: '# Cloud Parsed Lesson',
    });
  });

  it('round-trips back to the existing ParsedPdfContent shape used by generation', () => {
    const parsed: ParsedPdfContent = {
      text: 'Plain text',
      images: ['data:image/png;base64,abc'],
      metadata: {
        pageCount: 1,
        parser: 'unpdf',
        imageMapping: { img_1: 'data:image/png;base64,abc' },
        pdfImages: [{ id: 'img_1', src: 'data:image/png;base64,abc', pageNumber: 1 }],
      },
    };

    const artifact = parsedPdfToDocumentArtifact(parsed, {
      buffer: Buffer.from('pdf'),
      fileName: 'source.pdf',
      fileSize: 456,
      mimeType: 'application/pdf',
      config: { providerId: 'unpdf' },
    });

    artifact.blocks[0].text = 'Artifact text';
    const roundTripped = documentArtifactToParsedPdfContent(artifact);

    expect(roundTripped.text).toBe('Artifact text');
    // Images ride the response exactly once: `images` and `imageMapping` stay
    // empty — triplicating the base64 payload overflowed V8's max string
    // length on image-heavy PDFs.
    expect(roundTripped.images).toEqual([]);
    expect(roundTripped.metadata?.fileName).toBe('source.pdf');
    expect(roundTripped.metadata?.fileSize).toBe(456);
    expect(roundTripped.metadata?.pageCount).toBe(1);
    expect(roundTripped.metadata?.imageMapping).toEqual({});
    expect(roundTripped.metadata?.pdfImages).toEqual([
      { id: 'img_1', src: 'data:image/png;base64,abc', pageNumber: 1 },
    ]);
  });

  it('reconstructs structured PDF fields from an artifact without providerRaw', () => {
    const artifact: DocumentArtifact = {
      metadata: {
        fileName: 'artifact.pdf',
        fileSize: 789,
        mimeType: 'application/pdf',
        pageCount: 3,
        providerId: 'custom-document-provider',
      },
      blocks: [
        { id: 'text_1', type: 'markdown', text: 'Artifact markdown' },
        {
          id: 'table_1',
          type: 'table',
          text: 'Measurements',
          pageNumber: 2,
          metadata: { data: [['Voltage', '12V']], caption: 'Measurements' },
        },
        {
          id: 'formula_1',
          type: 'formula',
          text: 'P = UI',
          pageNumber: 2,
          bbox: { x: 10, y: 20, width: 30, height: 40 },
        },
        {
          id: 'layout_1',
          type: 'layout',
          text: 'Heading',
          pageNumber: 1,
          metadata: { layoutType: 'title' },
        },
      ],
      assets: [
        {
          id: 'img_1',
          type: 'image',
          data: 'data:image/png,raw',
          pageNumber: 1,
          description: 'Inline image',
        },
      ],
    };

    const parsed = documentArtifactToParsedPdfContent(artifact);

    expect(parsed.text).toBe('Artifact markdown');
    expect(parsed.images).toEqual([]);
    expect(parsed.tables).toEqual([
      { page: 2, data: [['Voltage', '12V']], caption: 'Measurements' },
    ]);
    expect(parsed.formulas).toEqual([
      {
        page: 2,
        latex: 'P = UI',
        position: { x: 10, y: 20, width: 30, height: 40 },
      },
    ]);
    expect(parsed.layout).toEqual([{ page: 1, type: 'title', content: 'Heading' }]);
    expect(parsed.metadata?.parser).toBeUndefined();
    expect(parsed.metadata?.pdfImages).toEqual([
      {
        id: 'img_1',
        src: 'data:image/png,raw',
        pageNumber: 1,
        description: 'Inline image',
        width: undefined,
        height: undefined,
      },
    ]);
  });

  it('drops trailing images once the cumulative payload budget is exceeded', () => {
    const perImageChars = 30_000_000; // two fit in the 64M-char budget, a third does not
    const imageAsset = (id: string): DocumentAsset & { data: string } => ({
      id,
      type: 'image',
      data: `data:image/jpeg;base64,${'a'.repeat(perImageChars)}`,
      pageNumber: 1,
    });
    const artifact: DocumentArtifact = {
      metadata: { fileName: 'huge.pdf', fileSize: 1, mimeType: 'application/pdf' },
      blocks: [{ id: 'document-text', type: 'text', text: 'text' }],
      assets: [imageAsset('img_1'), imageAsset('img_2'), imageAsset('img_3')],
    };

    const parsed = documentArtifactToParsedPdfContent(artifact);

    expect(parsed.metadata?.pdfImages).toHaveLength(2);
    expect(parsed.metadata?.pdfImages?.map((image) => image.id)).toEqual(['img_1', 'img_2']);
    // The kept payload itself stays within the budget.
    const totalChars = parsed.metadata!.pdfImages!.reduce(
      (sum, image) => sum + image.src.length,
      0,
    );
    expect(totalChars).toBeLessThanOrEqual(MAX_PARSED_IMAGE_PAYLOAD_CHARS);
    expect(parsed.images).toEqual([]);
    expect(parsed.metadata?.imageMapping).toEqual({});
  });
});
