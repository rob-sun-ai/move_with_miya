import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';
import ClassModal from './ClassModal';
import { yogaClass } from './test-fixtures';
import { startCheckout } from '@/lib/checkout';

vi.mock('@/lib/checkout', () => ({ startCheckout: vi.fn() }));

const freeYogaClass = { ...yogaClass, cost: '0' };

/** Simulates the browser showing this page again (from bfcache if persisted). */
function pageShow(persisted: boolean) {
  act(() => {
    window.dispatchEvent(
      Object.assign(new Event('pageshow'), {
        persisted,
      }) as PageTransitionEvent,
    );
  });
}

afterEach(() => vi.restoreAllMocks());

describe('ClassModal', () => {
  describe('paid classes', () => {
    function renderPaid() {
      render(
        <ClassModal
          cls={yogaClass}
          currentUserId="user-1"
          isRegistered={false}
          onClose={vi.fn()}
          onRegisteredChange={vi.fn()}
        />,
      );
    }

    it('sends members to Stripe Checkout instead of registering', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.spyOn(global, 'fetch');
      vi.mocked(startCheckout).mockResolvedValue(undefined);
      renderPaid();

      await user.click(screen.getByRole('button', { name: 'Register' }));

      expect(startCheckout).toHaveBeenCalledWith(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      [
        Object.assign(new Error('Class is full'), { status: 409 }),
        'Class is full',
      ],
      [new Error(''), 'Registration failed.'],
    ])('shows why checkout could not start: %s', async (error, message) => {
      const user = userEvent.setup();
      vi.mocked(startCheckout).mockRejectedValue(error);
      renderPaid();

      await user.click(screen.getByRole('button', { name: 'Register' }));

      expect(await screen.findByText(message)).toBeInTheDocument();
    });

    it('lets the member retry after returning from Checkout via Back', async () => {
      const user = userEvent.setup();
      vi.mocked(startCheckout).mockReturnValue(new Promise(() => undefined));
      renderPaid();

      await user.click(screen.getByRole('button', { name: 'Register' }));
      expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();

      pageShow(false);
      expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();

      pageShow(true);
      expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled();
    });
  });

  it('registers a signed-in user', async () => {
    const user = userEvent.setup();
    const onRegisteredChange = vi.fn();
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 4 }), { status: 201 }),
      );
    render(
      <ClassModal
        cls={freeYogaClass}
        currentUserId="user-1"
        isRegistered={false}
        onClose={vi.fn()}
        onRegisteredChange={onRegisteredChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() =>
      expect(onRegisteredChange).toHaveBeenCalledWith(1, 'Registered'),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/registration/class/1/user/user-1',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('cancels an existing registration', async () => {
    const user = userEvent.setup();
    const onRegisteredChange = vi.fn();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    render(
      <ClassModal
        cls={freeYogaClass}
        currentUserId="user-1"
        isRegistered
        onClose={vi.fn()}
        onRegisteredChange={onRegisteredChange}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Cancel Registration' }),
    );

    await waitFor(() =>
      expect(onRegisteredChange).toHaveBeenCalledWith(1, 'Canceled'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/registration/class/1/me',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('requires the detail page for private-class registration', async () => {
    const user = userEvent.setup();
    render(
      <ClassModal
        cls={{ ...freeYogaClass, isPrivate: true }}
        currentUserId="user-1"
        isRegistered={false}
        onClose={vi.fn()}
        onRegisteredChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'View details to register' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Register' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
  });

  it('disables registration for ended classes', () => {
    render(
      <ClassModal
        cls={{
          ...freeYogaClass,
          endDate: '2000-01-01T11:00:00.000Z',
          startDate: '2000-01-01T10:00:00.000Z',
        }}
        currentUserId="user-1"
        isRegistered={false}
        onClose={vi.fn()}
        onRegisteredChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Class ended' })).toBeDisabled();
  });
});
