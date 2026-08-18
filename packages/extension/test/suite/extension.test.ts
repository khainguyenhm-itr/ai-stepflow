import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'khainguyen.claudesteps';

describe('ClaudeSteps integration (real VS Code host)', () => {
  it('is present, activates, and registers its contributed commands', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension "${EXTENSION_ID}" should be discovered by the host`);

    await ext!.activate();
    assert.ok(ext!.isActive, 'extension should be active after activate()');

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'claudesteps.openOverview',
      'claudesteps.refreshAll',
      'claudesteps.installDefaults'
    ]) {
      assert.ok(commands.includes(id), `command "${id}" should be registered`);
    }
  });

  it('opens the cockpit and refreshes without throwing', async () => {
    await vscode.commands.executeCommand('claudesteps.openOverview');
    await vscode.commands.executeCommand('claudesteps.refreshAll');
  });

  it('keeps the extension active after the cockpit commands run', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should still be active');
    assert.ok(ext!.isActive, 'extension should remain active');
  });
});
