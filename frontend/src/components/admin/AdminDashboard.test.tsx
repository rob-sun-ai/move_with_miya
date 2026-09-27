import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render } from '../test-utils';
import { yogaClass } from '../test-fixtures';
import AdminDashboard from './AdminDashboard';
import type {
  AdminUser,
  ContactSubmission,
  Location,
  Payment,
  Registration,
} from '@/lib/types';

const location: Location = {
  id: 1,
  name: 'Studio One',
  address: '1 Main St',
  city: 'Boston',
  state: 'MA',
  zipCode: '02110',
};

const adminUser: AdminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  firstName: 'A',
  lastName: 'Admin',
  role: 'ADMIN',
  banned: false,
};

const contact: ContactSubmission = {
  id: 5,
  name: 'Person',
  email: 'person@example.com',
  subject: 'Question',
  message: 'Hello',
  read: false,
  createdAt: '2026-09-01T12:00:00.000Z',
};

const registration: Registration = {
  id: 8,
  userId: 'member-1',
  classId: yogaClass.id,
  status: 'Registered',
  registeredAt: '2026-09-01T12:00:00.000Z',
  user: {
    id: 'member-1',
    firstName: 'Member',
    lastName: 'One',
    role: 'MEMBER',
  },
  class: {
    id: yogaClass.id,
    name: yogaClass.name,
    startDate: yogaClass.startDate,
    endDate: yogaClass.endDate,
  },
};

function renderDashboard(
  overrides: Partial<ComponentProps<typeof AdminDashboard>> = {},
) {
  return render(
    <AdminDashboard
      initialClasses={[{ ...yogaClass, location }]}
      initialLocations={[location]}
      initialContact={[contact]}
      initialUsers={[adminUser]}
      initialRegistrations={[registration]}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AdminDashboard', () => {
  it('switches between every administration tab', async () => {
    const user = userEvent.setup();
    renderDashboard();

    expect(screen.getByText('Morning Flow')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Locations' }));
    expect(screen.getByText('Studio One')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Registrations' }));
    expect(
      screen.getByText(/Showing 1 of 1 registrations/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Contact' }));
    expect(screen.getByText('person@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Users' }));
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
  });

  it('validates a new class before sending it', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await user.click(screen.getByRole('button', { name: 'New Class' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Start date is required.')).toBeInTheDocument();
    expect(screen.getByText('End date is required.')).toBeInTheDocument();
  });

  it('issues a full refund for a payment ruled ineligible by the member policy', async () => {
    const user = userEvent.setup();
    const payment: Payment = {
      id: 'payment-1234',
      userId: 'member-1',
      classId: yogaClass.id,
      amountCents: 2500,
      currency: 'usd',
      status: 'Paid',
      refundStatus: 'NotEligible',
      refundAmountCents: 0,
    };
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify([payment]))),
      );
    renderDashboard({ initialPayments: [payment] });
    await user.click(screen.getByRole('tab', { name: 'Payments' }));
    await user.click(screen.getByRole('button', { name: 'Refund' }));

    expect(
      await screen.findByText('Refund request processed.'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/checkout/payments/payment-1234/refund',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ percentage: 100 }),
      }),
    );
  });

  it('flags refunds whose automatic retries are exhausted', async () => {
    const user = userEvent.setup();
    renderDashboard({
      initialPayments: [
        {
          id: 'payment-5678',
          userId: 'member-1',
          classId: yogaClass.id,
          amountCents: 2500,
          currency: 'usd',
          status: 'Paid',
          refundStatus: 'Failed',
          refundAttempts: 10,
          refundNeedsAttention: true,
          refundError: 'card_declined',
        },
      ],
    });
    await user.click(screen.getByRole('tab', { name: 'Payments' }));

    expect(
      screen.getByText('Needs attention (10 attempts)'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refund' })).toBeInTheDocument();
  });

  it('marks contact submissions read and reports the result', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: contact.id, read: true })),
      );
    renderDashboard();
    await user.click(screen.getByRole('tab', { name: 'Contact' }));
    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(
      await screen.findByText('Submission marked read.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/contact/5/read',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('updates a user ban status and handles registration cancellation', async () => {
    const user = userEvent.setup();
    vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }))),
    );
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    renderDashboard();

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    await user.click(screen.getByRole('button', { name: 'Ban' }));
    expect(
      await screen.findByText('User ban status updated.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Banned')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Registrations' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByText('Registration cancelled.')).toBeInTheDocument(),
    );
    expect(screen.getByText('Canceled')).toBeInTheDocument();
  });
});
