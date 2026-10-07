import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['apps/api/test/**/*.test.ts'],
      environment: 'node',
      globalSetup: ['apps/api/test/globalSetup.ts'],
      setupFiles: ['apps/api/test/env.ts'],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  },
]);
