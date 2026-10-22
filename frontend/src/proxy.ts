import { NextRequest, NextResponse } from 'next/server';
import { USER_SERVICE_URL } from '@/lib/env';

const SESSION_COOKIE = 'connect.sid';

// Gates the signed-in areas before they render. The pages and the API still
// verify the session and role themselves; this only saves a round trip of
// server rendering for visitors who are clearly signed out.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const redirectToLogin = () => {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  };

  if (!request.cookies.has(SESSION_COOKIE)) {
    return redirectToLogin();
  }

  try {
    const res = await fetch(`${USER_SERVICE_URL}/auth/me`, {
      headers: { cookie: request.headers.get('cookie') ?? '' },
      cache: 'no-store',
    });
    if (!res.ok) {
      return redirectToLogin();
    }
  } catch (error) {
    console.error('Middleware auth verification failed:', error);
    return redirectToLogin();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*'],
};
