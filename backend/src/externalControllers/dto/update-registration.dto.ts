import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The only registration field an admin may edit directly. Status, class,
 * user, and lifecycle timestamps change only through the registration and
 * cancellation flows, which enforce capacity and payment rules.
 */
export class UpdateRegistrationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancellationReason?: string;
}
