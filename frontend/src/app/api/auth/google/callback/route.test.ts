// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

function callback(query: string, cookie = 'connect.sid=pre-login') {
  return GET(
    new NextRequest(`http://studio.test/api/auth/google/callback${query}`, {
      headers: { cookie },
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('Google OAuth callback', () => {
  it('forwards the code, state, and cookies, and relays the redirect and session cookie', async () => {
    const upstream = new Headers({ location: 'https://studio.test/' });
    upstream.append('set-cookie', 'connect.sid=signed-in; Path=/; HttpOnly');
    upstream.append('set-cookie', 'other=1; Path=/');
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('Found. Redirecting', { status: 302, headers: upstream }),
      );

    const res = await callback('?code=abc&state=xyz%2F1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /\/auth\/google\/callback\?code=abc&state=xyz%2F1$/,
    );
    expect(init).toMatchObject({
      headers: { cookie: 'connect.sid=pre-login' },
      redirect: 'manual',
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://studio.test/');
    expect(res.headers.getSetCookie()).toEqual([
      'connect.sid=signed-in; Path=/; HttpOnly',
      'other=1; Path=/',
    ]);
  });

  it.each([['?code=abc'], ['?state=xyz'], ['']])(
    'sends a callback missing parameters (%s) back to login',
    async (query) => {
      const fetchMock = vi.spyOn(global, 'fetch');

      const res = await callback(query);

      expect(res.headers.get('location')).toBe('/login?error=signin');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('sends a rejected sign-in back to login without leaking the error body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid state parameter' }), {
        status: 401,
      }),
    );

    const res = await callback('?code=abc&state=forged');

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/login?error=signin');
    expect(await res.text()).toBe('');
  });

  it('sends the visitor back to login when the user service is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await callback('?code=abc&state=xyz');

    expect(res.headers.get('location')).toBe('/login?error=signin');
  });
});
