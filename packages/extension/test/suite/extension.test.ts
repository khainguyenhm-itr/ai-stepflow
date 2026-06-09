import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'khainguyen.ai-stepflow';

describe('AI StepFlow integration (real VS Code host)', () => {
  it('is present, activates, and registers its contributed commands', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension "${EXTENSION_ID}" should be discovered by the host`);

    await ext!.activate();
    assert.ok(ext!.isActive, 'extension should be active after activate()');

    const commands = await vscode.commands.getCommands(true);
    for (const id of ['ai-stepflow.openOverview', 'ai-stepflow.refreshAll', 'ai-stepflow.installDefaults']) {
      assert.ok(commands.includes(id), `command "${id}" should be registered`);
    }
  });
});
