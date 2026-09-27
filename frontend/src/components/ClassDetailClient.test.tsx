import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';
import ClassDetailClient from './ClassDetailClient';
import { yogaClass } from './test-fixtures';
import type { AuthUser } from '@/lib/types';
import { startCheckout } from '@/lib/checkout';

vi.mock('@/lib/checkout', () => ({ startCheckout: vi.fn() }));

const freeYogaClass = { ...yogaClass, cost: '0' };

const user: AuthUser = {
  id: 'user-1',
  email: 'person@example.com',
  firstName: 'Person',
  lastName: 'User',
  role: 'MEMBER',
  yogaExperience: null,
};

afterEach(() => vi.restoreAllMocks());

describe('ClassDetailClient', () => {
  describe('paid classes', () => {
    const member = { ...user, yogaExperience: 'Beginner' };

    function notRegisteredYet() {
      return vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response('{}', { status: 404, statusText: 'Not found' }),
        );
    }

    it('sends members to Stripe Checkout instead of registering', async () => {
      const testUser = userEvent.setup();
      const fetchMock = notRegisteredYet();
      vi.mocked(startCheckout).mockResolvedValue(undefined);
      render(<ClassDetailClient cls={yogaClass} user={member} />);

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled(),
      );
      await testUser.click(screen.getByRole('button', { name: 'Register' }));

      expect(startCheckout).toHaveBeenCalledWith(1);
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/registration/class/1/user/'),
        expect.anything(),
      );
    });

    it.each([
      [new Error('Class is full'), 'Class is full'],
      [new Error(''), 'Registration failed.'],
    ])('shows why checkout could not start: %s', async (error, message) => {
      const testUser = userEvent.setup();
      notRegisteredYet();
      vi.mocked(startCheckout).mockRejectedValue(error);
      render(<ClassDetailClient cls={yogaClass} user={member} />);

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled(),
      );
      await testUser.click(screen.getByRole('button', { name: 'Register' }));

      expect(await screen.findByText(message)).toBeInTheDocument();
    });
  });

  it('offers sign-in when there is no user', () => {
    render(<ClassDetailClient cls={freeYogaClass} />);
    expect(
      screen.getByRole('link', { name: 'Sign in to register' }),
    ).toHaveAttribute('href', '/login');
  });

  it('registers after collecting experience for a private class', async () => {
    const testUser = userEvent.setup();
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const path = String(input);
        if (path.endsWith('/me') && !init?.method) {
          return new Response('{}', { status: 404, statusText: 'Not found' });
        }
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      });
    render(
      <ClassDetailClient
        cls={{ ...freeYogaClass, isPrivate: true }}
        user={user}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled(),
    );
    await testUser.click(screen.getByRole('button', { name: 'Register' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await testUser.click(
      screen.getByRole('button', { name: 'Save and register' }),
    );
    expect(
      screen.getByText('Please describe your yoga experience.'),
    ).toBeInTheDocument();

    await testUser.type(
      screen.getByLabelText('Yoga experience'),
      'Five years of yoga',
    );
    await testUser.click(
      screen.getByRole('button', { name: 'Save and register' }),
    );

    await waitFor(() =>
      expect(
        screen.getByText('You are registered for this class!'),
      ).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users/user-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/registration/class/1/user/user-1',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows registration errors', async () => {
    const testUser = userEvent.setup();
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/me') && !init?.method) {
        return new Response('{}', { status: 404, statusText: 'Not found' });
      }
      return new Response(JSON.stringify({ message: 'Class is full' }), {
        status: 409,
      });
    });
    render(
      <ClassDetailClient
        cls={freeYogaClass}
        user={{ ...user, yogaExperience: 'Beginner' }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled(),
    );
    await testUser.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText('Class is full')).toBeInTheDocument();
  });
});
