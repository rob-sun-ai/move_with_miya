import { config } from 'dotenv';
import { resolve } from 'node:path';

// Imported first by main.ts so that every later module, including telemetry,
// sees the variables from the shared .env file.
config({ path: resolve(process.cwd(), '../.env') });
