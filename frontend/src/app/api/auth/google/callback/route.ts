import { NextRequest, NextResponse } from 'next/server';
import { USER_SERVICE_URL } from '@/lib/env';

const SIGN_IN_FAILED = '/login?error=signin';

// Relative, so the redirect never depends on the request's Host header.
function redirectTo(location: string) {
  return new NextResponse(null, { status: 307, headers: { location } });
}

// Completes Google sign-in when the browser reaches Next directly (in
// production nginx routes /api/auth/* straight to the user service). The user
// service checks `state` against the session cookie, so the browser's cookies
// are forwarded, and its redirect and session cookie are passed back.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (!code || !state) {
    return redirectTo(SIGN_IN_FAILED);
  }

  const url = new URL(`${USER_SERVICE_URL}/auth/google/callback`);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { cookie: request.headers.get('cookie') ?? '' },
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (error) {
    console.error('Google sign-in callback failed:', error);
    return redirectTo(SIGN_IN_FAILED);
  }

  const location = upstream.headers.get('location');
  if (upstream.status < 300 || upstream.status >= 400 || !location) {
    // A rejected state or a failed code exchange: show the login page again
    // rather than the user service's raw error body.
    console.error(`Google sign-in was rejected: HTTP ${upstream.status}`);
    return redirectTo(SIGN_IN_FAILED);
  }

  const response = redirectTo(location);
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}
