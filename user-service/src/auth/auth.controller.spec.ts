import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

jest.mock('uuid', () => ({ v4: jest.fn(() => 'state-id') }));
jest.mock('../users/users.service', () => ({ UsersService: class {} }));

import { AuthController } from './auth.controller';

type Callback = (error?: Error) => void;

/** A session that behaves like express-session's regenerate/save/destroy. */
function sessionRequest(data: Record<string, unknown>) {
  const mocks = {
    regenerate: jest.fn((callback: Callback) => {
      request.session = { ...mocks, id: 'new-session' };
      callback();
    }),
    save: jest.fn((callback: Callback) => callback()),
    destroy: jest.fn((callback: Callback) => callback()),
  };
  const request: { session: Record<string, unknown> } = {
    session: { ...data, ...mocks },
  };
  return { request: request as unknown as Request, mocks };
}

describe('AuthController', () => {
  const authService = {
    getGoogleAuthURL: jest.fn(),
    exchangeCode: jest.fn(),
    fetchGoogleProfile: jest.fn(),
    findOrCreateUser: jest.fn(),
    getFrontendUrl: jest.fn(),
  };
  const usersService = { findById: jest.fn() };
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    authService.getFrontendUrl.mockReturnValue('http://frontend.test');
    controller = new AuthController(
      authService as never,
      usersService as never,
    );
  });

  it('redirects Google login with a saved CSRF state', () => {
    authService.getGoogleAuthURL.mockReturnValue('https://google.test');
    const request = { session: {} } as unknown as Request;
    const redirectMock = jest.fn();
    const response = { redirect: redirectMock } as unknown as Response;
    controller.googleAuth(request, response);
    expect(request.session.state).toEqual(expect.any(String));
    expect(authService.getGoogleAuthURL).toHaveBeenCalledWith(
      request.session.state,
    );
    expect(redirectMock).toHaveBeenCalledWith('https://google.test');
  });

  it.each([
    ['a mismatched state', { state: 'saved' }, 'wrong'],
    ['no saved state', {}, 'state-id'],
    ['no state at all', {}, undefined],
  ])('rejects a callback with %s', async (_label, session, state) => {
    const { request } = sessionRequest(session);
    const redirectMock = jest.fn();
    await controller.googleCallback(
      request,
      { redirect: redirectMock } as unknown as Response,
      'code',
      state as string,
    );
    expect(authService.exchangeCode).not.toHaveBeenCalled();
    expect(request.session.userId).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith(
      'http://frontend.test/login?error=signin',
    );
  });

  it('rejects a callback without an authorization code', async () => {
    const redirectMock = jest.fn();
    await controller.googleCallback(
      sessionRequest({ state: 'saved' }).request,
      { redirect: redirectMock } as unknown as Response,
      undefined as unknown as string,
      'saved',
    );
    expect(authService.exchangeCode).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith(
      'http://frontend.test/login?error=signin',
    );
  });

  it('sends a refused sign-in back to the login page', async () => {
    authService.exchangeCode.mockResolvedValue({ accessToken: 'token' });
    authService.fetchGoogleProfile.mockResolvedValue({ sub: 'google-1' });
    authService.findOrCreateUser.mockRejectedValue(
      new ForbiddenException('User is banned'),
    );
    const { request, mocks } = sessionRequest({ state: 'saved' });
    const redirectMock = jest.fn();

    await controller.googleCallback(
      request,
      { redirect: redirectMock } as unknown as Response,
      'code',
      'saved',
    );

    expect(mocks.regenerate).not.toHaveBeenCalled();
    expect(request.session.userId).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith(
      'http://frontend.test/login?error=signin',
    );
  });

  it('starts a fresh session on login and drops the OAuth state', async () => {
    authService.exchangeCode.mockResolvedValue({ accessToken: 'token' });
    authService.fetchGoogleProfile.mockResolvedValue({ sub: 'google-1' });
    authService.findOrCreateUser.mockResolvedValue({ id: 'user-1' });
    const { request, mocks } = sessionRequest({ state: 'saved' });
    const preLogin = request.session;
    const redirectMock = jest.fn();
    const response = { redirect: redirectMock } as unknown as Response;

    await controller.googleCallback(request, response, 'code', 'saved');

    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
    expect(request.session).not.toBe(preLogin);
    expect(request.session.userId).toBe('user-1');
    expect(request.session.state).toBeUndefined();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(preLogin.userId).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith('http://frontend.test');
  });

  it('does not sign in when the session cannot be regenerated', async () => {
    authService.exchangeCode.mockResolvedValue({ accessToken: 'token' });
    authService.fetchGoogleProfile.mockResolvedValue({ sub: 'google-1' });
    authService.findOrCreateUser.mockResolvedValue({ id: 'user-1' });
    const { request, mocks } = sessionRequest({ state: 'saved' });
    mocks.regenerate.mockImplementation((callback: Callback) =>
      callback(new Error('redis down')),
    );
    const redirectMock = jest.fn();

    await controller.googleCallback(
      request,
      { redirect: redirectMock } as unknown as Response,
      'code',
      'saved',
    );
    expect(request.session.userId).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith(
      'http://frontend.test/login?error=signin',
    );
  });

  it('returns the logged-in user', async () => {
    usersService.findById.mockResolvedValue({ id: 'user-1' });
    const request = { session: { userId: 'user-1' } } as unknown as Request;
    await expect(controller.me(request)).resolves.toEqual({ id: 'user-1' });
    expect(usersService.findById).toHaveBeenCalledWith('user-1');
  });

  it('rejects /me without a user session', async () => {
    await expect(
      controller.me({ session: {} } as unknown as Request),
    ).rejects.toThrow('Not authenticated');
  });

  it('treats a session whose account was deleted as signed out', async () => {
    usersService.findById.mockRejectedValue(new NotFoundException());
    await expect(
      controller.me({ session: { userId: 'gone' } } as unknown as Request),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('destroys the session and clears the cookie on logout', async () => {
    const { request, mocks } = sessionRequest({ userId: 'user-1' });
    const clearCookieMock = jest.fn();
    const jsonMock = jest.fn();
    const response = {
      clearCookie: clearCookieMock,
      json: jsonMock,
    } as unknown as Response;

    await controller.logout(request, response);

    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(clearCookieMock).toHaveBeenCalledWith('connect.sid');
    expect(jsonMock).toHaveBeenCalledWith({ message: 'Logged out' });
  });

  it('does not report a logout that failed to end the session', async () => {
    const { request, mocks } = sessionRequest({ userId: 'user-1' });
    mocks.destroy.mockImplementation((callback: Callback) =>
      callback(new Error('redis down')),
    );
    const jsonMock = jest.fn();

    await expect(
      controller.logout(request, {
        clearCookie: jest.fn(),
        json: jsonMock,
      } as unknown as Response),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(jsonMock).not.toHaveBeenCalled();
  });
});
