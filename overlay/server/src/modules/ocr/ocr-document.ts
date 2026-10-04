export interface OcrBlock {
  id: number;
  text: string;
  bbox: [number, number, number, number] | null;
}

export interface OcrPage {
  page: number;
  source: string;
  width: number;
  height: number;
  blocks: OcrBlock[];
}

export interface OcrDocument {
  version: 1;
  documentId: string;
  sourceCbz: string;
  pages: OcrPage[];
}

/** Validation errors deliberately exclude OCR text and filenames. */
export class OcrValidationError extends Error {
  constructor(reason: string) {
    super(`Invalid OCR document: ${reason}`);
    this.name = 'OcrValidationError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OcrValidationError('expected object');
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new OcrValidationError('invalid integer');
  return value;
}

function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new OcrValidationError('invalid string');
  return value;
}

function source(value: unknown): string {
  const name = string(value, 4096);
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((part) => !part || part === '..' || part.startsWith('.'))
  ) {
    throw new OcrValidationError('unsafe source');
  }
  if (name.split('/').includes('__MACOSX')) throw new OcrValidationError('metadata source');
  return name;
}

/** Parse canonical v1, preserving exact ZIP entry names and original-pixel boxes. */
export function parseOcrDocument(value: unknown): OcrDocument {
  const doc = record(value);
  if (doc.version !== 1) throw new OcrValidationError('unsupported version');
  const documentId = string(doc.document_id, 4096);
  const sourceCbz = source(doc.source_cbz);
  if (!Array.isArray(doc.pages) || doc.pages.length === 0 || doc.pages.length > 10000) throw new OcrValidationError('invalid pages');
  if (doc.page_count !== doc.pages.length) throw new OcrValidationError('page count mismatch');
  const sources = new Set<string>();
  let blockCount = 0;
  let textLength = 0;
  const pages = doc.pages.map((value, pageIndex): OcrPage => {
    const page = record(value);
    if (integer(page.page, 1) !== pageIndex + 1) throw new OcrValidationError('non-contiguous page numbers');
    const name = source(page.source);
    if (sources.has(name)) throw new OcrValidationError('duplicate page source');
    sources.add(name);
    const width = integer(page.width, 1);
    const height = integer(page.height, 1);
    if (width > 100000 || height > 100000) throw new OcrValidationError('page dimensions too large');
    if (!Array.isArray(page.blocks)) throw new OcrValidationError('invalid blocks');
    blockCount += page.blocks.length;
    if (blockCount > 200000) throw new OcrValidationError('too many blocks');
    const ids = new Set<number>();
    const blocks = page.blocks.map((value): OcrBlock => {
      const block = record(value);
      const id = integer(block.id, 0);
      if (ids.has(id)) throw new OcrValidationError('duplicate block id');
      ids.add(id);
      if (typeof block.text !== 'string' || block.text.includes('\0')) throw new OcrValidationError('invalid block text');
      textLength += block.text.length;
      if (textLength > 16000000) throw new OcrValidationError('too much text');
      let bbox: OcrBlock['bbox'] = null;
      if (block.bbox != null) {
        if (!Array.isArray(block.bbox) || block.bbox.length !== 4 || block.bbox.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
          throw new OcrValidationError('invalid bbox');
        }
        const [x1, y1, x2, y2] = block.bbox as number[];
        if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1 || x2 > width || y2 > height) throw new OcrValidationError('bbox out of bounds');
        bbox = [x1, y1, x2, y2];
      }
      return { id, text: block.text, bbox };
    });
    return { page: pageIndex + 1, source: name, width, height, blocks };
  });
  return { version: 1, documentId, sourceCbz, pages };
}
