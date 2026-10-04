import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class OcrSearchDto {
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  offset = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  libraryId?: number;
}

export class OcrHitDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  block!: number;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  revision!: string;
}

export class OcrRevisionDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  revision?: string;
}
