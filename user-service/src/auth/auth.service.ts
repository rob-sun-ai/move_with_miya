import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import type { User } from '../generated/prisma/client';
import type { GoogleProfile } from '../users/interfaces/user.interface';

// The OpenID Connect userinfo endpoint returns the stable `sub` identifier and
// `email_verified`; the legacy oauth2/v2 endpoint returns `id` instead.
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  getGoogleAuthURL(state: string): string {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured');
    const redirectUri = this.configService.get<string>('GOOGLE_CALLBACK_URL');
    if (!redirectUri) throw new Error('GOOGLE_CALLBACK_URL is not configured');
    const scope = 'openid profile email';

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      prompt: 'select_account',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  getFrontendUrl(): string {
    return this.configService.get<string>(
      'CORS_ORIGIN',
      'http://localhost:5173',
    );
  }

  private getJsonString(raw: unknown, key: string): string {
    if (typeof raw !== 'object' || raw === null) return '';
    const value: unknown = Reflect.get(raw, key);
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    return '';
  }

  async exchangeCode(code: string): Promise<{ accessToken: string }> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.configService.get<string>('GOOGLE_CALLBACK_URL');

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('Google OAuth is not configured');
    }

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!resp.ok) {
      // Google's error body is for operators, not for the browser.
      this.logger.warn(
        `Google token exchange failed (${resp.status}): ${await resp.text()}`,
      );
      throw new UnauthorizedException('Google sign-in failed');
    }

    const raw: unknown = await resp.json();
    const accessToken = this.getJsonString(raw, 'access_token');
    if (!accessToken) throw new UnauthorizedException('Google sign-in failed');
    return { accessToken };
  }

  async fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
    const resp = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      throw new UnauthorizedException('Failed to fetch Google profile');
    }

    const raw: unknown = await resp.json();
    const profile: GoogleProfile = {
      sub: this.getJsonString(raw, 'sub'),
      email: this.getJsonString(raw, 'email'),
      given_name: this.getJsonString(raw, 'given_name'),
      family_name: this.getJsonString(raw, 'family_name'),
      picture: this.getJsonString(raw, 'picture') || undefined,
    };
    // Accounts are keyed by `sub` and matched by email, so both must be
    // present and the email must be one Google has verified.
    if (
      !profile.sub ||
      !profile.email ||
      Reflect.get(raw as object, 'email_verified') !== true
    ) {
      throw new UnauthorizedException('Google account has no verified email');
    }
    return profile;
  }

  async findOrCreateUser(profile: GoogleProfile): Promise<User> {
    const existing = await this.usersService.findByGoogleId(profile.sub);
    if (existing) {
      if (existing.banned) throw new ForbiddenException('User is banned');
      return this.usersService.updateLastLogin(existing.id);
    }

    const sameEmail = await this.usersService.findByEmail(profile.email);
    if (sameEmail) {
      // An email can move between Google accounts, so never hand an existing
      // account to a different Google identity. Rows written before sign-in
      // read `sub` from the right endpoint have an empty googleId; their owner
      // is the verified holder of the email.
      if (sameEmail.googleId !== '') {
        throw new ConflictException(
          'An account with this email is linked to a different Google account',
        );
      }
      if (sameEmail.banned) throw new ForbiddenException('User is banned');
      return this.usersService.linkGoogleAccount(sameEmail.id, profile.sub);
    }

    return this.usersService.create({
      googleId: profile.sub,
      email: profile.email,
      firstName: profile.given_name,
      lastName: profile.family_name ?? '',
      avatarUrl: profile.picture,
    });
  }
}
