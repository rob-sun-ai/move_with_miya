import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';
import DashboardClient from './DashboardClient';
import type { AuthUser, Registration } from '@/lib/types';

const logoutMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ logout: logoutMock }) }));

const user: AuthUser = {
  id: 'user-1',
  email: 'person@example.com',
  firstName: 'Move',
  lastName: 'Miya',
  role: 'TEACHER',
  avatarUrl: null,
  preferredName: null,
  phoneNumber: null,
  yogaExperience: null,
};

describe('DashboardClient', () => {
  it('renders the profile and logs out', async () => {
    const testUser = userEvent.setup();
    render(<DashboardClient user={user} />);
    expect(
      screen.getByRole('heading', { name: 'Dashboard' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Move Miya')).toBeInTheDocument();
    expect(screen.getByText('TEACHER')).toBeInTheDocument();
    await testUser.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });

  it('names each registered class, falling back to its id', () => {
    const registration = (id: number, classId: number): Registration => ({
      id,
      userId: user.id,
      classId,
      status: 'Registered',
      registeredAt: '2026-10-01T10:00:00.000Z',
    });
    render(
      <DashboardClient
        user={user}
        registrations={[
          {
            ...registration(1, 7),
            class: {
              id: 7,
              name: 'Sunrise Flow',
              startDate: '2026-11-01T09:00:00.000Z',
              endDate: '2026-11-01T10:00:00.000Z',
            },
          },
          { ...registration(2, 8), class: null },
        ]}
      />,
    );
    expect(screen.getByText('Sunrise Flow')).toBeInTheDocument();
    expect(screen.queryByText('Class 7')).not.toBeInTheDocument();
    expect(screen.getByText('Class 8')).toBeInTheDocument();
  });
});
