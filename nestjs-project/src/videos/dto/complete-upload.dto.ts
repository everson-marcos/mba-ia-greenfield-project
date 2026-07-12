import { Type } from 'class-transformer';
import { ArrayMinSize, ValidateNested } from 'class-validator';
import { CompletedPartDto } from './completed-part.dto';

export class CompleteUploadDto {
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
