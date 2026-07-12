import { Type } from 'class-transformer';
import { IsInt, IsPositive } from 'class-validator';

export class UploadPartUrlQueryDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  partNumber: number;
}
