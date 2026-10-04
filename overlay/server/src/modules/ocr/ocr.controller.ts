import { Permission } from '@bookorbit/types';
import { Controller, Get, Header, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { OcrHitDto, OcrRevisionDto, OcrSearchDto } from './dto/ocr-query.dto';
import { OcrService } from './ocr.service';

@Controller('ocr')
export class OcrController {
  constructor(private readonly service: OcrService) {}

  @Get('search')
  @Header('Cache-Control', 'private, no-store')
  search(@CurrentUser() user: RequestUser, @Query() dto: OcrSearchDto) {
    return this.service.search(user, dto);
  }

  @Post('files/:fileId/index')
  @RequirePermission(Permission.ManageLibraries)
  index(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.index(fileId, user);
  }

  @Get('files/:fileId/manifest')
  @Header('Cache-Control', 'private, no-store')
  manifest(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser) {
    return this.service.manifest(fileId, user);
  }

  @Get('files/:fileId/hit')
  @Header('Cache-Control', 'private, no-store')
  hit(@Param('fileId', ParseIntPipe) fileId: number, @CurrentUser() user: RequestUser, @Query() dto: OcrHitDto) {
    return this.service.hit(fileId, user, dto);
  }

  @Get('files/:fileId/pages/:page')
  async image(
    @Param('fileId', ParseIntPipe) fileId: number,
    @Param('page', ParseIntPipe) page: number,
    @CurrentUser() user: RequestUser,
    @Query() dto: OcrRevisionDto,
    @Res() reply: FastifyReply,
  ) {
    const image = await this.service.image(fileId, page, user, dto.revision);
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').type(image.mimeType).send(image.buffer);
  }
}
