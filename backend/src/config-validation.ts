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
  const missing = keys.filter((key) => !config.get<string>(key));
  if (missing.length)
    throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  for (const key of keys) {
    const value = config.get<string>(key)?.toLowerCase() ?? '';
    if (PLACEHOLDERS.some((placeholder) => value.includes(placeholder))) {
      throw new Error(`${key} contains a placeholder value`);
    }
  }
  const value = (key: string) => config.get<string>(key) ?? '';
  if (
    keys.includes('SESSION_SECRET') &&
    value('SESSION_SECRET').length < MIN_SESSION_SECRET_LENGTH
  ) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production`,
    );
  }
  if (keys.includes('CORS_ORIGIN')) {
    const origin = parseHttpsUrl(value('CORS_ORIGIN'));
    if (origin?.origin !== value('CORS_ORIGIN')) {
      throw new Error(
        'CORS_ORIGIN must be a single HTTPS origin in production',
      );
    }
  }
  if (
    keys.includes('PUBLIC_APP_URL') &&
    !parseHttpsUrl(value('PUBLIC_APP_URL'))
  ) {
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
