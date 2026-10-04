import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { OcrRepository } from './ocr.repository';
import { OcrValidationError } from './ocr-document';
import { readOcrSidecar } from './ocr-sidecar';
import { validateOcrArchive } from './ocr-archive';

export const OCR_INDEX_INTERVAL_MS = 10000;
export const OCR_INDEX_BATCH_SIZE = 100;

type Candidate = Awaited<ReturnType<OcrRepository['indexCandidates']>>[number];
type Snapshot = { stamp: string; status: 'present' | 'missing' | 'invalid' };

function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function isMissing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

async function signature(path: string, follow: boolean) {
  try {
    const info = await (follow ? stat(path, { bigint: true }) : lstat(path, { bigint: true }));
    return {
      exists: true,
      isFile: info.isFile(),
      values: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].map(String),
    };
  } catch (error) {
    if (isMissing(error)) return { exists: false, isFile: false, values: ['missing'] };
    throw error;
  }
}

/** Stat-only check, including symlink identity and target; no OCR or page bytes are read. */
export async function ocrSourceSnapshot(path: string): Promise<Snapshot> {
  const book = await signature(path, true);
  let directory: string;
  try {
    directory = await realpath(dirname(path));
  } catch (error) {
    if (isMissing(error)) return { stamp: digest([path, book.values, 'missing-directory']), status: 'missing' };
    throw error;
  }
  const candidate = join(directory, `${basename(path, extname(path))}.ocr.json`);
  const link = await signature(candidate, false);
  if (!book.exists || !link.exists) return { stamp: digest([path, directory, book.values, link.values]), status: 'missing' };
  let target: string;
  try {
    target = await realpath(candidate);
  } catch (error) {
    if (isMissing(error)) return { stamp: digest([path, book.values, link.values, 'missing-target']), status: 'missing' };
    throw error;
  }
  if (dirname(target) !== directory) return { stamp: digest([path, book.values, link.values, target]), status: 'invalid' };
  const sidecar = await signature(target, true);
  const stamp = digest([path, directory, book.values, link.values, target, sidecar.values]);
  if (!sidecar.exists) return { stamp, status: 'missing' };
  if (!book.isFile || !sidecar.isFile || extname(path).toLowerCase() !== '.cbz') return { stamp, status: 'invalid' };
  return { stamp, status: 'present' };
}

@Injectable()
export class OcrIndexerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OcrIndexerService.name);
  private cursor = 0;
  private active: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly repository: OcrRepository) {}

  onApplicationBootstrap(): void {
    // The initial bounded batch is detached; migrations/startup are not delayed by parsing files.
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.active;
  }

  @Interval('ocr-discovery', OCR_INDEX_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.stopping || this.active) return;
    this.active = this.runBatch();
    try {
      await this.active;
    } finally {
      this.active = null;
    }
  }

  private async runBatch(): Promise<void> {
    const started = Date.now();
    let checked = 0;
    let failed = 0;
    try {
      const candidates = await this.repository.indexCandidates(this.cursor, OCR_INDEX_BATCH_SIZE);
      for (const candidate of candidates) {
        if (this.stopping) break;
        try {
          await this.process(candidate);
        } catch {
          // Transient IO/database errors are retried next sweep without discarding a valid index.
          failed++;
          this.logger.warn(`[ocr.discovery] [fail] fileId=${candidate.fileId} - indexing will retry next sweep`);
        }
        this.cursor = candidate.fileId;
        checked++;
      }
      if (candidates.length < OCR_INDEX_BATCH_SIZE) this.cursor = 0;
      if (failed) this.logger.warn(`[ocr.discovery] [end] checked=${checked} failed=${failed} durationMs=${Date.now() - started} - batch completed`);
    } catch {
      this.logger.warn(`[ocr.discovery] [fail] durationMs=${Date.now() - started} - inventory unavailable; retry scheduled`);
    }
  }

  private async process(candidate: Candidate): Promise<void> {
    if (candidate.bookStatus !== 'present' || candidate.format !== 'cbz' || candidate.role !== 'content') {
      const stamp = digest([candidate.bookStatus, candidate.format, candidate.role]);
      if (candidate.sourceStamp !== stamp || candidate.documentFingerprint) await this.repository.invalidateIndex(candidate.fileId, stamp, 'missing');
      return;
    }
    const before = await ocrSourceSnapshot(candidate.absolutePath);
    const indexMatches =
      candidate.indexStatus === 'indexed'
        ? candidate.documentFingerprint !== null && candidate.indexedFingerprint === candidate.documentFingerprint
        : candidate.documentFingerprint === null;
    if (before.stamp === candidate.sourceStamp && indexMatches) return;
    if (before.status !== 'present') {
      await this.repository.invalidateIndex(candidate.fileId, before.stamp, before.status);
      return;
    }
    let loaded;
    try {
      const sidecar = await readOcrSidecar(candidate.absolutePath);
      if (!sidecar) {
        const after = await ocrSourceSnapshot(candidate.absolutePath);
        if (after.status === 'missing') await this.repository.invalidateIndex(candidate.fileId, after.stamp, 'missing');
        return;
      }
      const archive = await validateOcrArchive(candidate.absolutePath, sidecar.document, sidecar.fingerprint);
      loaded = { document: sidecar.document, fingerprint: archive.fingerprint };
    } catch (error) {
      if (!(error instanceof OcrValidationError) && !isMissing(error)) throw error;
      const after = await ocrSourceSnapshot(candidate.absolutePath);
      // Never cache a failure for a moving target: the next sweep must retry the stable revision.
      if (before.stamp !== after.stamp) return;
      await this.repository.invalidateIndex(candidate.fileId, after.stamp, after.status === 'missing' ? 'missing' : 'invalid');
      this.logger.warn(`[ocr.discovery] [fail] fileId=${candidate.fileId} - invalid or missing OCR source`);
      return;
    }
    const after = await ocrSourceSnapshot(candidate.absolutePath);
    if (this.stopping || after.stamp !== before.stamp || after.status !== 'present') return;
    await this.repository.replace(candidate.fileId, loaded.document, loaded.fingerprint, after.stamp);
    this.logger.log(`[ocr.discovery] [end] fileId=${candidate.fileId} - OCR index updated`);
  }
}
