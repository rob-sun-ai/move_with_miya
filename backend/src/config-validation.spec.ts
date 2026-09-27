import { ConfigService } from '@nestjs/config';
import { assertProductionConfig } from './config-validation';

const KEYS = ['SESSION_SECRET', 'CORS_ORIGIN', 'PUBLIC_APP_URL'];
const valid = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'a'.repeat(32),
  CORS_ORIGIN: 'https://studio.test',
  PUBLIC_APP_URL: 'https://studio.test',
};

function check(overrides: Record<string, string | undefined>) {
  return () =>
    assertProductionConfig(new ConfigService({ ...valid, ...overrides }), KEYS);
}

describe('assertProductionConfig', () => {
  it('accepts strong production configuration', () => {
    expect(check({})).not.toThrow();
  });

  it('skips validation outside production', () => {
    expect(
      check({ NODE_ENV: 'development', SESSION_SECRET: undefined }),
    ).not.toThrow();
  });

  it('only validates the keys it is given', () => {
    expect(() =>
      assertProductionConfig(
        new ConfigService({
          NODE_ENV: 'production',
          REDIS_URL: 'redis://redis:6379',
          SESSION_SECRET: 'short',
          CORS_ORIGIN: 'http://insecure.test',
        }),
        ['REDIS_URL'],
      ),
    ).not.toThrow();
  });

  it('lists every missing key', () => {
    expect(() =>
      assertProductionConfig(new ConfigService({ NODE_ENV: 'production' }), [
        'SESSION_SECRET',
        'CORS_ORIGIN',
      ]),
    ).toThrow('Missing production configuration: SESSION_SECRET, CORS_ORIGIN');
  });

  it.each([
    'change-me-now',
    'DEV-SECRET-CHANGE-IN-PRODUCTION-0000000000000',
    'guest-account',
    'redis://localhost:6379',
    'https://example.com',
    'https://example.org',
  ])('rejects placeholder %p regardless of case', (value) => {
    expect(() =>
      assertProductionConfig(
        new ConfigService({ NODE_ENV: 'production', REDIS_URL: value }),
        ['REDIS_URL'],
      ),
    ).toThrow('REDIS_URL contains a placeholder value');
  });

  it('rejects a CORS origin with a trailing slash', () => {
    expect(check({ CORS_ORIGIN: 'https://studio.test/' })).toThrow(
      'single HTTPS origin',
    );
  });

  it.each([
    [{ SESSION_SECRET: undefined }, 'Missing production configuration'],
    [{ SESSION_SECRET: 'short' }, 'at least 32 characters'],
    [{ SESSION_SECRET: `change-me-${'a'.repeat(32)}` }, 'placeholder'],
    [{ CORS_ORIGIN: 'http://studio.test' }, 'single HTTPS origin'],
    [{ CORS_ORIGIN: 'https://studio.test/app' }, 'single HTTPS origin'],
    [{ PUBLIC_APP_URL: 'not a url' }, 'valid HTTPS URL'],
  ])('rejects %o', (overrides, message) => {
    expect(check(overrides)).toThrow(message);
  });
});
