import { describe, expect, it } from 'vitest';
import { parseOcrDocument } from './ocr-document';

function fixture() {
  return {
    version: 1,
    document_id: 'synthetic',
    source_cbz: 'synthetic.cbz',
    page_count: 1,
    pages: [{ page: 1, source: 'nested/001.avif', width: 100, height: 200, blocks: [{ id: 0, text: '牙周炎', bbox: [10, 20, 80, 100] }] }],
  };
}

describe('canonical OCR document', () => {
  it('preserves original pixels and exact archive source', () => {
    expect(parseOcrDocument(fixture()).pages[0]).toEqual({
      page: 1,
      source: 'nested/001.avif',
      width: 100,
      height: 200,
      blocks: [{ id: 0, text: '牙周炎', bbox: [10, 20, 80, 100] }],
    });
  });

  it.each(['../page.avif', '/page.avif', 'C:/page.avif', 'nested\\page.avif', '__MACOSX/page.avif', 'nested/._page.avif'])(
    'rejects unsafe source %s',
    (source) => {
      const doc = fixture();
      doc.pages[0].source = source;
      expect(() => parseOcrDocument(doc)).toThrow();
    },
  );

  it.each([
    [0, 0, 101, 100],
    [0, 0, 20, 201],
    [20, 20, 10, 30],
    [0, 0, Infinity, 30],
  ])('rejects invalid pixel bounds %j', (...bbox) => {
    const doc = fixture();
    doc.pages[0].blocks[0].bbox = bbox;
    expect(() => parseOcrDocument(doc)).toThrow();
  });

  it('rejects duplicate block IDs on a page', () => {
    const doc = fixture();
    doc.pages[0].blocks.push(doc.pages[0].blocks[0]);
    expect(() => parseOcrDocument(doc)).toThrow('duplicate block id');
  });

  it('allows the same block ID on separate pages', () => {
    const doc = fixture();
    doc.page_count = 2;
    doc.pages.push({ ...doc.pages[0], page: 2, source: '002.avif' });
    expect(parseOcrDocument(doc).pages).toHaveLength(2);
  });

  it('does not echo sensitive text in validation errors', () => {
    const doc = fixture();
    doc.pages[0].blocks[0].bbox = [-1, 0, 10, 20];
    expect(() => parseOcrDocument(doc)).toThrow('bbox out of bounds');
  });

  it('rejects stale page count and unsupported versions', () => {
    expect(() => parseOcrDocument({ ...fixture(), page_count: 2 })).toThrow('page count mismatch');
    expect(() => parseOcrDocument({ ...fixture(), version: 2 })).toThrow('unsupported version');
  });
});
