export default {
  'backend/**/*.ts': [
    'prettier --write --log-level=error',
    'eslint --fix --config backend/eslint.config.mjs',
  ],
  'frontend/**/*.{ts,tsx,js,jsx}': [
    'prettier --write --log-level=error',
    'eslint --fix --config frontend/eslint.config.mjs',
  ],
  'user-service/**/*.ts': [
    'prettier --write --log-level=error',
    'eslint --fix --config user-service/eslint.config.mjs',
  ],
  'classes-service/**/*.ts': [
    'prettier --write --log-level=error',
    'eslint --fix --config classes-service/eslint.config.mjs',
  ],
  'registration-service/**/*.ts': [
    'prettier --write --log-level=error',
    'eslint --fix --config registration-service/eslint.config.mjs',
  ],
  // CI checks Prettier on every file, including workflows and Compose files.
  '*.{json,yml,yaml}': 'prettier --write --log-level=error',
};
