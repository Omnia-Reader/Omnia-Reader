import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['apps/sync-gateway/src/**/*.spec.ts'],
  },
});
