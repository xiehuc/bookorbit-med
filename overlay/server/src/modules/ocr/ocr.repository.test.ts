import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { OcrRepository } from './ocr.repository';

const user = {
  id: 7,
  isSuperuser: false,
  contentFilters: { includeTagIds: [12], includeGenreIds: [13], excludeTagIds: [14], excludeGenreIds: [15] },
} as RequestUser;
let query: ReturnType<typeof vi.fn>;
let repository: OcrRepository;

beforeEach(async () => {
  query = vi.fn().mockResolvedValue({ rows: [] });
  const db = drizzle({ client: { query } as never, schema });
  const module = await Test.createTestingModule({ providers: [OcrRepository, { provide: DB, useValue: db }] }).compile();
  repository = module.get(OcrRepository);
});

function capturedQuery() {
  const [config, params] = query.mock.calls[0] as [{ text: string }, unknown[]];
  return { text: config.text, params };
}

describe('OcrRepository compiled SQL authorization', () => {
  it('applies library scope, content exclusions and inclusions before pagination', async () => {
    await repository.search(user, [3, 5], '牙周', 20, 21);
    const { text, params } = capturedQuery();
    expect(text).toContain('"books"."library_id" in');
    expect(text).toContain('"books"."status" =');
    expect(text).toContain('"book_tags"');
    expect(text).toContain('"book_genres"');
    expect(text).toContain('not exists');
    expect(text).toContain(' or ');
    expect(text).toContain('"ocr_blocks"."search_grams" @>');
    expect(text).toContain('strpos(');
    expect(text).toMatch(/order by .*limit .*offset /);
    expect(params).toEqual(expect.arrayContaining([3, 5, 'present', '牙周', 12, 13, 14, 15, 21, 20]));
  });
  it('does not query the database when no libraries are authorized', async () => {
    expect(await repository.search(user, [], '牙周', 0, 21)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it('keeps superuser searches constrained to the supplied library scope', async () => {
    await repository.search({ ...user, isSuperuser: true }, [3], '牙周', 0, 10);
    const { text, params } = capturedQuery();
    expect(text).toContain('"books"."library_id" in');
    expect(params).toContain(3);
    expect(text).not.toContain('"book_tags"');
  });
  it('uses parameters rather than interpolating SQL or LIKE wildcards', async () => {
    const input = "%' OR 1=1 --";
    await repository.search(user, [3], input, 0, 10);
    const { text, params } = capturedQuery();
    expect(text).not.toContain(input);
    expect(text).toContain('strpos(');
    expect(params).toContain(input.toLowerCase());
  });
  it('keeps exact substring verification after gram candidate lookup', async () => {
    await repository.search(user, [3], 'ＣＲＰ', 0, 10);
    const { text, params } = capturedQuery();
    expect(text).toContain('"ocr_blocks"."normalized_text"');
    expect(text).toContain('strpos(');
    expect(params).toContain('crp');
  });
  it('does not perform an unindexed single-character scan', async () => {
    expect(await repository.search(user, [3], '牙', 0, 10)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
