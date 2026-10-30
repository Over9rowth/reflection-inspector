import { build } from 'esbuild';
import { build as vite } from 'vite';

await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/main/index.cjs',
  external: ['electron'],
});
await build({
  entryPoints: ['src/preload/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/preload/index.cjs',
  external: ['electron'],
});
await vite({
  root: 'src/renderer',
  base: './',
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
