import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@/components/test-utils';
import { api } from '@/lib/api';
import CheckoutSuccessPage from './page';

let sessionId: string | null = 'cs_test_1';

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => sessionId }),
}));
vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

function status(
  payment: { status: string; refundStatus?: string },
  registration: { status: string } | null = null,
) {
  return {
    payment: { refundStatus: 'None', ...payment },
    registration,
  };
}

async function renderPage() {
  render(<CheckoutSuccessPage />);
  // Let the first poll resolve.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function nextPoll() {
  await act(async () => {
    await vi.advanceTimersToNextTimerAsync();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('CheckoutSuccessPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionId = 'cs_test_1';
    apiMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the member-scoped status of the Checkout session', async () => {
    sessionId = 'cs test/1';
    apiMock.mockResolvedValue(
      status({ status: 'Paid' }, { status: 'Registered' }),
    );

    await renderPage();

    expect(apiMock).toHaveBeenCalledWith(
      '/api/checkout/status?session_id=cs%20test%2F1',
    );
  });

  it('confirms the registration once the webhook has fulfilled it', async () => {
    apiMock.mockResolvedValue(
      status({ status: 'Paid' }, { status: 'Registered' }),
    );

    await renderPage();
    await nextPoll();

    expect(
      screen.getByRole('heading', { name: 'Registration confirmed' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/registration is confirmed/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while the payment is being confirmed', async () => {
    apiMock
      .mockResolvedValueOnce(status({ status: 'Pending' }))
      .mockResolvedValueOnce(status({ status: 'Paid' }))
      .mockResolvedValue(status({ status: 'Paid' }, { status: 'Registered' }));

    await renderPage();
    expect(
      screen.getByRole('heading', { name: 'Confirming your payment' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/confirming registration/)).toBeInTheDocument();

    await nextPoll();
    await nextPoll();

    expect(
      screen.getByRole('heading', { name: 'Registration confirmed' }),
    ).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(3);
  });

  it.each(['Failed', 'Expired'])(
    'stops and asks the member to retry a %s payment',
    async (paymentStatus) => {
      apiMock.mockResolvedValue(status({ status: paymentStatus }));

      await renderPage();
      await nextPoll();

      expect(
        screen.getByRole('heading', {
          name: 'Payment confirmation incomplete',
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'This payment could not be completed. Please try checkout again.',
        ),
      ).toBeInTheDocument();
      expect(apiMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [{ status: 'Refunded' }],
    [{ status: 'Paid', refundStatus: 'Succeeded' }],
  ])('explains a refunded payment %o', async (payment) => {
    apiMock.mockResolvedValue(status(payment));

    await renderPage();
    await nextPoll();

    expect(
      screen.getByText('This payment has been refunded.'),
    ).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it.each(['Pending', 'Failed', 'NotEligible'])(
    'stops when a paid checkout has no seat and a %s refund',
    async (refundStatus) => {
      apiMock.mockResolvedValue(status({ status: 'Paid', refundStatus }));

      await renderPage();
      await nextPoll();

      expect(
        screen.getByRole('heading', {
          name: 'Payment confirmation incomplete',
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "We couldn't reserve a seat; your payment is being refunded.",
        ),
      ).toBeInTheDocument();
      expect(apiMock).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps polling a refunded payment that still holds a seat', async () => {
    apiMock
      .mockResolvedValueOnce(
        status(
          { status: 'Paid', refundStatus: 'Pending' },
          { status: 'Waitlisted' },
        ),
      )
      .mockResolvedValue(status({ status: 'Paid' }, { status: 'Registered' }));

    await renderPage();
    await nextPoll();

    expect(
      screen.getByRole('heading', { name: 'Registration confirmed' }),
    ).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it('backs off between checks', async () => {
    apiMock.mockResolvedValue(status({ status: 'Paid' }));

    await renderPage();
    const expectedDelays = [2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];
    for (const [index, delay] of expectedDelays.entries()) {
      await advance(delay - 1);
      expect(apiMock).toHaveBeenCalledTimes(index + 1);
      await advance(1);
      expect(apiMock).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('gives up after 8 checks and points to the dashboard', async () => {
    apiMock.mockResolvedValue(status({ status: 'Paid' }));

    await renderPage();
    for (let i = 0; i < 20; i += 1) await nextPoll();

    expect(apiMock).toHaveBeenCalledTimes(8);
    expect(screen.getByText(/taking longer than expected/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Go to your dashboard' }),
    ).toHaveAttribute('href', '/dashboard');
  });

  it('treats rate limiting as still confirming and keeps polling', async () => {
    const tooMany = Object.assign(new Error('Too many payment requests'), {
      status: 429,
    });
    apiMock
      .mockRejectedValueOnce(tooMany)
      .mockRejectedValueOnce(tooMany)
      .mockResolvedValue(status({ status: 'Paid' }, { status: 'Registered' }));

    await renderPage();
    expect(screen.queryByText('Too many payment requests')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Confirming your payment' }),
    ).toBeInTheDocument();

    await nextPoll();
    expect(screen.queryByText('Too many payment requests')).toBeNull();
    await nextPoll();

    expect(
      screen.getByRole('heading', { name: 'Registration confirmed' }),
    ).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(3);
  });

  it('shows a timeout, not an error, when every check is rate limited', async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error('Too many payment requests'), { status: 429 }),
    );

    await renderPage();
    for (let i = 0; i < 20; i += 1) await nextPoll();

    expect(apiMock).toHaveBeenCalledTimes(8);
    expect(screen.queryByText('Too many payment requests')).toBeNull();
    expect(screen.getByText(/taking longer than expected/)).toBeInTheDocument();
  });

  it('shows a status error and recovers when a later check succeeds', async () => {
    apiMock
      .mockRejectedValueOnce(new Error('Payment service unavailable'))
      .mockResolvedValue(status({ status: 'Paid' }, { status: 'Registered' }));

    await renderPage();
    expect(screen.getByText('Payment service unavailable')).toBeInTheDocument();

    await nextPoll();

    expect(screen.queryByText('Payment service unavailable')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Registration confirmed' }),
    ).toBeInTheDocument();
  });

  it('shows a generic error for non-Error failures', async () => {
    apiMock.mockRejectedValue('offline');

    await renderPage();

    expect(screen.getByText('Unable to confirm payment.')).toBeInTheDocument();
  });

  it('reports a link without a session id and does not poll', async () => {
    sessionId = null;

    await renderPage();

    expect(
      screen.getByText('This checkout link is missing its session ID.'),
    ).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('stops polling after leaving the page', async () => {
    apiMock.mockResolvedValue(status({ status: 'Paid' }));
    const { unmount } = render(<CheckoutSuccessPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a response that arrives after leaving the page', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(<CheckoutSuccessPage />);

    unmount();
    await act(async () => {
      resolve(status({ status: 'Paid' }));
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an error that arrives after leaving the page', async () => {
    let reject: (reason: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((_, r) => (reject = r)));
    const { unmount } = render(<CheckoutSuccessPage />);

    unmount();
    await act(async () => {
      reject(new Error('late'));
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
