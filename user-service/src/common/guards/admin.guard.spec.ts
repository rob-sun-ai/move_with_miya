import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../generated/prisma/client', () => ({
  UserRole: { ADMIN: 'ADMIN' },
}));

import { AdminGuard } from './admin.guard';

describe('UserService AdminGuard', () => {
  const context = (userId?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ session: userId ? { userId } : {} }),
      }),
    }) as never;

  it('rejects unauthenticated requests', async () => {
    const guard = new AdminGuard({} as never);
    await expect(guard.canActivate(context())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('treats a session whose account was deleted as unauthenticated', async () => {
    const usersService = {
      findById: jest.fn().mockRejectedValue(new NotFoundException()),
    };
    await expect(
      new AdminGuard(usersService as never).canActivate(context('gone')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects banned and non-admin users', async () => {
    const usersService = { findById: jest.fn() };
    const guard = new AdminGuard(usersService as never);
    usersService.findById.mockResolvedValue({ banned: true, role: 'ADMIN' });
    await expect(guard.canActivate(context('user-1'))).rejects.toThrow(
      'User is banned',
    );
    usersService.findById.mockResolvedValue({ banned: false, role: 'MEMBER' });
    await expect(guard.canActivate(context('user-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows an active admin', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue({ banned: false, role: 'ADMIN' }),
    };
    await expect(
      new AdminGuard(usersService as never).canActivate(context('admin-1')),
    ).resolves.toBe(true);
  });
});
