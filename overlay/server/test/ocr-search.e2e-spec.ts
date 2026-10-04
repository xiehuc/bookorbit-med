import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { OcrHit, OcrManifest, OcrSearchResponse } from '@bookorbit/types';
import {
  authHeader,
  closeReaderStateIsolationE2EContext,
  createLibraryWithFolder,
  createReaderStateIsolationE2EContext,
  createUserAndLogin,
  grantLibraryAccess,
  locateBookByAbsolutePath,
  triggerAndWaitForLibraryScan,
  type LocatedBookFile,
  type ReaderStateIsolationE2EContext,
  type TestUserSession,
} from './e2e/reader-state-isolation/reader-state-isolation-harness';
import { createZipArchiveFixture } from './e2e/reader-state-isolation/reader-state-isolation-fixture-builder';

type InjectResponse = Awaited<ReturnType<ReaderStateIsolationE2EContext['app']['inject']>>;

function responseBuffer(response: InjectResponse): Buffer {
  const rawPayload = (response as unknown as { rawPayload?: unknown }).rawPayload;
  return Buffer.isBuffer(rawPayload) ? rawPayload : Buffer.from(response.body, 'binary');
}

/** All files, pixel data, and OCR below are synthetic; no case data enters this fixture. */
function canonicalDocument(marker: string) {
  return {
    version: 1,
    document_id: marker,
    source_cbz: 'synthetic.cbz',
    page_count: 2,
    pages: [
      { page: 1, source: 'pages/001.png', width: 100, height: 200, blocks: [{ id: 0, text: 'Synthetic cover', bbox: [1, 2, 80, 30] }] },
      {
        page: 2,
        source: 'pages/002.png',
        width: 120,
        height: 240,
        blocks: [
          { id: 10, text: `${marker} 牙周炎 first synthetic block`, bbox: [10, 20, 100, 60] },
          { id: 20, text: `${marker} 牙周炎 second synthetic block`, bbox: [15, 100, 90, 140] },
        ],
      },
    ],
  };
}

describe('OCR full-text evidence HTTP integration (e2e)', { timeout: 120_000 }, () => {
  let ctx!: ReaderStateIsolationE2EContext;
  let library!: Awaited<ReturnType<typeof createLibraryWithFolder>>;
  let file!: LocatedBookFile;
  let viewer!: TestUserSession;
  let outsider!: TestUserSession;
  let pageBytes!: Buffer;
  let sidecarPath!: string;
  let fingerprint!: string;
  const marker = `ocr-${randomUUID()}`;

  beforeAll(async () => {
    ctx = await createReaderStateIsolationE2EContext();
    library = await createLibraryWithFolder(ctx, { name: marker, allowedFormats: ['cbz'] });
    const cover = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    pageBytes = await sharp({ create: { width: 120, height: 240, channels: 3, background: '#eeeeee' } })
      .png()
      .toBuffer();
    const path = await createZipArchiveFixture(library.folderPath, 'synthetic/synthetic.cbz', [
      { path: 'pages/001.png', content: cover },
      { path: 'pages/002.png', content: pageBytes },
      { path: '__MACOSX/._001.png', content: 'synthetic metadata, not an image' },
    ]);
    sidecarPath = path.replace(/\.cbz$/, '.ocr.json');
    await writeFile(sidecarPath, JSON.stringify(canonicalDocument(marker)));
    await triggerAndWaitForLibraryScan(ctx, library.libraryId);
    file = await locateBookByAbsolutePath(ctx, path);
    viewer = await createUserAndLogin(ctx);
    outsider = await createUserAndLogin(ctx);
    await grantLibraryAccess(ctx, viewer.userId, library.libraryId, 'viewer');
  }, 90_000);

  afterAll(async () => {
    if (ctx) await closeReaderStateIsolationE2EContext(ctx);
  });

  it('indexes a scanned file as administrator, idempotently, and denies viewer indexing', async () => {
    const request = { method: 'POST' as const, url: `/api/v1/ocr/files/${file.bookFileId}/index` };
    const denied = await ctx.app.inject({ ...request, headers: authHeader(viewer.accessToken) });
    expect(denied.statusCode).toBe(403);
    const indexed = await ctx.app.inject({ ...request, headers: authHeader(ctx.adminToken) });
    expect(indexed.statusCode).toBe(201);
    expect(indexed.json()).toMatchObject({ fileId: file.bookFileId, pageCount: 2, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    fingerprint = indexed.json<{ fingerprint: string }>().fingerprint;
    const repeated = await ctx.app.inject({ ...request, headers: authHeader(ctx.adminToken) });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json()).toEqual(indexed.json());
  });

  it('finds both same-word blocks and two-character Chinese substrings with pagination', async () => {
    for (const q of ['牙周炎', '牙周']) {
      const query = new URLSearchParams({ q, libraryId: String(library.libraryId) });
      const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/ocr/search?${query}`, headers: authHeader(viewer.accessToken) });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const result = response.json<OcrSearchResponse>();
      expect(result.items.map((item) => item.blockId)).toEqual([10, 20]);
      expect(result.items.every((item) => item.fileId === file.bookFileId && item.page === 2 && item.fingerprint === fingerprint)).toBe(true);
      expect(result.hasMore).toBe(false);
    }
    const query = new URLSearchParams({ q: '牙周', libraryId: String(library.libraryId), limit: '1' });
    const first = await ctx.app.inject({ method: 'GET', url: `/api/v1/ocr/search?${query}`, headers: authHeader(viewer.accessToken) });
    expect(first.json<OcrSearchResponse>()).toMatchObject({ items: [{ blockId: 10 }], hasMore: true });
    query.set('offset', '1');
    const second = await ctx.app.inject({ method: 'GET', url: `/api/v1/ocr/search?${query}`, headers: authHeader(viewer.accessToken) });
    expect(second.json<OcrSearchResponse>()).toMatchObject({ items: [{ blockId: 20 }], hasMore: false });
  });

  it('returns exact page dimensions, selected block bounds, and unchanged PNG bytes', async () => {
    const manifest = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/ocr/files/${file.bookFileId}/manifest`,
      headers: authHeader(viewer.accessToken),
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json<OcrManifest>()).toEqual({
      fileId: file.bookFileId,
      bookId: file.bookId,
      fingerprint,
      pages: [
        { page: 1, source: 'pages/001.png', width: 100, height: 200 },
        { page: 2, source: 'pages/002.png', width: 120, height: 240 },
      ],
    });
    for (const [block, bbox] of [
      [10, [10, 20, 100, 60]],
      [20, [15, 100, 90, 140]],
    ] as const) {
      const hit = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ocr/files/${file.bookFileId}/hit?page=2&block=${block}&revision=${fingerprint}`,
        headers: authHeader(viewer.accessToken),
      });
      expect(hit.statusCode).toBe(200);
      expect(hit.json<OcrHit>()).toMatchObject({ page: 2, blockId: block, bbox, fingerprint });
    }
    const image = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/ocr/files/${file.bookFileId}/pages/2?revision=${fingerprint}`,
      headers: authHeader(viewer.accessToken),
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(responseBuffer(image).equals(pageBytes)).toBe(true);
  });

  it('does not leak hits or source bytes to an unrelated user or anonymous client', async () => {
    const search = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/ocr/search?q=${encodeURIComponent(marker)}`,
      headers: authHeader(outsider.accessToken),
    });
    expect(search.statusCode).toBe(200);
    expect(search.json<OcrSearchResponse>()).toEqual({ items: [], hasMore: false });
    for (const suffix of ['manifest', `hit?page=2&block=10&revision=${fingerprint}`, `pages/2?revision=${fingerprint}`]) {
      const url = `/api/v1/ocr/files/${file.bookFileId}/${suffix}`;
      const denied = await ctx.app.inject({ method: 'GET', url, headers: authHeader(outsider.accessToken) });
      expect([403, 404]).toContain(denied.statusCode);
      expect(denied.body).not.toContain(marker);
      const anonymous = await ctx.app.inject({ method: 'GET', url });
      expect(anonymous.statusCode).toBe(401);
    }
    const anonymousSearch = await ctx.app.inject({ method: 'GET', url: '/api/v1/ocr/search?q=synthetic' });
    expect(anonymousSearch.statusCode).toBe(401);
  });

  it('rejects invalid query DTOs through the real application validation pipe', async () => {
    for (const query of ['q=x', 'q=synthetic&limit=999', 'q=synthetic&offset=-1']) {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/ocr/search?${query}`, headers: authHeader(viewer.accessToken) });
      expect(response.statusCode).toBe(400);
    }
    const missingRevision = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/ocr/files/${file.bookFileId}/hit?page=2&block=10`,
      headers: authHeader(viewer.accessToken),
    });
    expect(missingRevision.statusCode).toBe(400);
  });

  it('rejects stale hit and image links after a sidecar change and allows explicit reindex', async () => {
    const revised = canonicalDocument(marker);
    revised.pages[1].blocks[0].text += ' revised';
    await writeFile(sidecarPath, JSON.stringify(revised));
    for (const suffix of [`hit?page=2&block=10&revision=${fingerprint}`, `pages/2?revision=${fingerprint}`]) {
      const stale = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ocr/files/${file.bookFileId}/${suffix}`,
        headers: authHeader(viewer.accessToken),
      });
      expect(stale.statusCode).toBe(409);
    }
    const indexed = await ctx.app.inject({ method: 'POST', url: `/api/v1/ocr/files/${file.bookFileId}/index`, headers: authHeader(ctx.adminToken) });
    expect(indexed.statusCode).toBe(201);
    const current = indexed.json<{ fingerprint: string }>().fingerprint;
    expect(current).not.toBe(fingerprint);
    const hit = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/ocr/files/${file.bookFileId}/hit?page=2&block=10&revision=${current}`,
      headers: authHeader(viewer.accessToken),
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json<OcrHit>().text).toContain('revised');
  });
});
