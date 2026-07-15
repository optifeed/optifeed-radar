import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only; no network (hard rule #3 - fixtures only).
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
