import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { fetchActiveUser } from './user-verification';

describe('fetchActiveUser', () => {
  afterEach(() => jest.restoreAllMocks());

  function respond(body: unknown, status = 200) {
    return jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }

  it('returns an active user and escapes the id in the URL', async () => {
    const fetchMock = respond({ banned: false, yogaExperience: 'Beginner' });

    await expect(
      fetchActiveUser('http://users.test', 'user/1?x'),
    ).resolves.toEqual({ banned: false, yogaExperience: 'Beginner' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://users.test/users/user%2F1%3Fx',
      { signal: expect.any(AbortSignal) as unknown },
    );
  });

  it('reports an unreachable user service', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchActiveUser('http://users.test', 'u')).rejects.toEqual(
      new ServiceUnavailableException('User service unreachable'),
    );
  });

  it.each([500, 503])('reports a failing user service (%p)', async (status) => {
    respond({}, status);

    await expect(fetchActiveUser('http://users.test', 'u')).rejects.toEqual(
      new ServiceUnavailableException('User service error'),
    );
  });

  it.each([401, 404])(
    'rejects a user it cannot verify (%p)',
    async (status) => {
      respond({}, status);

      await expect(fetchActiveUser('http://users.test', 'u')).rejects.toEqual(
        new UnauthorizedException('Unable to verify user'),
      );
    },
  );

  it('rejects a banned user', async () => {
    respond({ banned: true });

    await expect(fetchActiveUser('http://users.test', 'u')).rejects.toEqual(
      new ForbiddenException('User is banned'),
    );
  });
});
