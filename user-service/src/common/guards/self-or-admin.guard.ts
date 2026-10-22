import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from '../../users/users.service';
import { UserRole } from '../../generated/prisma/client';
import { loadActiveSessionUser } from '../session-user';

@Injectable()
export class SelfOrAdminGuard implements CanActivate {
  constructor(private readonly usersService: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const sessionUser = await loadActiveSessionUser(this.usersService, request);

    if (sessionUser.id === request.params.id) return true;

    if (sessionUser.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
