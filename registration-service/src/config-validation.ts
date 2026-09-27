const PLACEHOLDERS = [
  'change-me',
  'guest',
  'localhost',
  'example.com',
  'example.org',
];

export function assertProductionConfig(keys: string[]): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length)
    throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  for (const key of keys) {
    const value = process.env[key]?.toLowerCase() ?? '';
    if (PLACEHOLDERS.some((placeholder) => value.includes(placeholder))) {
      throw new Error(`${key} contains a placeholder value`);
    }
  }
}
