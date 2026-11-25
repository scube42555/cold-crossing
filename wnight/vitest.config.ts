import { defineConfig } from 'vitest/config';

// Only the in-memory simulator tests live under vitest. They need no network,
// no proof server and no funds. The Preprod flow is the scripts in cli/src.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['contract/src/test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
