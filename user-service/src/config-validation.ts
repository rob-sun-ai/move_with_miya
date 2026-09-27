import type { ConfigService } from '@nestjs/config';

const PLACEHOLDERS = [
  'change-me',
  'dev-secret-change-in-production',
  'guest',
  'localhost',
  'example.com',
  'example.org',
];
const MIN_SESSION_SECRET_LENGTH = 32;

/** Fails production boots on missing or placeholder configuration. */
export function assertProductionConfig(
  config: ConfigService,
  keys: string[],
): void {
  if (config.get<string>('NODE_ENV') !== 'production') return;
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const key of keys) {
    const value = config.get<string>(key);
    if (value) values.set(key, value);
    else missing.push(key);
  }
  if (missing.length)
    throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  for (const [key, value] of values) {
    const normalized = value.toLowerCase();
    if (PLACEHOLDERS.some((placeholder) => normalized.includes(placeholder))) {
      throw new Error(`${key} contains a placeholder value`);
    }
  }

  const sessionSecret = values.get('SESSION_SECRET');
  if (
    sessionSecret !== undefined &&
    sessionSecret.length < MIN_SESSION_SECRET_LENGTH
  ) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production`,
    );
  }
  const corsOrigin = values.get('CORS_ORIGIN');
  if (
    corsOrigin !== undefined &&
    parseHttpsUrl(corsOrigin)?.origin !== corsOrigin
  ) {
    throw new Error('CORS_ORIGIN must be a single HTTPS origin in production');
  }
  const publicAppUrl = values.get('PUBLIC_APP_URL');
  if (publicAppUrl !== undefined && !parseHttpsUrl(publicAppUrl)) {
    throw new Error('PUBLIC_APP_URL must be a valid HTTPS URL in production');
  }
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
