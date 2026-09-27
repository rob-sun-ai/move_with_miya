const PLACEHOLDERS = [
  'change-me',
  'dev-secret-change-in-production',
  'guest',
  'localhost',
  'example.com',
  'example.org',
];

/** Fails production boots on missing or placeholder configuration. */
export function assertProductionConfig(keys: string[]): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length)
    throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  for (const key of keys) {
    // Every key is set: missing ones were rejected above.
    const value = (process.env[key] as string).toLowerCase();
    if (PLACEHOLDERS.some((placeholder) => value.includes(placeholder))) {
      throw new Error(`${key} contains a placeholder value`);
    }
  }
}
