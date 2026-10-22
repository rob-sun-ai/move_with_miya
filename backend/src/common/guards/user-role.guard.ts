import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { UserRole } from '../enums/user-role';
import { fetchActiveUser, userServiceUrl } from '../user-verification';

/**
 * Admits signed-in, non-banned users whose current role (looked up in the
 * user service on every request, so demotions and bans apply immediately) is
 * one of `allowedRoles`.
 */
@Injectable()
export abstract class UserRoleGuard implements CanActivate {
  protected abstract readonly allowedRoles: readonly UserRole[];
  protected abstract readonly forbiddenMessage: string;

  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Not authenticated');
    }

    const user = await fetchActiveUser(
      userServiceUrl(this.configService.get<string>('USER_SERVICE_URL')),
      userId,
    );
    if (!this.allowedRoles.some((role) => role === user.role)) {
      throw new ForbiddenException(this.forbiddenMessage);
    }
    return true;
  }
}
