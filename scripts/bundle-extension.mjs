import * as esbuild from 'esbuild';
import { join } from 'path';

const isWatch = process.argv.includes('--watch');

const commonOptions = {
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  external: ['vscode'],
};

async function build() {
  // Bundle the extension
  const extensionContext = await esbuild.context({
    ...commonOptions,
    entryPoints: ['packages/extension/src/extension.ts'],
    outfile: 'packages/extension/out/extension.js',
  });

  // Bundle the CLI
  const cliContext = await esbuild.context({
    ...commonOptions,
    entryPoints: ['packages/extension/src/cli.ts'],
    outfile: 'packages/extension/out/cli.js',
    banner: {
      js: '#!/usr/bin/env node',
    },
  });

  // Bundle the uninstall script
  const uninstallContext = await esbuild.context({
    ...commonOptions,
    entryPoints: ['packages/extension/src/uninstall.ts'],
    outfile: 'packages/extension/out/uninstall.js',
  });

  if (isWatch) {
    await Promise.all([
      extensionContext.watch(),
      cliContext.watch(),
      uninstallContext.watch(),
    ]);
    console.log('Watching @ai-stepflow/extension...');
  } else {
    await Promise.all([
      extensionContext.rebuild(),
      cliContext.rebuild(),
      uninstallContext.rebuild(),
    ]);
    await Promise.all([
      extensionContext.dispose(),
      cliContext.dispose(),
      uninstallContext.dispose(),
    ]);
    console.log('Extension bundled.');
  }
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
