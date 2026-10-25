import { Injectable } from '@nestjs/common';
import { UserRole } from '../enums/user-role';
import { UserRoleGuard } from './user-role.guard';

@Injectable()
export class AdminGuard extends UserRoleGuard {
  protected readonly allowedRoles = [UserRole.ADMIN];
  protected readonly forbiddenMessage = 'Admin access required';
}
