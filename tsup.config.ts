import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
});
