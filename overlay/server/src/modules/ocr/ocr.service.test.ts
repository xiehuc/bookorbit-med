import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { OcrRepository } from './ocr.repository';
import { OcrService } from './ocr.service';
import { OcrValidationError } from './ocr-document';
import type { RequestUser } from '../../common/types/request-user';

const io = vi.hoisted(() => ({ sidecar: vi.fn(), archive: vi.fn(), stream: vi.fn(), metadata: vi.fn(), unchanged: vi.fn() }));
vi.mock('./ocr-sidecar', () => ({ readOcrSidecar: io.sidecar }));
vi.mock('./ocr-archive', () => ({ validateOcrArchive: io.archive, assertOcrArchiveUnchanged: io.unchanged, MAX_OCR_PAGE_BYTES: 32 * 1024 * 1024 }));
vi.mock('../../common/cbz-zip-reader', () => ({ createCbzZipEntryReadStream: io.stream }));
vi.mock('sharp', () => ({ default: () => ({ metadata: io.metadata }) }));

const user = {
  id: 7,
  isSuperuser: false,
  contentFilters: { includeTagIds: [], includeGenreIds: [], excludeTagIds: [4], excludeGenreIds: [] },
} as RequestUser;
const revision = 'a'.repeat(64);
const file = { id: 11, bookId: 12, libraryId: 3, absolutePath: '/synthetic/book.cbz' };
const document = {
  version: 1,
  documentId: 'synthetic',
  sourceCbz: 'book.cbz',
  pages: [{ page: 1, source: '001.avif', width: 100, height: 200, blocks: [{ id: 9, text: 'synthetic text', bbox: [1, 2, 30, 40] }] }],
};
let service: OcrService;
let books: { verifyFileAccess: ReturnType<typeof vi.fn> };
let libraries: { findAll: ReturnType<typeof vi.fn>; verifyUserAccessLevel: ReturnType<typeof vi.fn> };
let repo: {
  search: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  fingerprint: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  vi.resetAllMocks();
  books = { verifyFileAccess: vi.fn().mockResolvedValue(file) };
  libraries = { findAll: vi.fn().mockResolvedValue([{ id: 3 }, { id: 5 }]), verifyUserAccessLevel: vi.fn().mockResolvedValue(undefined) };
  repo = {
    search: vi.fn().mockResolvedValue([]),
    replace: vi.fn().mockResolvedValue(undefined),
    fingerprint: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  io.sidecar.mockResolvedValue({ document, fingerprint: 'json-revision' });
  io.archive.mockResolvedValue({ fingerprint: revision, archiveState: { size: 100 }, entries: new Map([['001.avif', { name: '001.avif' }]]) });
  const module = await Test.createTestingModule({
    providers: [
      OcrService,
      { provide: BookService, useValue: books },
      { provide: LibraryService, useValue: libraries },
      { provide: OcrRepository, useValue: repo },
    ],
  }).compile();
  service = module.get(OcrService);
});

describe('OcrService authorization and source revisions', () => {
  it.each(['manifest', 'hit', 'image'] as const)('authorizes %s before touching disk', async (method) => {
    books.verifyFileAccess.mockRejectedValue(new ForbiddenException());
    const operation =
      method === 'manifest'
        ? service.manifest(11, user)
        : method === 'hit'
          ? service.hit(11, user, { page: 1, block: 9, revision })
          : service.image(11, 1, user, revision);
    await expect(operation).rejects.toBeInstanceOf(ForbiddenException);
    expect(io.sidecar).not.toHaveBeenCalled();
    expect(io.archive).not.toHaveBeenCalled();
    expect(io.stream).not.toHaveBeenCalled();
  });
  it('requires editor access before indexing or reading disk', async () => {
    libraries.verifyUserAccessLevel.mockRejectedValue(new ForbiddenException());
    await expect(service.index(11, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(libraries.verifyUserAccessLevel).toHaveBeenCalledWith(7, 3, false, 'editor');
    expect(io.sidecar).not.toHaveBeenCalled();
    expect(repo.remove).not.toHaveBeenCalled();
  });
  it('does not read or remove anything when initial file access fails', async () => {
    books.verifyFileAccess.mockRejectedValue(new NotFoundException());
    await expect(service.index(11, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(io.sidecar).not.toHaveBeenCalled();
    expect(repo.remove).not.toHaveBeenCalled();
  });
  it('rejects stale hit revision', async () => {
    await expect(service.hit(11, user, { page: 1, block: 9, revision: 'b'.repeat(64) })).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects stale image revision before streaming bytes', async () => {
    await expect(service.image(11, 1, user, 'b'.repeat(64))).rejects.toBeInstanceOf(ConflictException);
    expect(io.stream).not.toHaveBeenCalled();
  });
  it('resolves exact block id rather than array offset', async () => {
    expect(await service.hit(11, user, { page: 1, block: 9, revision })).toMatchObject({ blockId: 9, page: 1, bbox: [1, 2, 30, 40] });
    await expect(service.hit(11, user, { page: 1, block: 0, revision })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects missing pages', async () => {
    await expect(service.image(11, 2, user, revision)).rejects.toBeInstanceOf(NotFoundException);
    expect(io.stream).not.toHaveBeenCalled();
  });
  it('removes an index when its archive no longer matches JSON', async () => {
    io.archive.mockRejectedValue(new OcrValidationError('archive page sources mismatch'));
    await expect(service.index(11, user)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.remove).toHaveBeenCalledWith(11);
    expect(repo.replace).not.toHaveBeenCalled();
  });
  it('removes an index when its sidecar disappeared', async () => {
    io.sidecar.mockResolvedValue(null);
    await expect(service.index(11, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.remove).toHaveBeenCalledWith(11);
  });
  it.each(['fingerprint', 'replace'] as const)('preserves a valid old index on transient repository %s failure', async (method) => {
    repo[method].mockRejectedValue(new Error('database unavailable'));
    await expect(service.index(11, user)).rejects.toThrow('database unavailable');
    expect(repo.remove).not.toHaveBeenCalled();
  });
  it('preserves the index on a transient filesystem failure', async () => {
    io.sidecar.mockRejectedValue(Object.assign(new Error('temporary I/O failure'), { code: 'EIO' }));
    await expect(service.index(11, user)).rejects.toThrow('temporary I/O failure');
    expect(repo.remove).not.toHaveBeenCalled();
  });
  it('reuses the authorized file instead of a second authorization inside invalidation', async () => {
    books.verifyFileAccess.mockResolvedValueOnce(file).mockRejectedValue(new NotFoundException());
    await service.index(11, user);
    expect(books.verifyFileAccess).toHaveBeenCalledTimes(1);
    expect(repo.remove).not.toHaveBeenCalled();
  });
  it.each([new NotFoundException(), new UnprocessableEntityException()])(
    'does not invalidate source for repository HTTP-shaped errors',
    async (error) => {
      repo.replace.mockRejectedValue(error);
      await expect(service.index(11, user)).rejects.toBe(error);
      expect(repo.remove).not.toHaveBeenCalled();
    },
  );
  it('does not rewrite an unchanged revision', async () => {
    repo.fingerprint.mockResolvedValue(revision);
    await expect(service.index(11, user)).resolves.toMatchObject({ fingerprint: revision, pageCount: 1 });
    expect(repo.replace).not.toHaveBeenCalled();
  });
  it('replaces a changed source with the validated document', async () => {
    await service.index(11, user);
    expect(repo.replace).toHaveBeenCalledWith(11, document, revision);
  });
  it('rejects archive replacement after streaming instead of delivering mismatched bytes', async () => {
    io.stream.mockImplementation(() => Readable.from([Buffer.from('synthetic')]));
    io.metadata.mockResolvedValue({ width: 100, height: 200 });
    io.unchanged.mockRejectedValue(new OcrValidationError('archive changed during validation'));
    await expect(service.image(11, 1, user, revision)).rejects.toBeInstanceOf(ConflictException);
    expect(io.unchanged).toHaveBeenCalledWith(file.absolutePath, { size: 100 });
  });
  it('delivers bytes only after final archive revalidation', async () => {
    io.stream.mockImplementation(() => Readable.from([Buffer.from('synthetic')]));
    io.metadata.mockResolvedValue({ width: 100, height: 200 });
    io.unchanged.mockResolvedValue(undefined);
    expect(await service.image(11, 1, user, revision)).toEqual({ buffer: Buffer.from('synthetic'), mimeType: 'image/avif' });
    expect(io.unchanged).toHaveBeenCalledTimes(1);
  });
  it('closes oversized streams when async iteration throws', async () => {
    const stream = Readable.from([Buffer.alloc(32 * 1024 * 1024 + 1)]);
    io.stream.mockReturnValue(stream);
    await expect(service.image(11, 1, user, revision)).rejects.toThrow('Page exceeds size limit');
    expect(stream.destroyed).toBe(true);
    expect(io.metadata).not.toHaveBeenCalled();
  });
  it('rejects image dimensions and orientation inconsistent with OCR', async () => {
    io.stream.mockImplementation(() => Readable.from([Buffer.from('synthetic')]));
    io.metadata.mockResolvedValue({ width: 101, height: 200 });
    await expect(service.image(11, 1, user, revision)).rejects.toBeInstanceOf(UnprocessableEntityException);
    io.metadata.mockResolvedValue({ width: 100, height: 200, orientation: 6 });
    await expect(service.image(11, 1, user, revision)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('OcrService search', () => {
  it('passes only accessible libraries and complete user filter context', async () => {
    await service.search(user, { q: '  牙周  ', offset: 2, limit: 3 });
    expect(repo.search).toHaveBeenCalledWith(user, [3, 5], '牙周', 2, 4);
    expect(io.sidecar).not.toHaveBeenCalled();
  });
  it('intersects requested library with current access', async () => {
    await service.search(user, { q: '牙周', offset: 0, limit: 20, libraryId: 99 });
    expect(repo.search).toHaveBeenCalledWith(user, [], '牙周', 0, 21);
  });
  it('uses bounded lookahead and does not expose the extra row', async () => {
    repo.search.mockResolvedValue([
      { blockId: 1, text: 'one' },
      { blockId: 2, text: 'two' },
      { blockId: 3, text: 'three' },
    ]);
    expect(await service.search(user, { q: '牙周', offset: 0, limit: 2 })).toEqual({
      items: [
        { blockId: 1, text: 'one' },
        { blockId: 2, text: 'two' },
      ],
      hasMore: true,
    });
  });
  it('returns bounded snippets surrounding distant normalized matches', async () => {
    repo.search.mockResolvedValue([{ blockId: 1, text: '前'.repeat(5000) + 'ＣＲＰ' + '后'.repeat(5000) }]);
    const result = await service.search(user, { q: 'crp', offset: 0, limit: 20 });
    expect(result.items[0].text.length).toBeLessThanOrEqual(1000);
    expect(result.items[0].text).toContain('CRP');
    expect(result.items[0].blockId).toBe(1);
  });
  it('rejects single-character queries before querying the repository', async () => {
    await expect(service.search(user, { q: '牙', offset: 0, limit: 20 })).rejects.toThrow('at least two');
    expect(repo.search).not.toHaveBeenCalled();
  });
});
