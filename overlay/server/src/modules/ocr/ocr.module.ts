import { Module } from '@nestjs/common';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { OcrController } from './ocr.controller';
import { OcrRepository } from './ocr.repository';
import { OcrService } from './ocr.service';
import { OcrIndexerService } from './ocr-indexer.service';

@Module({
  imports: [BookModule, LibraryModule],
  controllers: [OcrController],
  providers: [OcrRepository, OcrService, OcrIndexerService],
})
export class OcrModule {}
