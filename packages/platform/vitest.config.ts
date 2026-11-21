import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** SWC keeps the decorator metadata Nest's dependency injection relies on. */
const decorators = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

export default defineConfig({
  plugins: [decorators],
  test: {
    environment: 'node',
    // The Ryuk reaper image is not available everywhere; containers are
    // stopped explicitly by the global setup and the tests.
    env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.int.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/index.ts'],
    },
  },
});
