import type { ConfigService } from '@nestjs/config';

const PLACEHOLDER_VALUES = [
  'change-me',
  'change-me-to-a-random-string',
  'dev-secret-change-in-production',
  'guest',
  'localhost',
  'example.com',
  'example.org',
];

export function assertProductionConfig(
  config: ConfigService,
  requiredKeys: string[],
): void {
  if (config.get<string>('NODE_ENV') !== 'production') return;
  const missing = requiredKeys.filter((key) => !config.get<string>(key));
  if (missing.length > 0) {
    throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  }
  for (const key of requiredKeys) {
    const value = config.get<string>(key)?.toLowerCase() ?? '';
    if (PLACEHOLDER_VALUES.some((placeholder) => value.includes(placeholder))) {
      throw new Error(`${key} contains a placeholder value`);
    }
  }
}
