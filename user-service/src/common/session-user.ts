import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../generated/prisma/client';
import type { UsersService } from '../users/users.service';

/** Loads the signed-in user. A session whose account was deleted is unauthenticated. */
export async function loadSessionUser(
  usersService: UsersService,
  request: Request,
): Promise<User> {
  const userId = request.session?.userId;
  if (!userId) throw new UnauthorizedException('Not authenticated');
  try {
    return await usersService.findById(userId);
  } catch (error) {
    if (error instanceof NotFoundException) {
      throw new UnauthorizedException('Not authenticated');
    }
    throw error;
  }
}

/** Loads the signed-in user and rejects banned accounts. */
export async function loadActiveSessionUser(
  usersService: UsersService,
  request: Request,
): Promise<User> {
  const user = await loadSessionUser(usersService, request);
  if (user.banned) throw new ForbiddenException('User is banned');
  return user;
}
