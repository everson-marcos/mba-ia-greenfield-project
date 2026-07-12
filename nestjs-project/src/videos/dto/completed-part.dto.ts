import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CompletedPartDto {
  @IsInt()
  @IsPositive()
  partNumber: number;

  @IsString()
  @IsNotEmpty()
  eTag: string;
}
