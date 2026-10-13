import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/app/server.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        statements: 95, branches: 90, functions: 100, lines: 95,
        'src/modules/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/shared/schemas/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
