import { readdirSync, unlinkSync, mkdirSync, copyFileSync, rmSync, existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';

const outputFile = 'ai-stepflow.vsix';
const rootDir = process.cwd();
const pkgDir = join(rootDir, 'packages/extension');
const tempDir = join(rootDir, 'out/package-temp');

// Clean existing vsix
for (const file of readdirSync(rootDir)) {
  if (file.endsWith('.vsix')) {
    unlinkSync(join(rootDir, file));
  }
}

// Clean and recreate temp dir
if (existsSync(tempDir)) {
  rmSync(tempDir, { recursive: true, force: true });
}
mkdirSync(tempDir, { recursive: true });

function copyRecursive(src, dest) {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    readdirSync(src).forEach(child => copyRecursive(join(src, child), join(dest, child)));
  } else {
    copyFileSync(src, dest);
  }
}

// Copy necessary files to temp dir
console.log('Preparing package in temp directory...');
copyFileSync(join(pkgDir, 'package.json'), join(tempDir, 'package.json'));
copyFileSync(join(pkgDir, 'LICENSE'), join(tempDir, 'LICENSE'));
if (existsSync(join(rootDir, 'README.md'))) {
  copyFileSync(join(rootDir, 'README.md'), join(tempDir, 'README.md'));
}
copyRecursive(join(pkgDir, 'out'), join(tempDir, 'out'));
copyRecursive(join(pkgDir, 'resources'), join(tempDir, 'resources'));

// Run vsce package from temp dir
console.log('Running vsce package...');
const result = spawnSync('npx', [
  '@vscode/vsce', 'package', 
  '--no-dependencies', 
  '--allow-missing-repository', 
  '--skip-license', 
  '--out', join(rootDir, outputFile)
], {
  cwd: tempDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) {
  throw result.error;
}

// Cleanup temp dir
rmSync(tempDir, { recursive: true, force: true });

process.exit(result.status ?? 1);
