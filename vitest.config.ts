import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    maxWorkers: 4,
    testTimeout: 15000,
    coverage: { enabled: false },
  },
});
