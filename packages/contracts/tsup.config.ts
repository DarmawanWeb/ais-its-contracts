import { defineConfig } from 'tsup';

/** Public entry points; keep in sync with `exports` in package.json. */
const ENTRIES = ['events', 'auth', 'domain', 'realtime', 'api'] as const;

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ...Object.fromEntries(
      ENTRIES.map((name) => [`${name}/index`, `src/${name}/index.ts`]),
    ),
  },
  format: ['esm', 'cjs'],
  platform: 'neutral',
  target: 'es2023',
  tsconfig: 'tsconfig.build.json',
  dts: true,
  sourcemap: true,
  splitting: true,
  clean: true,
  outDir: 'dist',
});
