import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Node-side entry: download a VS Code build and launch the extension host with this
 * extension loaded, pointing it at the in-host Mocha runner (./suite/index.js).
 * Compiled to out-itest/test/runIntegration.js, so the extension root is two levels up.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Isolate from any other installed extensions; ours (the dev extension) still loads.
      launchArgs: ['--disable-extensions']
    });
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exit(1);
  }
}

void main();
