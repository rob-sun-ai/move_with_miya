import type { ConfigService } from '@nestjs/config';

const PLACEHOLDERS = [
  'change-me',
  'guest',
  'localhost',
  'example.com',
  'example.org',
];

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
}
