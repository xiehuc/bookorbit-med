import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CbzZipEntry } from '../../common/cbz-zip-reader';
import type { OcrDocument } from './ocr-document';
import { MAX_OCR_PAGE_BYTES, validateOcrArchive } from './ocr-archive';

const io = vi.hoisted(() => ({ stat: vi.fn(), index: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: io.stat }));
vi.mock('../../common/cbz-zip-reader', () => ({ readCbzZipIndex: io.index }));
const document: OcrDocument = {
  version: 1,
  documentId: 'synthetic',
  sourceCbz: 'book.cbz',
  pages: [
    { page: 1, source: '002.avif', width: 100, height: 200, blocks: [] },
    { page: 2, source: '001.avif', width: 100, height: 200, blocks: [] },
  ],
};
const entry = (name: string, overrides: Partial<CbzZipEntry> = {}): CbzZipEntry => ({
  name,
  compression: 0,
  compressedSize: 10,
  uncompressedSize: 10,
  localHeaderOffset: 0,
  dataStart: 10,
  ...overrides,
});
const stat = (overrides = {}) => ({ isFile: () => true, size: 1000, mtimeMs: 20, ctimeMs: 30, ino: 123, dev: 1, ...overrides });
beforeEach(() => {
  vi.resetAllMocks();
  io.stat.mockResolvedValue(stat());
  io.index.mockResolvedValue({ entries: [entry('001.avif'), entry('002.avif')], comment: null });
});

describe('validateOcrArchive', () => {
  it('matches exact entry names independently of ZIP and JSON ordering', async () => {
    const result = await validateOcrArchive('/synthetic/book.cbz', document, 'json-hash');
    expect([...result.entries.keys()]).toEqual(['001.avif', '002.avif']);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('excludes macOS metadata, dotfiles and non-images', async () => {
    io.index.mockResolvedValue({
      entries: [entry('001.avif'), entry('002.avif'), entry('__MACOSX/003.avif'), entry('._001.avif'), entry('notes.txt')],
    });
    expect((await validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).entries.size).toBe(2);
  });
  it('rejects duplicate entry names', async () => {
    io.index.mockResolvedValue({ entries: [entry('001.avif'), entry('001.avif'), entry('002.avif')] });
    await expect(validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).rejects.toThrow('duplicate ZIP entry');
  });
  it.each([[], [entry('001.avif')], [entry('001.avif'), entry('other.avif')], [entry('001.avif'), entry('002.avif'), entry('003.avif')]])(
    'rejects missing, extra or renamed page sources %#',
    async (...entries) => {
      io.index.mockResolvedValue({ entries });
      await expect(validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).rejects.toThrow('archive page sources mismatch');
    },
  );
  it.each([{ compression: 99 }, { uncompressedSize: 0 }, { uncompressedSize: MAX_OCR_PAGE_BYTES + 1 }])(
    'rejects unsupported or oversized page %j',
    async (overrides) => {
      io.index.mockResolvedValue({ entries: [entry('001.avif', overrides), entry('002.avif')] });
      await expect(validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).rejects.toThrow('unsupported archive page');
    },
  );
  it('rejects a non-file before parsing the archive', async () => {
    io.stat.mockResolvedValue(stat({ isFile: () => false }));
    await expect(validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).rejects.toThrow('not a file');
    expect(io.index).not.toHaveBeenCalled();
  });
  it('rejects an unreadable archive index', async () => {
    io.index.mockResolvedValue(null);
    await expect(validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).rejects.toThrow('invalid archive');
  });
  it('rejects a file changed while inspecting its index', async () => {
    io.stat.mockResolvedValueOnce(stat()).mockResolvedValueOnce(stat({ mtimeMs: 21 }));
    await expect(validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).rejects.toThrow('changed during validation');
  });
  it.each([{ ctimeMs: 31 }, { ino: 124 }, { dev: 2 }])('rejects same-size same-mtime replacement %j', async (change) => {
    io.stat.mockResolvedValueOnce(stat()).mockResolvedValueOnce(stat(change));
    await expect(validateOcrArchive('/synthetic/book.cbz', document, 'json-hash')).rejects.toThrow('changed during validation');
  });
  it('changes revision when either JSON or CBZ metadata changes', async () => {
    const a = await validateOcrArchive('/synthetic/book.cbz', document, 'json-a');
    const b = await validateOcrArchive('/synthetic/book.cbz', document, 'json-b');
    io.stat.mockResolvedValue(stat({ ctimeMs: 31 }));
    const c = await validateOcrArchive('/synthetic/book.cbz', document, 'json-a');
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
});
