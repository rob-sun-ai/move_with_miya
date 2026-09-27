import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

export interface VerifiedUser {
  banned?: boolean;
  yogaExperience?: string | null;
}

/** Loads a user from the user service and rejects banned accounts. */
export async function fetchActiveUser(
  userServiceUrl: string,
  userId: string,
): Promise<VerifiedUser> {
  let response: Response;
  try {
    response = await fetch(
      `${userServiceUrl}/users/${encodeURIComponent(userId)}`,
      { signal: AbortSignal.timeout(5000) },
    );
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
