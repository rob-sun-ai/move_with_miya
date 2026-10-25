import { ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';
import { StaffGuard } from './staff.guard';

describe('backend access guards', () => {
  const context = (userId?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ session: userId ? { userId } : {} }),
      }),
    }) as never;

  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  beforeEach(() => jest.restoreAllMocks());

  describe.each([
    ['admin', AdminGuard, 'Admin access required', ['ADMIN']],
    ['staff', StaffGuard, 'Staff access required', ['ADMIN', 'TEACHER']],
  ])('%s guard', (_name, Guard, forbiddenMessage, allowedRoles) => {
    const makeGuard = () =>
      new Guard(new ConfigService({ USER_SERVICE_URL: 'http://users.test' }));

    it('rejects requests without a session user', async () => {
      await expect(makeGuard().canActivate(context())).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('returns service unavailable when user lookup cannot be reached', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

      await expect(makeGuard().canActivate(context('user-1'))).rejects.toThrow(
        'User service unreachable',
      );
    });

    it('maps downstream server failures to service unavailable', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(response({}, 503));

      await expect(makeGuard().canActivate(context('user-1'))).rejects.toThrow(
        'User service error',
      );
    });

    it('rejects an unverified user', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(response({}, 404));

      await expect(makeGuard().canActivate(context('user-1'))).rejects.toThrow(
        'Unable to verify user',
      );
    });

    it('rejects banned users before checking their role', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(response({ role: allowedRoles[0], banned: true }));

      await expect(makeGuard().canActivate(context('user-1'))).rejects.toThrow(
        'User is banned',
      );
    });

    it('rejects users without the required role', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(response({ role: 'MEMBER', banned: false }));

      await expect(makeGuard().canActivate(context('user-1'))).rejects.toThrow(
        forbiddenMessage,
      );
    });

    it.each(allowedRoles)('allows %s users', async (role) => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(response({ role, banned: false }));

      await expect(makeGuard().canActivate(context('user-1'))).resolves.toBe(
        true,
      );
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'http://users.test/users/user-1',
      );
    });
  });
});
