import { resolve } from 'node:path';
import { config } from 'dotenv';

jest.mock('dotenv', () => ({ config: jest.fn() }));

describe('env', () => {
  it('loads the shared .env file on import', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./env');
    });

    expect(config).toHaveBeenCalledWith({
      path: resolve(process.cwd(), '../.env'),
    });
  });
});
