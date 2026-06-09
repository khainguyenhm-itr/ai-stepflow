import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

/**
 * In-host runner invoked by @vscode/test-electron once the extension host is up.
 * Loads every compiled *.test.js in this directory into Mocha and runs them.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 120_000 });
  const testsRoot = __dirname;
  for (const file of fs.readdirSync(testsRoot)) {
    if (file.endsWith('.test.js')) mocha.addFile(path.resolve(testsRoot, file));
  }
  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run(failures => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}
