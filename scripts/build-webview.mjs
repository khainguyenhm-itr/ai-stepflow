import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'fs/promises';
import { join } from 'path';

const isWatch = process.argv.includes('--watch');

const context = await esbuild.context({
  entryPoints: ['packages/webview/src/index.tsx'],
  bundle: true,
  outfile: 'packages/extension/out/webview/main.js',
  format: 'esm',
  target: 'es2022',
  minify: !isWatch,
  sourcemap: isWatch,
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"'
  }
});

await mkdir('packages/extension/out/webview', { recursive: true });
await copyFile('packages/webview/public/index.html', 'packages/extension/out/webview/index.html');

if (isWatch) {
  await context.watch();
  console.log('Watching @ai-stepflow/webview...');
} else {
  await context.rebuild();
  await context.dispose();
  console.log('Webview UI built.');
}
