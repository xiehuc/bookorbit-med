import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import sharp from 'sharp';
import type { OcrHit, OcrManifest, OcrSearchResponse } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { createCbzZipEntryReadStream } from '../../common/cbz-zip-reader';
import { imageContentTypeFromPath } from '../../common/image-content-type';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { OcrRepository } from './ocr.repository';
import { readOcrSidecar } from './ocr-sidecar';
import { OcrValidationError } from './ocr-document';
import { assertOcrArchiveUnchanged, MAX_OCR_PAGE_BYTES, validateOcrArchive } from './ocr-archive';
import { OcrHitDto, OcrSearchDto } from './dto/ocr-query.dto';
import { ocrSearchSnippet } from './ocr-snippet';

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  constructor(
    private readonly books: BookService,
    private readonly libraries: LibraryService,
    private readonly repository: OcrRepository,
  ) {}

  async search(user: RequestUser, dto: OcrSearchDto): Promise<OcrSearchResponse> {
    const query = dto.q.trim();
    if (Array.from(query).length < 2) throw new BadRequestException('Enter at least two characters');
    const allowed = (await this.libraries.findAll(user)).map((library) => library.id);
    const scope = dto.libraryId === undefined ? allowed : allowed.filter((id) => id === dto.libraryId);
    const items = await this.repository.search(user, scope, query, dto.offset, dto.limit + 1);
    return {
      items: items.slice(0, dto.limit).map((item) => ({ ...item, text: ocrSearchSnippet(item.text, query) })),
      hasMore: items.length > dto.limit,
    };
  }

  private async load(fileId: number, user: RequestUser) {
    // Resolve the server-owned path only after all library/content-filter checks.
    const file = await this.books.verifyFileAccess(fileId, user);
    return this.loadSource(file);
  }

  private async loadSource(file: Awaited<ReturnType<BookService['verifyFileAccess']>>) {
    try {
      const sidecar = await readOcrSidecar(file.absolutePath);
      if (!sidecar) throw new NotFoundException('OCR document not found');
      const archive = await validateOcrArchive(file.absolutePath, sidecar.document, sidecar.fingerprint);
      return { file, document: sidecar.document, ...archive };
    } catch (error) {
      if (error instanceof OcrValidationError) throw new UnprocessableEntityException(error.message);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('Source file not found');
      throw error;
    }
  }

  async index(fileId: number, user: RequestUser) {
    const file = await this.books.verifyFileAccess(fileId, user);
    await this.libraries.verifyUserAccessLevel(user.id, file.libraryId, user.isSuperuser, 'editor');
    const start = Date.now();
    this.logger.log(`[ocr.index] [start] fileId=${fileId} userId=${user.id} - indexing started`);
    let loaded: Awaited<ReturnType<OcrService['loadSource']>>;
    try {
      loaded = await this.loadSource(file);
    } catch (error) {
      if (error instanceof UnprocessableEntityException || error instanceof NotFoundException) await this.repository.remove(fileId);
      this.logger.warn(`[ocr.index] [fail] fileId=${fileId} durationMs=${Date.now() - start} - source loading failed`);
      throw error;
    }
    try {
      if ((await this.repository.fingerprint(fileId)) !== loaded.fingerprint) {
        await this.repository.replace(fileId, loaded.document, loaded.fingerprint);
      }
      this.logger.log(`[ocr.index] [end] fileId=${fileId} durationMs=${Date.now() - start} - indexing completed`);
      return { fileId, fingerprint: loaded.fingerprint, pageCount: loaded.document.pages.length };
    } catch (error) {
      this.logger.warn(`[ocr.index] [fail] fileId=${fileId} durationMs=${Date.now() - start} - index storage failed`);
      throw error;
    }
  }

  async manifest(fileId: number, user: RequestUser): Promise<OcrManifest> {
    const loaded = await this.load(fileId, user);
    return {
      fileId,
      bookId: loaded.file.bookId,
      fingerprint: loaded.fingerprint,
      pages: loaded.document.pages.map(({ page, source, width, height }) => ({ page, source, width, height })),
    };
  }

  async hit(fileId: number, user: RequestUser, dto: OcrHitDto): Promise<OcrHit> {
    const loaded = await this.load(fileId, user);
    if (dto.revision !== loaded.fingerprint) throw new ConflictException('OCR source changed; refresh search results');
    const page = loaded.document.pages[dto.page - 1];
    const block = page?.blocks.find((block) => block.id === dto.block);
    if (!block) throw new NotFoundException('OCR block not found');
    return { page: dto.page, blockId: block.id, bbox: block.bbox, text: block.text, fingerprint: loaded.fingerprint };
  }

  async image(fileId: number, pageNumber: number, user: RequestUser, revision?: string) {
    const loaded = await this.load(fileId, user);
    if (revision && revision !== loaded.fingerprint) throw new ConflictException('OCR source changed; reload reader');
    const page = loaded.document.pages[pageNumber - 1];
    if (!page) throw new NotFoundException('OCR page not found');
    const entry = loaded.entries.get(page.source)!;
    const stream = createCbzZipEntryReadStream(loaded.file.absolutePath, entry);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_OCR_PAGE_BYTES) {
        // Throwing out of for-await closes the stream iterator and destroys Node Readable streams.
        throw new UnprocessableEntityException('Page exceeds size limit');
      }
      chunks.push(bytes);
    }
    const buffer = Buffer.concat(chunks);
    const metadata = await sharp(buffer, { limitInputPixels: 100000000 }).metadata();
    if (metadata.width !== page.width || metadata.height !== page.height || (metadata.orientation && metadata.orientation !== 1)) {
      throw new UnprocessableEntityException('OCR dimensions or orientation do not match the original page');
    }
    try {
      await assertOcrArchiveUnchanged(loaded.file.absolutePath, loaded.archiveState);
    } catch (error) {
      if (error instanceof OcrValidationError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConflictException('OCR source changed while reading; reload reader');
      }
      throw error;
    }
    return { buffer, mimeType: imageContentTypeFromPath(page.source) };
  }
}
