import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOcrSidecar } from './ocr-sidecar';

const document = {
  version: 1,
  document_id: 'synthetic',
  source_cbz: 'sample.cbz',
  page_count: 1,
  pages: [{ page: 1, source: '001.avif', width: 100, height: 100, blocks: [] }],
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bookorbit-ocr-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('OCR sidecar loading', () => {
  it('returns null when no JSON is present', async () => {
    expect(await readOcrSidecar(join(root, 'sample.cbz'))).toBeNull();
  });
  it('reads a paired document with a stable content fingerprint', async () => {
    await writeFile(join(root, 'sample.ocr.json'), JSON.stringify(document));
    const result = await readOcrSidecar(join(root, 'sample.cbz'));
    expect(result?.document.pages).toHaveLength(1);
    expect(result?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects a different CBZ name rather than silently attaching OCR', async () => {
    await writeFile(join(root, 'other.ocr.json'), JSON.stringify(document));
    await expect(readOcrSidecar(join(root, 'other.cbz'))).rejects.toThrow('CBZ filename mismatch');
  });
  it('does not disclose malformed input', async () => {
    await writeFile(join(root, 'sample.ocr.json'), 'sensitive broken JSON');
    await expect(readOcrSidecar(join(root, 'sample.cbz'))).rejects.toThrow('malformed JSON');
  });
  it('rejects a symlink escaping the book directory', async () => {
    await symlink('/etc/hosts', join(root, 'sample.ocr.json'));
    await expect(readOcrSidecar(join(root, 'sample.cbz'))).rejects.toThrow('sidecar escapes');
  });
});
