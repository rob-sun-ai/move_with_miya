'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { api } from '@/lib/api';

// Polls back off so a slow webhook stays within the status endpoint's
// per-member rate limit: 8 checks over about two minutes.
const MAX_POLLS = 8;
const FIRST_POLL_DELAY_MS = 2000;
const MAX_POLL_DELAY_MS = 30_000;

function pollDelayMs(attempt: number) {
  return Math.min(FIRST_POLL_DELAY_MS * 2 ** (attempt - 1), MAX_POLL_DELAY_MS);
}

interface PaymentStatusResponse {
  payment: { status: string; refundStatus: string };
  registration?: { status: string } | null;
}

function CheckoutSuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [result, setResult] = useState<PaymentStatusResponse | null>(null);
  const [error, setError] = useState('');
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    let attempts = 0;
    let nextPoll: number | undefined;
    const poll = async () => {
      try {
        const next = await api<PaymentStatusResponse>(
          `/api/checkout/status?session_id=${encodeURIComponent(sessionId)}`,
        );
        if (stopped) return;
        setResult(next);
        setError('');
        if (next.registration?.status === 'Registered') return;
        if (
          ['Failed', 'Expired', 'Refunded'].includes(next.payment.status) ||
          next.payment.refundStatus === 'Succeeded' ||
          // A paid checkout with a refund but no seat will never register.
          (next.payment.status === 'Paid' &&
            next.payment.refundStatus !== 'None' &&
            !next.registration)
        ) {
          return;
        }
      } catch (err) {
        // Rate limiting means "check again later", not a failed payment.
        const rateLimited = (err as { status?: number })?.status === 429;
        if (!stopped && !rateLimited)
          setError(
            err instanceof Error ? err.message : 'Unable to confirm payment.',
          );
      }
      attempts += 1;
      if (!stopped && attempts < MAX_POLLS) {
        nextPoll = window.setTimeout(poll, pollDelayMs(attempts));
      } else if (!stopped) {
        setTimedOut(true);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(nextPoll);
    };
  }, [sessionId]);

  const registered = result?.registration?.status === 'Registered';
  const paymentFailed =
    result?.payment.status === 'Failed' || result?.payment.status === 'Expired';
  const refunded =
    result?.payment.status === 'Refunded' ||
    result?.payment.refundStatus === 'Succeeded';
  const noSeat =
    result?.payment.status === 'Paid' &&
    result.payment.refundStatus !== 'None' &&
    !result.registration;
  const fatalError = sessionId
    ? error
    : 'This checkout link is missing its session ID.';
  const warning = paymentFailed
    ? 'This payment could not be completed. Please try checkout again.'
    : refunded
      ? 'This payment has been refunded.'
      : noSeat
        ? "We couldn't reserve a seat; your payment is being refunded."
        : timedOut
          ? 'Payment confirmation is taking longer than expected. Check your dashboard shortly.'
          : '';
  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          {registered
            ? 'Registration confirmed'
            : fatalError || warning
              ? 'Payment confirmation incomplete'
              : 'Confirming your payment'}
        </Typography>
        {registered ? (
          <Alert severity="success">
            Your payment was received and your class registration is confirmed.
          </Alert>
        ) : fatalError ? (
          <Alert severity="error">{fatalError}</Alert>
        ) : warning ? (
          <Alert severity="warning">{warning}</Alert>
        ) : (
          <Alert severity="info" icon={<CircularProgress size={20} />}>
            Payment received; confirming registration. This page will update
            automatically.
          </Alert>
        )}
        <Link href="/dashboard">Go to your dashboard</Link>
      </Stack>
    </Container>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense
      fallback={
        <Container maxWidth="sm" sx={{ py: 8 }}>
          <CircularProgress />
        </Container>
      }
    >
      <CheckoutSuccessContent />
    </Suspense>
  );
}
