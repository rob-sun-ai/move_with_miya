import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';
import LoginClient, { safeNextPath } from './LoginClient';

const authMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const searchParamsMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ useAuth: authMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: searchParamsMock,
}));

describe('LoginClient', () => {
  it('shows a loading indicator while authentication is resolving', () => {
    authMock.mockReturnValue({ user: null, loading: true, login: vi.fn() });
    searchParamsMock.mockReturnValue(new URLSearchParams());
    render(<LoginClient />);
    expect(
      screen.getByRole('progressbar', { name: 'Loading' }),
    ).toBeInTheDocument();
  });

  it('starts Google login for signed-out users', async () => {
    const user = userEvent.setup();
    const login = vi.fn();
    authMock.mockReturnValue({ user: null, loading: false, login });
    searchParamsMock.mockReturnValue(new URLSearchParams());
    render(<LoginClient />);
    await user.click(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    );
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('explains a failed sign-in attempt', () => {
    authMock.mockReturnValue({ user: null, loading: false, login: vi.fn() });
    searchParamsMock.mockReturnValue(new URLSearchParams('error=signin'));
    render(<LoginClient />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Google sign-in did not complete.',
    );
  });

  it('redirects authenticated users to the requested destination', () => {
    authMock.mockReturnValue({
      user: { id: 'u1' },
      loading: false,
      login: vi.fn(),
    });
    searchParamsMock.mockReturnValue(new URLSearchParams('next=%2Fclasses'));
    render(<LoginClient />);
    expect(replaceMock).toHaveBeenCalledWith('/classes');
  });

  it('ignores a destination on another site', () => {
    authMock.mockReturnValue({
      user: { id: 'u1' },
      loading: false,
      login: vi.fn(),
    });
    searchParamsMock.mockReturnValue(
      new URLSearchParams('next=https%3A%2F%2Fevil.test'),
    );
    render(<LoginClient />);
    expect(replaceMock).toHaveBeenLastCalledWith('/dashboard');
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/classes/7?view=list#top', '/classes/7?view=list#top'],
    [null, '/dashboard'],
    ['', '/dashboard'],
    ['https://evil.test', '/dashboard'],
    ['//evil.test', '/dashboard'],
    ['/\\evil.test', '/dashboard'],
    ['/\t/evil.test', '/dashboard'],
    ['javascript:alert(1)', '/dashboard'],
  ])('maps %j to %j', (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });
});
