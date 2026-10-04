import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { OcrValidationError, parseOcrDocument } from './ocr-document';

const MAX_SIDECAR_BYTES = 32 * 1024 * 1024;

/** Only call after resolving an authorized, server-owned book file path. */
export async function readOcrSidecar(bookPath: string) {
  if (extname(bookPath).toLowerCase() !== '.cbz') throw new OcrValidationError('expected CBZ file');
  const directory = await realpath(dirname(bookPath));
  const candidate = join(directory, `${basename(bookPath, extname(bookPath))}.ocr.json`);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (dirname(resolved) !== directory) throw new OcrValidationError('sidecar escapes book directory');
  const handle = await open(resolved, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > MAX_SIDECAR_BYTES) throw new OcrValidationError('invalid sidecar size');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new OcrValidationError('sidecar changed during read');
    const content = bytes.subarray(0, offset);
    let json: unknown;
    try {
      json = JSON.parse(content.toString('utf8'));
    } catch {
      throw new OcrValidationError('malformed JSON');
    }
    const document = parseOcrDocument(json);
    if (document.sourceCbz !== basename(bookPath)) throw new OcrValidationError('CBZ filename mismatch');
    return { document, fingerprint: createHash('sha256').update(content).digest('hex') };
  } finally {
    await handle.close();
  }
}
