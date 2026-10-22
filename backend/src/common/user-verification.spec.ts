import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  fetchActiveUser,
  fetchUserSummaries,
  userServiceUrl,
} from './user-verification';

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

describe('userServiceUrl', () => {
  it.each([
    ['configured', 'http://users:3001', 'http://users:3001'],
    ['blank', '', 'http://localhost:3003'],
    ['unset', undefined, 'http://localhost:3003'],
  ])('uses the %s value', (_label, configured, expected) => {
    expect(userServiceUrl(configured)).toBe(expected);
  });
});

describe('fetchUserSummaries', () => {
  afterEach(() => jest.restoreAllMocks());

  it('looks up the ids in one escaped batch request', async () => {
    const users = [{ id: 'u1', firstName: 'A', lastName: 'B', role: 'MEMBER' }];
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(users)));

    await expect(
      fetchUserSummaries('http://users.test', ['u1', 'u&2']),
    ).resolves.toEqual(users);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://users.test/users/batch?ids=u1%2Cu%262',
      { cache: 'no-store', signal: expect.any(AbortSignal) as unknown },
    );
  });

  it('skips the request when there is nobody to look up', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(fetchUserSummaries('http://users.test', [])).resolves.toEqual(
      [],
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['fails', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['is unreachable', () => Promise.reject(new Error('ECONNREFUSED'))],
  ])('returns no profiles when the user service %s', async (_label, reply) => {
    jest.spyOn(global, 'fetch').mockImplementation(reply);

    await expect(
      fetchUserSummaries('http://users.test', ['u1']),
    ).resolves.toEqual([]);
  });
});
