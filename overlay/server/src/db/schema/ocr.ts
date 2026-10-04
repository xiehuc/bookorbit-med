import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { bookFiles } from './books';

// OCR belongs to a library file; access must follow the parent book's library and content restrictions.
export const ocrDocuments = pgTable('ocr_documents', {
  fileId: integer('file_id')
    .primaryKey()
    .references(() => bookFiles.id, { onDelete: 'cascade' }),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  pageCount: integer('page_count').notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ocrIndexState = pgTable('ocr_index_state', {
  fileId: integer('file_id')
    .primaryKey()
    .references(() => bookFiles.id, { onDelete: 'cascade' }),
  sourceStamp: varchar('source_stamp', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).$type<'indexed' | 'missing' | 'invalid'>().notNull(),
  indexedFingerprint: varchar('indexed_fingerprint', { length: 64 }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ocrPages = pgTable(
  'ocr_pages',
  {
    fileId: integer('file_id')
      .notNull()
      .references(() => ocrDocuments.fileId, { onDelete: 'cascade' }),
    page: integer('page').notNull(),
    source: text('source').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.page] })],
);

export const ocrBlocks = pgTable(
  'ocr_blocks',
  {
    fileId: integer('file_id')
      .notNull()
      .references(() => ocrDocuments.fileId, { onDelete: 'cascade' }),
    page: integer('page').notNull(),
    blockId: integer('block_id').notNull(),
    text: text('text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    // Explicit character bigrams support two-character CJK substrings without requiring a dictionary.
    searchGrams: text('search_grams').array().notNull(),
    bbox: jsonb('bbox').$type<[number, number, number, number] | null>(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.page, t.blockId] }), index('ocr_blocks_search_grams_idx').using('gin', t.searchGrams)],
);
