import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelClassDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
