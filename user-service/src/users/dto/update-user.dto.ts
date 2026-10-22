import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

// role and banned are deliberately absent: they change only through the
// admin-guarded role and ban endpoints. avatarUrl comes from Google only: other
// users' browsers load it, so a member-chosen URL could track who views it.
export class UpdateUserDto {
  // Names are required columns, so null must be rejected rather than skipped.
  @ValidateIf((dto: UpdateUserDto) => dto.firstName !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ValidateIf((dto: UpdateUserDto) => dto.lastName !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  preferredName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  yogaExperience?: string | null;
}
