import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';
import { AuthProvider, useAuth } from '@/lib/auth';

function Consumer() {
  const { user, loading, logout } = useAuth();
  return (
    <div>
      <span>{loading ? 'loading' : (user?.email ?? 'signed out')}</span>
      <button onClick={logout}>logout</button>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AuthProvider', () => {
  it('loads the current user, then clears it and leaves the page on logout', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'u1', email: 'person@example.com' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'ok' })));
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(await screen.findByText('person@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'logout' }));
    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(assign).toHaveBeenCalledWith('/classes');
  });

  it('still leaves the page when the logout request fails', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'u1', email: 'person@example.com' })),
      )
      .mockRejectedValueOnce(new Error('offline'));
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(await screen.findByText('person@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/classes'));
  });

  it('treats a failed current-user request as signed out', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(await screen.findByText('signed out')).toBeInTheDocument();
  });
});
