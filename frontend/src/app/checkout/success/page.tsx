'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { api } from '@/lib/api';

interface PaymentStatusResponse {
  payment: { status: string; refundStatus: string };
  registration?: { status: string } | null;
}

function CheckoutSuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = useMemo(
    () => searchParams.get('session_id'),
    [searchParams],
  );
  const [result, setResult] = useState<PaymentStatusResponse | null>(null);
  const [error, setError] = useState('');
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    let attempts = 0;
    const poll = async () => {
      try {
        const next = await api<PaymentStatusResponse>(
          `/api/checkout/status?session_id=${encodeURIComponent(sessionId)}`,
        );
        if (stopped) return;
        setResult(next);
        if (next.registration?.status === 'Registered') return;
        if (
          ['Failed', 'Expired', 'Refunded'].includes(next.payment.status) ||
          next.payment.refundStatus === 'Succeeded'
        ) {
          return;
        }
      } catch (err) {
        if (!stopped)
          setError(
            err instanceof Error ? err.message : 'Unable to confirm payment.',
          );
      }
      attempts += 1;
      if (!stopped && attempts < 15) {
        window.setTimeout(poll, 2000);
      } else if (!stopped) {
        setTimedOut(true);
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [sessionId]);

  const registered = result?.registration?.status === 'Registered';
  const paymentFailed =
    result?.payment.status === 'Failed' || result?.payment.status === 'Expired';
  const refunded =
    result?.payment.status === 'Refunded' ||
    result?.payment.refundStatus === 'Succeeded';
  const displayedError =
    error ||
    (paymentFailed
      ? 'This payment could not be completed. Please try checkout again.'
      : refunded
        ? 'This payment was refunded because the registration could not be completed.'
        : timedOut
          ? 'Payment confirmation is taking longer than expected. Check your dashboard shortly.'
          : '') ||
    (!sessionId ? 'This checkout link is missing its session ID.' : '');
  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          {registered
            ? 'Registration confirmed'
            : paymentFailed || refunded || timedOut
              ? 'Payment confirmation incomplete'
              : 'Confirming your payment'}
        </Typography>
        {displayedError ? (
          <Alert severity="error">{displayedError}</Alert>
        ) : registered ? (
          <Alert severity="success">
            Your payment was received and your class registration is confirmed.
          </Alert>
        ) : paymentFailed || refunded || timedOut ? (
          <Alert severity="warning">{displayedError}</Alert>
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
