import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { readCbzZipIndex, type CbzZipEntry } from '../../common/cbz-zip-reader';
import { OcrValidationError, type OcrDocument } from './ocr-document';

const IMAGE_EXT = /\.(avif|jpe?g|png|webp|gif|bmp)$/i;
export const MAX_OCR_PAGE_BYTES = 32 * 1024 * 1024;

type ArchiveState = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'dev'>;

export async function assertOcrArchiveUnchanged(path: string, before: ArchiveState): Promise<void> {
  const after = await stat(path);
  if (
    !after.isFile() ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.ino !== after.ino ||
    before.dev !== after.dev
  ) {
    throw new OcrValidationError('archive changed during validation');
  }
}

export async function validateOcrArchive(path: string, document: OcrDocument, jsonFingerprint: string) {
  const before = await stat(path);
  if (!before.isFile()) throw new OcrValidationError('CBZ is not a file');
  const index = await readCbzZipIndex(path);
  if (!index || index.entries.length > 20000) throw new OcrValidationError('invalid archive');
  const entries = new Map<string, CbzZipEntry>();
  for (const entry of index.entries) {
    if (!IMAGE_EXT.test(entry.name) || entry.name.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')) continue;
    if (entries.has(entry.name)) throw new OcrValidationError('duplicate ZIP entry');
    if (![0, 8].includes(entry.compression) || entry.uncompressedSize > MAX_OCR_PAGE_BYTES || entry.uncompressedSize <= 0) {
      throw new OcrValidationError('unsupported archive page');
    }
    entries.set(entry.name, entry);
  }
  if (entries.size !== document.pages.length || document.pages.some((page) => !entries.has(page.source))) {
    throw new OcrValidationError('archive page sources mismatch');
  }
  await assertOcrArchiveUnchanged(path, before);
  const fingerprint = createHash('sha256')
    .update(`${jsonFingerprint}:${before.size}:${before.mtimeMs}:${before.ctimeMs}:${before.ino}:${before.dev}`)
    .digest('hex');
  return { entries, fingerprint, archiveState: before };
}
