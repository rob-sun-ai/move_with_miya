import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

const USER_SERVICE_TIMEOUT_MS = 5000;

export interface VerifiedUser {
  role?: string;
  banned?: boolean;
  yogaExperience?: string | null;
}

/** Public profile fields returned by the user service's batch lookup. */
export interface UserSummary {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  role: string;
}

/** The user service base URL; an empty setting falls back to local dev. */
export function userServiceUrl(
  configured: string | undefined = process.env.USER_SERVICE_URL,
): string {
  return configured || 'http://localhost:3003';
}

/** Loads a user from the user service and rejects banned accounts. */
export async function fetchActiveUser(
  baseUrl: string,
  userId: string,
): Promise<VerifiedUser> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/users/${encodeURIComponent(userId)}`, {
      signal: AbortSignal.timeout(USER_SERVICE_TIMEOUT_MS),
    });
  } catch {
    throw new ServiceUnavailableException('User service unreachable');
  }
  if (response.status >= 500) {
    throw new ServiceUnavailableException('User service error');
  }
  if (!response.ok) {
    throw new UnauthorizedException('Unable to verify user');
  }
  const user = (await response.json()) as VerifiedUser;
  if (user.banned) {
    throw new ForbiddenException('User is banned');
  }
  return user;
}

/**
 * Loads public profiles for display. Enrichment is best effort: an
 * unreachable or failing user service yields no profiles rather than failing
 * the listing that wanted them.
 */
export async function fetchUserSummaries(
  baseUrl: string,
  ids: string[],
): Promise<UserSummary[]> {
  if (ids.length === 0) return [];
  try {
    const response = await fetch(
      `${baseUrl}/users/batch?ids=${encodeURIComponent(ids.join(','))}`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(USER_SERVICE_TIMEOUT_MS),
      },
    );
    return response.ok ? ((await response.json()) as UserSummary[]) : [];
  } catch {
    return [];
  }
}
