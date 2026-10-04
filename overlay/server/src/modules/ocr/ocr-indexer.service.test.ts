import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OcrRepository } from './ocr.repository';
import { OcrValidationError } from './ocr-document';
import { OcrIndexerService, OCR_INDEX_BATCH_SIZE, ocrSourceSnapshot } from './ocr-indexer.service';
import { readOcrSidecar } from './ocr-sidecar';
import { validateOcrArchive } from './ocr-archive';

vi.mock('./ocr-sidecar', () => ({ readOcrSidecar: vi.fn() }));
vi.mock('./ocr-archive', () => ({ validateOcrArchive: vi.fn() }));

const document = { version: 1 as const, documentId: 'fixture', sourceCbz: 'sample.cbz', pages: [] };
const hash = 'a'.repeat(64);
let root: string;
let path: string;
let sidecar: string;
let service: OcrIndexerService;
let repo: { indexCandidates: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn>; invalidateIndex: ReturnType<typeof vi.fn> };

type Candidate = Awaited<ReturnType<OcrRepository['indexCandidates']>>[number];
function candidate(extra: Partial<Candidate> = {}): Candidate {
  return {
    fileId: 1,
    absolutePath: path,
    format: 'cbz',
    role: 'content',
    bookStatus: 'present',
    sourceStamp: null,
    indexStatus: null,
    indexedFingerprint: null,
    documentFingerprint: null,
    ...extra,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'ocr-indexer-'));
  path = join(root, 'sample.cbz');
  sidecar = join(root, 'sample.ocr.json');
  await writeFile(path, 'fake archive bytes');
  await writeFile(sidecar, '{}');
  repo = {
    indexCandidates: vi.fn().mockResolvedValue([candidate()]),
    replace: vi.fn().mockResolvedValue(undefined),
    invalidateIndex: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(readOcrSidecar).mockResolvedValue({ document, fingerprint: hash });
  vi.mocked(validateOcrArchive).mockResolvedValue({ entries: new Map(), fingerprint: hash });
  const module = await Test.createTestingModule({ providers: [OcrIndexerService, { provide: OcrRepository, useValue: repo }] }).compile();
  service = module.get(OcrIndexerService);
});
afterEach(async () => {
  await service.onModuleDestroy();
  await rm(root, { recursive: true, force: true });
});

describe('automatic OCR indexer', () => {
  it('indexes a new catalogued CBZ with its stable persisted stat fingerprint', async () => {
    const before = await ocrSourceSnapshot(path);
    await service.tick();
    expect(repo.indexCandidates).toHaveBeenCalledWith(0, OCR_INDEX_BATCH_SIZE);
    expect(repo.replace).toHaveBeenCalledWith(1, document, hash, before.stamp);
  });

  it('skips unchanged source without loading any JSON or archive bytes', async () => {
    const snapshot = await ocrSourceSnapshot(path);
    repo.indexCandidates.mockResolvedValue([
      candidate({ sourceStamp: snapshot.stamp, indexStatus: 'indexed', indexedFingerprint: hash, documentFingerprint: hash }),
    ]);
    await service.tick();
    expect(readOcrSidecar).not.toHaveBeenCalled();
    expect(validateOcrArchive).not.toHaveBeenCalled();
    expect(repo.replace).not.toHaveBeenCalled();
  });

  it('rechecks when a manual reindex changed the indexed fingerprint', async () => {
    const snapshot = await ocrSourceSnapshot(path);
    repo.indexCandidates.mockResolvedValue([
      candidate({ sourceStamp: snapshot.stamp, indexStatus: 'indexed', indexedFingerprint: hash, documentFingerprint: 'b'.repeat(64) }),
    ]);
    await service.tick();
    expect(readOcrSidecar).toHaveBeenCalledOnce();
  });

  it('detects sidecar-only edits even when BookOrbit did not scan the CBZ again', async () => {
    const snapshot = await ocrSourceSnapshot(path);
    repo.indexCandidates.mockResolvedValue([
      candidate({ sourceStamp: snapshot.stamp, indexStatus: 'indexed', indexedFingerprint: hash, documentFingerprint: hash }),
    ]);
    await writeFile(sidecar, '{"changed":true}');
    await service.tick();
    expect(repo.replace).toHaveBeenCalledOnce();
  });

  it('invalidates an index after the sidecar disappears', async () => {
    await rm(sidecar);
    await service.tick();
    expect(repo.invalidateIndex).toHaveBeenCalledWith(1, expect.any(String), 'missing');
    expect(readOcrSidecar).not.toHaveBeenCalled();
  });

  it('persists missing state and avoids repeat parsing on later sweeps', async () => {
    await rm(sidecar);
    const snapshot = await ocrSourceSnapshot(path);
    repo.indexCandidates.mockResolvedValue([candidate({ sourceStamp: snapshot.stamp, indexStatus: 'missing' })]);
    await service.tick();
    expect(repo.invalidateIndex).not.toHaveBeenCalled();
    expect(readOcrSidecar).not.toHaveBeenCalled();
  });

  it('invalidates missing catalogue books without touching their filesystem paths', async () => {
    repo.indexCandidates.mockResolvedValue([candidate({ bookStatus: 'missing', absolutePath: '/does/not/exist', documentFingerprint: hash })]);
    await service.tick();
    expect(repo.invalidateIndex).toHaveBeenCalledWith(1, expect.any(String), 'missing');
    expect(readOcrSidecar).not.toHaveBeenCalled();
  });

  it('invalidates stable malformed OCR and does not log its error message', async () => {
    const logger = vi.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
    vi.mocked(readOcrSidecar).mockRejectedValue(new OcrValidationError('private patient content'));
    await service.tick();
    expect(repo.invalidateIndex).toHaveBeenCalledWith(1, expect.any(String), 'invalid');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private patient');
  });

  it('preserves an old index for transient IO failures and retries', async () => {
    vi.mocked(readOcrSidecar).mockRejectedValue(Object.assign(new Error('private path'), { code: 'EIO' }));
    await service.tick();
    await service.tick();
    expect(repo.invalidateIndex).not.toHaveBeenCalled();
    expect(readOcrSidecar).toHaveBeenCalledTimes(2);
  });

  it('does not persist a mixed version when the sidecar changes during parsing', async () => {
    vi.mocked(readOcrSidecar).mockImplementation(async () => {
      await writeFile(sidecar, '{"updatedDuringRead":true}');
      return { document, fingerprint: hash };
    });
    await service.tick();
    expect(repo.replace).not.toHaveBeenCalled();
    expect(repo.invalidateIndex).not.toHaveBeenCalled();
  });

  it('suppresses overlap and waits for the active read before shutdown', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    repo.indexCandidates.mockReturnValue(pending.then(() => [candidate()]));
    const first = service.tick();
    await service.tick();
    expect(repo.indexCandidates).toHaveBeenCalledOnce();
    let shutdownDone = false;
    const stopping = service.onModuleDestroy().then(() => {
      shutdownDone = true;
    });
    await Promise.resolve();
    expect(shutdownDone).toBe(false);
    release();
    await Promise.all([first, stopping]);
    await service.tick();
    expect(repo.indexCandidates).toHaveBeenCalledOnce();
    expect(readOcrSidecar).not.toHaveBeenCalled();
  });

  it('advances bounded keyset batches and wraps after the final short batch', async () => {
    const snapshot = await ocrSourceSnapshot(path);
    const state = { sourceStamp: snapshot.stamp, indexStatus: 'indexed' as const, indexedFingerprint: hash, documentFingerprint: hash };
    repo.indexCandidates
      .mockResolvedValueOnce(Array.from({ length: OCR_INDEX_BATCH_SIZE }, (_, i) => candidate({ ...state, fileId: i + 1 })))
      .mockResolvedValueOnce([candidate({ ...state, fileId: OCR_INDEX_BATCH_SIZE + 1 })])
      .mockResolvedValueOnce([]);
    await service.tick();
    await service.tick();
    await service.tick();
    expect(repo.indexCandidates.mock.calls).toEqual([
      [0, 100],
      [100, 100],
      [0, 100],
    ]);
    expect(readOcrSidecar).not.toHaveBeenCalled();
  });

  it('does not block bootstrap waiting for the first database batch', () => {
    let release!: () => void;
    repo.indexCandidates.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );
    expect(service.onApplicationBootstrap()).toBeUndefined();
    release();
  });
});

describe('stat fingerprint safety', () => {
  it('detects replacement of a same-size sidecar', async () => {
    const before = await ocrSourceSnapshot(path);
    await writeFile(join(root, 'replacement'), '{}');
    await rename(join(root, 'replacement'), sidecar);
    expect((await ocrSourceSnapshot(path)).stamp).not.toBe(before.stamp);
  });
  it('rejects an escaping sidecar link without reading its target', async () => {
    await rm(sidecar);
    await symlink('/etc/hosts', sidecar);
    expect((await ocrSourceSnapshot(path)).status).toBe('invalid');
  });
});
