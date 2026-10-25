import { USER_SERVICE_URL } from './env';
import type { AuthUser } from './types';

/**
 * Resolves the signed-in user for a server render by forwarding the
 * browser's cookies to the user service. Returns null when signed out or
 * when the user service cannot be reached.
 */
export async function getCurrentUser(
  cookieString: string,
): Promise<AuthUser | null> {
  if (!cookieString) return null;
  try {
    const res = await fetch(`${USER_SERVICE_URL}/auth/me`, {
      cache: 'no-store',
      headers: { cookie: cookieString },
    });
    if (!res.ok) return null;
    return (await res.json()) as AuthUser;
  } catch (error) {
    console.error('Failed to load the current user:', error);
    return null;
  }
}
