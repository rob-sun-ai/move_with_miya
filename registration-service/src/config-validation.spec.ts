import { assertProductionConfig } from './config-validation';

describe('assertProductionConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://svc:secret@postgres:5432/db',
      RABBITMQ_URL: 'amqp://svc:secret@rabbitmq:5672',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('accepts complete production configuration', () => {
    expect(() =>
      assertProductionConfig(['DATABASE_URL', 'RABBITMQ_URL']),
    ).not.toThrow();
  });

  it('skips validation outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;

    expect(() => assertProductionConfig(['DATABASE_URL'])).not.toThrow();
  });

  it('lists every missing key', () => {
    delete process.env.DATABASE_URL;
    process.env.RABBITMQ_URL = '';

    expect(() =>
      assertProductionConfig(['DATABASE_URL', 'RABBITMQ_URL']),
    ).toThrow('Missing production configuration: DATABASE_URL, RABBITMQ_URL');
  });

  it.each([
    'amqp://guest:guest@rabbitmq:5672',
    'postgresql://svc:CHANGE-ME@postgres:5432/db',
    'postgresql://svc:secret@localhost:5432/db',
    'postgresql://svc:dev-secret-change-in-production@db:5432/db',
    'https://example.com',
    'https://example.org',
  ])('rejects placeholder %p', (value) => {
    process.env.RABBITMQ_URL = value;

    expect(() => assertProductionConfig(['RABBITMQ_URL'])).toThrow(
      'RABBITMQ_URL contains a placeholder value',
    );
  });
});
