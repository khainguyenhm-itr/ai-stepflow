import * as assert from 'assert';
import { validateMessage } from '../../src/messages.js';

describe('webview message validation', () => {
  it('accepts closeRun with finalize=true', () => {
    const message = validateMessage({ type: 'closeRun', finalize: true });
    assert.deepStrictEqual(message, { type: 'closeRun', finalize: true });
  });

  it('accepts closeRun without finalize', () => {
    const message = validateMessage({ type: 'closeRun' });
    assert.deepStrictEqual(message, { type: 'closeRun' });
  });

  it('rejects closeRun with non-boolean finalize', () => {
    const message = validateMessage({ type: 'closeRun', finalize: 'yes' });
    assert.strictEqual(message, null);
  });
});
