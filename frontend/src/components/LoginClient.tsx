'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import CircularProgress from '@mui/material/CircularProgress';

const DEFAULT_NEXT = '/dashboard';
const SAME_ORIGIN = 'http://same-origin.invalid';

/**
 * Only same-origin paths are honored for `?next=`, so a crafted login link
 * cannot bounce a signed-in user to another site. Resolving against a fixed
 * origin applies the browser's own URL parsing, which also catches tricks
 * such as "//evil.test", "/\\evil.test" or embedded tabs.
 */
export function safeNextPath(next: string | null): string {
  if (!next?.startsWith('/')) return DEFAULT_NEXT;
  try {
    const url = new URL(next, SAME_ORIGIN);
    if (url.origin !== SAME_ORIGIN) return DEFAULT_NEXT;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_NEXT;
  }
}

export default function LoginClient() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));
  const signInFailed = searchParams.get('error') === 'signin';

  useEffect(() => {
    if (!loading && user) {
      router.replace(next);
    }
  }, [user, loading, router, next]);

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
        }}
      >
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }

  if (user) {
    return null;
  }

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          gap: 3,
          textAlign: 'center',
        }}
      >
        <Typography variant="h4" component="h1">
          Sign in to Move with Miya
        </Typography>
        {signInFailed && (
          <Alert severity="error">
            Google sign-in did not complete. Please try again.
          </Alert>
        )}
        <Button onClick={login} variant="contained" size="large">
          Sign in with Google
        </Button>
      </Box>
    </Container>
  );
}
