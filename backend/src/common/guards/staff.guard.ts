import { Injectable } from '@nestjs/common';
import { UserRole } from '../enums/user-role';
import { UserRoleGuard } from './user-role.guard';

@Injectable()
export class StaffGuard extends UserRoleGuard {
  protected readonly allowedRoles = [UserRole.ADMIN, UserRole.TEACHER];
  protected readonly forbiddenMessage = 'Staff access required';
}
