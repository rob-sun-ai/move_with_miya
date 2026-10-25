import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

afterEach(() => vi.restoreAllMocks());

describe('api', () => {
  it('sends JSON requests with credentials', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    await expect(
      api('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Miya' }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profile',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it.each([
    ['an empty 200', new Response('', { status: 200 })],
    ['a 204', new Response(null, { status: 204 })],
  ])('resolves %s without a body', async (_label, response) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(response);

    await expect(
      api('/api/locations/1', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
  });

  it('normalizes array and scalar API errors', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ message: ['Name is required', 'Invalid email'] }),
        {
          status: 400,
          statusText: 'Bad Request',
        },
      ),
    );

    await expect(
      api('/api/contact', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({
      message: 'Name is required, Invalid email',
      status: 400,
    } satisfies Partial<ApiError>);
  });

  it('falls back to status text when an error body is not JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not json', { status: 503, statusText: 'Unavailable' }),
    );

    await expect(api('/api/classes')).rejects.toMatchObject({
      message: 'Unavailable',
      status: 503,
    });
  });
});
