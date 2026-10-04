import { Inject, Injectable } from '@nestjs/common';
import { and, arrayContains, asc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookFiles, bookMetadata, books, ocrBlocks, ocrDocuments, ocrIndexState, ocrPages } from '../../db/schema';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import type { RequestUser } from '../../common/types/request-user';
import type { OcrDocument } from './ocr-document';
import { normalizeOcrText, ocrPlainText, ocrSearchGrams } from './ocr-search-text';

@Injectable()
export class OcrRepository {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  async replace(fileId: number, document: OcrDocument, fingerprint: string, sourceStamp?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Serialize concurrent replacements for one existing file, including its first import.
      await tx.select({ id: bookFiles.id }).from(bookFiles).where(eq(bookFiles.id, fileId)).for('update');
      await tx.delete(ocrDocuments).where(eq(ocrDocuments.fileId, fileId));
      await tx.insert(ocrDocuments).values({ fileId, fingerprint, pageCount: document.pages.length });
      if (sourceStamp) {
        const state = { fileId, sourceStamp, status: 'indexed' as const, indexedFingerprint: fingerprint, checkedAt: new Date() };
        await tx.insert(ocrIndexState).values(state).onConflictDoUpdate({ target: ocrIndexState.fileId, set: state });
      } else {
        await tx.delete(ocrIndexState).where(eq(ocrIndexState.fileId, fileId));
      }
      for (const page of document.pages) {
        await tx.insert(ocrPages).values({ fileId, page: page.page, source: page.source, width: page.width, height: page.height });
        for (let start = 0; start < page.blocks.length; start += 100) {
          await tx.insert(ocrBlocks).values(
            page.blocks.slice(start, start + 100).map((block) => {
              const text = ocrPlainText(block.text);
              return {
                fileId,
                page: page.page,
                blockId: block.id,
                text,
                normalizedText: normalizeOcrText(text),
                searchGrams: ocrSearchGrams(text),
                bbox: block.bbox,
              };
            }),
          );
        }
      }
    });
  }

  /** Internal maintenance worker only: never expose this unscoped inventory through an API. */
  async indexCandidates(afterFileId: number, limit: number) {
    return this.db
      .select({
        fileId: bookFiles.id,
        absolutePath: bookFiles.absolutePath,
        format: bookFiles.format,
        role: bookFiles.role,
        bookStatus: books.status,
        sourceStamp: ocrIndexState.sourceStamp,
        indexStatus: ocrIndexState.status,
        indexedFingerprint: ocrIndexState.indexedFingerprint,
        documentFingerprint: ocrDocuments.fingerprint,
      })
      .from(bookFiles)
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .leftJoin(ocrIndexState, eq(ocrIndexState.fileId, bookFiles.id))
      .leftJoin(ocrDocuments, eq(ocrDocuments.fileId, bookFiles.id))
      .where(
        and(
          gt(bookFiles.id, afterFileId),
          or(and(eq(bookFiles.format, 'cbz'), eq(bookFiles.role, 'content')), isNotNull(ocrIndexState.fileId), isNotNull(ocrDocuments.fileId)),
        ),
      )
      .orderBy(asc(bookFiles.id))
      .limit(Math.min(100, Math.max(1, limit)));
  }

  async invalidateIndex(fileId: number, sourceStamp: string, status: 'missing' | 'invalid'): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [file] = await tx.select({ id: bookFiles.id }).from(bookFiles).where(eq(bookFiles.id, fileId)).for('update');
      if (!file) return;
      await tx.delete(ocrDocuments).where(eq(ocrDocuments.fileId, fileId));
      const state = { fileId, sourceStamp, status, indexedFingerprint: null, checkedAt: new Date() };
      await tx.insert(ocrIndexState).values(state).onConflictDoUpdate({ target: ocrIndexState.fileId, set: state });
    });
  }

  async remove(fileId: number): Promise<void> {
    await this.db.delete(ocrDocuments).where(eq(ocrDocuments.fileId, fileId));
  }

  async fingerprint(fileId: number): Promise<string | null> {
    const [row] = await this.db.select({ fingerprint: ocrDocuments.fingerprint }).from(ocrDocuments).where(eq(ocrDocuments.fileId, fileId));
    return row?.fingerprint ?? null;
  }

  async search(user: RequestUser, accessibleLibraryIds: number[], query: string, offset: number, limit: number) {
    if (!accessibleLibraryIds.length) return [];
    const normalized = normalizeOcrText(query);
    const grams = ocrSearchGrams(query);
    if (!grams.length) return [];
    const filters = user.isSuperuser ? [] : buildContentFilterClauses(user.contentFilters, this.db);
    return this.db
      .select({
        fileId: ocrBlocks.fileId,
        bookId: books.id,
        title: bookMetadata.title,
        page: ocrBlocks.page,
        blockId: ocrBlocks.blockId,
        text: ocrBlocks.text,
        bbox: ocrBlocks.bbox,
        fingerprint: ocrDocuments.fingerprint,
      })
      .from(ocrBlocks)
      .innerJoin(ocrDocuments, eq(ocrDocuments.fileId, ocrBlocks.fileId))
      .innerJoin(bookFiles, eq(bookFiles.id, ocrBlocks.fileId))
      .innerJoin(books, eq(books.id, bookFiles.bookId))
      .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
      .where(
        and(
          inArray(books.libraryId, accessibleLibraryIds),
          eq(books.status, 'present'),
          arrayContains(ocrBlocks.searchGrams, grams),
          sql`strpos(${ocrBlocks.normalizedText}, ${normalized}) > 0`,
          ...filters,
        ),
      )
      .orderBy(asc(ocrBlocks.fileId), asc(ocrBlocks.page), asc(ocrBlocks.blockId))
      .offset(offset)
      .limit(limit);
  }
}
