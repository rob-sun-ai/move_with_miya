import {
  ConflictException,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

jest.mock('../users/users.service', () => ({ UsersService: class {} }));

describe('AuthService', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  }

  const oauthConfig = {
    get: jest.fn(
      (key: string) =>
        ({
          GOOGLE_CLIENT_ID: 'client-id',
          GOOGLE_CLIENT_SECRET: 'client-secret',
          GOOGLE_CALLBACK_URL: 'http://localhost:5173/callback',
        })[key],
    ),
  };

  const profile = {
    sub: 'google-1',
    email: 'person@example.com',
    given_name: 'Move',
    family_name: 'Miya',
    picture: 'https://example.com/avatar.jpg',
  };

  it('builds a Google authorization URL with the CSRF state', () => {
    const config = {
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CALLBACK_URL: 'http://localhost:5173/callback',
    };
    const configService = {
      get: jest.fn((key: string) => config[key as keyof typeof config]),
    };
    const service = new AuthService({} as never, configService as never);

    const url = new URL(service.getGoogleAuthURL('state-1'));

    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/callback',
    );
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    // Sign-in never uses a refresh token, so it must not ask for one.
    expect(url.searchParams.has('access_type')).toBe(false);
  });

  it('exchanges an authorization code for an access token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'token' }));
    const service = new AuthService({} as never, oauthConfig as never);

    await expect(service.exchangeCode('code-1')).resolves.toEqual({
      accessToken: 'token',
    });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.body.get('code')).toBe('code-1');
    expect(init.body.get('client_secret')).toBe('client-secret');
  });

  it('does not echo Google token errors to the browser', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'invalid_grant', detail: 'internal-detail' }, 400),
    );
    const service = new AuthService({} as never, oauthConfig as never);

    const error = await service.exchangeCode('code-1').catch((e: Error) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as Error).message).toBe('Google sign-in failed');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('internal-detail'),
    );
    warn.mockRestore();
  });

  it('reads the OpenID profile, keyed by its stable subject', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...profile, email_verified: true }),
    );
    const service = new AuthService({} as never, {} as never);

    await expect(service.fetchGoogleProfile('token')).resolves.toEqual(profile);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { Authorization: 'Bearer token' } },
    );
  });

  it.each([
    ['no subject', { ...profile, sub: undefined, email_verified: true }],
    ['a legacy v2 id instead of sub', { id: '1', email: 'a@b.test' }],
    ['no email', { ...profile, email: '', email_verified: true }],
    ['an unverified email', { ...profile, email_verified: false }],
  ])('rejects a Google profile with %s', async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    const service = new AuthService({} as never, {} as never);

    await expect(service.fetchGoogleProfile('token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('requires OAuth configuration', () => {
    const configService = { get: jest.fn(() => undefined) };
    const service = new AuthService({} as never, configService as never);

    expect(() => service.getGoogleAuthURL('state-1')).toThrow(
      'GOOGLE_CLIENT_ID is not configured',
    );
  });

  it('updates the last login for an existing Google user', async () => {
    const existing = { id: 'user-1', banned: false };
    const usersService = {
      findByGoogleId: jest.fn().mockResolvedValue(existing),
      updateLastLogin: jest
        .fn()
        .mockResolvedValue({ ...existing, lastLoginAt: new Date() }),
      create: jest.fn(),
    };
    const service = new AuthService(usersService as never, {} as never);

    await expect(service.findOrCreateUser(profile)).resolves.toMatchObject({
      id: 'user-1',
    });
    expect(usersService.updateLastLogin).toHaveBeenCalledWith('user-1');
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('refuses to sign in a banned user', async () => {
    const usersService = {
      findByGoogleId: jest.fn().mockResolvedValue({ id: 'u', banned: true }),
      updateLastLogin: jest.fn(),
    };
    const service = new AuthService(usersService as never, {} as never);

    await expect(service.findOrCreateUser(profile)).rejects.toThrow(
      ForbiddenException,
    );
    expect(usersService.updateLastLogin).not.toHaveBeenCalled();
  });

  it('never hands an account to a different Google identity with the same email', async () => {
    const usersService = {
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', googleId: 'google-other' }),
      linkGoogleAccount: jest.fn(),
      create: jest.fn(),
    };
    const service = new AuthService(usersService as never, {} as never);

    await expect(service.findOrCreateUser(profile)).rejects.toThrow(
      ConflictException,
    );
    expect(usersService.linkGoogleAccount).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('links a row saved without a Google subject to the verified email owner', async () => {
    const usersService = {
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', googleId: '', banned: false }),
      linkGoogleAccount: jest.fn().mockResolvedValue({ id: 'user-1' }),
      create: jest.fn(),
    };
    const service = new AuthService(usersService as never, {} as never);

    await expect(service.findOrCreateUser(profile)).resolves.toEqual({
      id: 'user-1',
    });
    expect(usersService.findByEmail).toHaveBeenCalledWith('person@example.com');
    expect(usersService.linkGoogleAccount).toHaveBeenCalledWith(
      'user-1',
      'google-1',
    );
  });

  it('refuses to link a banned account saved without a Google subject', async () => {
    const usersService = {
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', googleId: '', banned: true }),
      linkGoogleAccount: jest.fn(),
      create: jest.fn(),
    };
    const service = new AuthService(usersService as never, {} as never);

    await expect(service.findOrCreateUser(profile)).rejects.toThrow(
      ForbiddenException,
    );
    expect(usersService.linkGoogleAccount).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('creates a user from a new Google profile', async () => {
    const usersService = {
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      updateLastLogin: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'user-1' }),
    };
    const service = new AuthService(usersService as never, {} as never);

    await expect(service.findOrCreateUser(profile)).resolves.toEqual({
      id: 'user-1',
    });
    expect(usersService.create).toHaveBeenCalledWith({
      googleId: 'google-1',
      email: 'person@example.com',
      firstName: 'Move',
      lastName: 'Miya',
      avatarUrl: 'https://example.com/avatar.jpg',
    });
  });
});
