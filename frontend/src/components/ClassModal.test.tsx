import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';
import ClassModal from './ClassModal';
import { yogaClass } from './test-fixtures';

const freeYogaClass = { ...yogaClass, cost: '0' };

afterEach(() => vi.restoreAllMocks());

describe('ClassModal', () => {
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
