import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render } from '../test-utils';
import { yogaClass } from '../test-fixtures';
import AdminDashboard from './AdminDashboard';
import type { Payment, Registration } from '@/lib/types';

type Route = { status?: number; body: unknown } | Error;

/** Routes fetch by "METHOD path" (or just path for GET) to canned responses. */
function mockApi(routes: Record<string, Route>) {
  return vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const route = routes[`${method} ${path}`] ?? routes[path];
    if (route instanceof Error) return Promise.reject(route);
    if (!route) return Promise.resolve(new Response('{}'));
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
      }),
    );
  });
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-1234abcd',
    userId: 'member-1',
    classId: yogaClass.id,
    amountCents: 2500,
    currency: 'usd',
    status: 'Paid',
    refundStatus: 'None',
    ...overrides,
  };
}

const registration: Registration = {
  id: 8,
  userId: 'member-1',
  classId: yogaClass.id,
  status: 'Registered',
  registeredAt: '2026-09-01T12:00:00.000Z',
};

function renderDashboard(
  overrides: Partial<ComponentProps<typeof AdminDashboard>> = {},
) {
  return render(
    <AdminDashboard
      initialClasses={[yogaClass]}
      initialLocations={[yogaClass.location]}
      initialContact={[]}
      initialUsers={[]}
      initialRegistrations={[registration]}
      {...overrides}
    />,
  );
}

function refundCalls(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith('/refund'),
  );
}

describe('AdminDashboard payments', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openPayments() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Payments' }));
    return user;
  }

  it('shows an empty state without payments', async () => {
    renderDashboard();
    await openPayments();

    expect(screen.getByText('No payments yet.')).toBeInTheDocument();
  });

  it('lists payment details, refund amounts, and refund errors', async () => {
    renderDashboard({
      initialPayments: [
        payment({
          refundStatus: 'Failed',
          refundAmountCents: 1250,
          refundError: 'card_declined',
        }),
        payment({ id: 'payment-for-gone-class', classId: 99, currency: 'eur' }),
      ],
    });
    await openPayments();

    const rows = screen.getAllByRole('row');
    const first = within(rows[1]);
    expect(first.getByText('payment-')).toBeInTheDocument();
    expect(first.getByText('Morning Flow')).toBeInTheDocument();
    expect(first.getByText('25.00 USD')).toBeInTheDocument();
    expect(first.getByText('Paid')).toBeInTheDocument();
    expect(first.getByText(/Failed/)).toHaveTextContent('Failed (12.50 USD)');
    expect(first.getByText('card_declined')).toBeInTheDocument();
    expect(screen.queryByText(/Needs attention/)).toBeNull();

    const second = within(rows[2]);
    expect(second.getByText('99')).toBeInTheDocument();
    expect(second.getByText('25.00 EUR')).toBeInTheDocument();
    expect(second.queryByText(/\(/)).toBeNull();
  });

  it('only offers refunds for paid payments that are not yet refunded', async () => {
    renderDashboard({
      initialPayments: [
        payment({ id: 'paid-none' }),
        payment({ id: 'paid-pending', refundStatus: 'Pending' }),
        payment({ id: 'paid-succeeded', refundStatus: 'Succeeded' }),
        payment({ id: 'pending-checkout', status: 'Pending' }),
        payment({
          id: 'refunded',
          status: 'Refunded',
          refundStatus: 'Succeeded',
        }),
      ],
    });
    await openPayments();

    expect(screen.getAllByRole('button', { name: 'Refund' })).toHaveLength(2);
  });

  it.each(['Pending', 'Failed'] as const)(
    'retries a %s refund as queued, without choosing a new amount',
    async (refundStatus) => {
      const fetchMock = mockApi({
        '/api/checkout/payments': { body: [] },
      });
      renderDashboard({ initialPayments: [payment({ refundStatus })] });
      const user = await openPayments();

      await user.click(screen.getByRole('button', { name: 'Refund' }));

      expect(
        await screen.findByText('Refund request processed.'),
      ).toBeInTheDocument();
      const [[path, init]] = refundCalls(fetchMock);
      expect(path).toBe('/api/checkout/payments/payment-1234abcd/refund');
      expect(init).toMatchObject({ method: 'POST' });
      expect(init?.body).toBeUndefined();
    },
  );

  it('requests a full refund for a payment without one and refreshes the list', async () => {
    const fetchMock = mockApi({
      '/api/checkout/payments': {
        body: [payment({ refundStatus: 'Succeeded', status: 'Refunded' })],
      },
    });
    renderDashboard({ initialPayments: [payment()] });
    const user = await openPayments();

    await user.click(screen.getByRole('button', { name: 'Refund' }));

    expect(
      await screen.findByText('Refund request processed.'),
    ).toBeInTheDocument();
    expect(refundCalls(fetchMock)[0][1]).toMatchObject({
      body: JSON.stringify({ percentage: 100 }),
    });
    expect(screen.getByText('Refunded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
  });

  it('shows why a refund failed', async () => {
    mockApi({
      'POST /api/checkout/payments/payment-1234abcd/refund': {
        status: 503,
        body: { message: 'Unable to issue Stripe refund' },
      },
    });
    renderDashboard({ initialPayments: [payment()] });
    const user = await openPayments();

    await user.click(screen.getByRole('button', { name: 'Refund' }));

    expect(
      await screen.findByText('Unable to issue Stripe refund'),
    ).toBeInTheDocument();
  });

  it('shows a generic message when the refund request cannot be sent', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue('offline');
    renderDashboard({ initialPayments: [payment()] });
    const user = await openPayments();

    await user.click(screen.getByRole('button', { name: 'Refund' }));

    expect(await screen.findByText('Refund failed.')).toBeInTheDocument();
  });

  it('keeps a successful refund successful when refreshing the list fails', async () => {
    mockApi({
      '/api/checkout/payments': new Error('network down'),
    });
    renderDashboard({ initialPayments: [payment()] });
    const user = await openPayments();

    await user.click(screen.getByRole('button', { name: 'Refund' }));

    expect(
      await screen.findByText('Refund request processed.'),
    ).toBeInTheDocument();
    expect(screen.getByText('payment-')).toBeInTheDocument();
  });

  it('refreshes payments after canceling a class', async () => {
    const fetchMock = mockApi({
      '/api/classes': { body: [{ ...yogaClass, status: 'Canceled' }] },
      '/api/registration': { body: [] },
      '/api/checkout/payments': {
        body: [payment({ refundStatus: 'Pending', refundAmountCents: 2500 })],
      },
    });
    const user = userEvent.setup();
    renderDashboard({ initialPayments: [payment()] });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      await screen.findByText('Class canceled and registrations updated.'),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/checkout/payments',
      expect.anything(),
    );
    await user.click(screen.getByRole('tab', { name: 'Payments' }));
    expect(screen.getByText(/Pending/)).toHaveTextContent(
      'Pending (25.00 USD)',
    );
  });

  it('refreshes payments after canceling a registration', async () => {
    const fetchMock = mockApi({
      'POST /api/registration/8/cancel': {
        body: { ...registration, status: 'Canceled' },
      },
      '/api/checkout/payments': { body: [] },
    });
    const user = userEvent.setup();
    renderDashboard({ initialPayments: [payment()] });

    await user.click(screen.getByRole('tab', { name: 'Registrations' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.getByText('Registration cancelled.')).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/checkout/payments',
      expect.anything(),
    );
  });
});

describe('AdminDashboard refund tiers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function editClass(cls = yogaClass) {
    const user = userEvent.setup();
    renderDashboard({ initialClasses: [cls] });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    return user;
  }

  function tierValues() {
    const hours = screen.getAllByLabelText('Hours before start');
    const percentages = screen.getAllByLabelText('Refund %');
    return hours.map((input, index) => [
      (input as HTMLInputElement).value,
      (percentages[index] as HTMLInputElement).value,
    ]);
  }

  function savedPayload(fetchMock: ReturnType<typeof mockApi>) {
    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/classes/1' && init?.method === 'PATCH',
    );
    return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
  }

  it('starts new classes with a full refund until 24 hours before', async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(screen.getByRole('button', { name: 'New Class' }));

    expect(tierValues()).toEqual([['24', '100']]);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('loads the tiers of the class being edited', async () => {
    await editClass({
      ...yogaClass,
      refundPolicy: [
        { hoursBeforeStart: 72, percentage: 100 },
        { hoursBeforeStart: 24, percentage: 50 },
      ],
    });

    expect(tierValues()).toEqual([
      ['72', '100'],
      ['24', '50'],
    ]);
  });

  it('defaults an edited class without a policy to the standard tier', async () => {
    await editClass({ ...yogaClass, refundPolicy: undefined });

    expect(tierValues()).toEqual([['24', '100']]);
  });

  it('adds, edits, and removes tiers and saves them as numbers', async () => {
    const fetchMock = mockApi({ '/api/classes': { body: [yogaClass] } });
    const user = await editClass();

    await user.click(screen.getByRole('button', { name: 'Add refund tier' }));
    expect(tierValues()).toEqual([
      ['24', '100'],
      ['0', '0'],
    ]);
    const hours = screen.getAllByLabelText('Hours before start');
    const percentages = screen.getAllByLabelText('Refund %');
    await user.clear(hours[0]);
    await user.type(hours[0], '72');
    await user.clear(percentages[1]);
    await user.type(percentages[1], '25');
    await user.click(screen.getByRole('button', { name: 'Add refund tier' }));
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[2]);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Class updated.')).toBeInTheDocument();
    expect(savedPayload(fetchMock).refundPolicy).toEqual([
      { hoursBeforeStart: 72, percentage: 100 },
      { hoursBeforeStart: 0, percentage: 25 },
    ]);
  });

  it.each([
    ['a percentage over 100', 'Refund %', '150'],
    ['a negative percentage', 'Refund %', '-5'],
    ['fractional hours', 'Hours before start', '1.5'],
    ['negative hours', 'Hours before start', '-1'],
    ['a fractional percentage', 'Refund %', '12.5'],
  ])('rejects %s without saving', async (_label, field, value) => {
    const fetchMock = mockApi({});
    const user = await editClass();

    const input = screen.getAllByLabelText(field)[0];
    await user.clear(input);
    await user.type(input, value);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      screen.getByText(
        'Refund tiers must use whole hours and percentages from 0 to 100.',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
