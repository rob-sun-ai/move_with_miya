// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

function request(path: string, cookie?: string) {
  return new NextRequest(`http://studio.test${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

afterEach(() => vi.restoreAllMocks());

describe('proxy', () => {
  it('sends visitors without a session to login, remembering the page', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');

    const res = await proxy(request('/admin'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://studio.test/login?next=%2Fadmin',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the session with the user service', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await proxy(request('/dashboard', 'theme=x; connect.sid=s1'));

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/me$/),
      expect.objectContaining({
        headers: { cookie: 'theme=x; connect.sid=s1' },
      }),
    );
  });

  it('sends an expired session to login', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 401 }),
    );

    const res = await proxy(request('/dashboard', 'connect.sid=old'));

    expect(res.headers.get('location')).toBe(
      'http://studio.test/login?next=%2Fdashboard',
    );
  });

  it('sends the visitor to login when the user service is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await proxy(request('/admin', 'connect.sid=s1'));

    expect(res.headers.get('location')).toBe(
      'http://studio.test/login?next=%2Fadmin',
    );
  });
});
