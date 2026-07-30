/**
 * vscodeStub.ts — the slice of the `vscode` API the extension's unit tests need.
 *
 * The extension package previously had no unit tests at all: every module that imports `vscode`
 * could only be exercised inside a real VS Code host (slow, and awkward to assert on). This stub is
 * substituted for the `vscode` bare specifier by `vscodeLoader.mjs`, so modules like ConfigManager
 * and TerminalManager can be imported and driven directly from `node --test`.
 *
 * Deliberately minimal: only what the modules under test actually touch, plus recorders so a test
 * can assert on what the extension told VS Code to do. Extend it as more modules gain tests.
 */

// ---------------------------------------------------------------------------
// Recorders — a test reads these to assert on host interactions.
// ---------------------------------------------------------------------------

export interface RecordedTerminal {
  options: { name: string; cwd?: string; color?: unknown };
  /** Every `sendText(text, submit)` call, in order. */
  sent: { text: string; submit: boolean }[];
  /** Every `executeCommand(executable, args)` call, in order. */
  executed: { executable: string; args: string[] }[];
  shown: number;
  disposed: boolean;
  shellIntegration?: unknown;
  exitStatus?: unknown;
  show(): void;
  sendText(text: string, submit?: boolean): void;
  dispose(): void;
}

export const recorder = {
  terminals: [] as RecordedTerminal[],
  infoMessages: [] as string[],
  errorMessages: [] as string[],
  warnMessages: [] as string[],
  /** What `window.showWarningMessage` resolves to (e.g. the button the user clicked). */
  warnResult: undefined as unknown,
  /** What `window.showQuickPick` resolves to (the picked item, or undefined for a dismissal). */
  quickPickResult: undefined as unknown,
  /** Every `showQuickPick(items, …)` call's items, in order. */
  quickPicks: [] as unknown[][],
  /** Values returned by `workspace.getConfiguration('claudesteps').get(key, default)`. */
  config: new Map<string, unknown>(),
  /** What `window.createTerminal` attaches as `shellIntegration` (undefined = unavailable). */
  shellIntegrationForNewTerminals: undefined as unknown,
  /** What `env.shell` reports. */
  shell: '/bin/zsh',
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  reset(): void {
    this.terminals = [];
    this.infoMessages = [];
    this.errorMessages = [];
    this.warnMessages = [];
    this.warnResult = undefined;
    this.quickPickResult = undefined;
    this.quickPicks = [];
    this.config = new Map();
    this.shellIntegrationForNewTerminals = undefined;
    this.shell = '/bin/zsh';
    this.workspaceFolders = undefined;
  },
};

/** Build a fake shell integration that records `executeCommand` calls onto its terminal. */
export function fakeShellIntegration(): { executeCommand(executable: string, args?: string[]): object } {
  return {
    executeCommand(executable: string, args?: string[]) {
      const term = recorder.terminals[recorder.terminals.length - 1];
      term?.executed.push({ executable, args: args ?? [] });
      return { __execution: true };
    },
  };
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

class StubDisposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose(): void { this.fn(); }
}

/** An event that never fires — enough for constructors that only subscribe. */
function noopEvent(): (listener: unknown) => StubDisposable {
  return () => new StubDisposable();
}

export const Disposable = StubDisposable;

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class EventEmitter<T> {
  private _listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void): StubDisposable => {
    this._listeners.push(listener);
    return new StubDisposable(() => {
      this._listeners = this._listeners.filter(l => l !== listener);
    });
  };
  fire(data: T): void { for (const l of [...this._listeners]) l(data); }
  dispose(): void { this._listeners = []; }
}

export const Uri = {
  file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
    fsPath: [base.fsPath, ...parts].join('/'),
    path: [base.fsPath, ...parts].join('/'),
    scheme: 'file',
  }),
};

export const window = {
  createTerminal(options: { name: string; cwd?: string; color?: unknown }): RecordedTerminal {
    const term: RecordedTerminal = {
      options,
      sent: [],
      executed: [],
      shown: 0,
      disposed: false,
      shellIntegration: recorder.shellIntegrationForNewTerminals,
      show() { this.shown++; },
      sendText(text: string, submit = true) { this.sent.push({ text, submit }); },
      dispose() { this.disposed = true; },
    };
    recorder.terminals.push(term);
    return term;
  },
  showInformationMessage(message: string): Promise<undefined> {
    recorder.infoMessages.push(message);
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string): Promise<undefined> {
    recorder.errorMessages.push(message);
    return Promise.resolve(undefined);
  },
  showWarningMessage(message: string): Promise<unknown> {
    recorder.warnMessages.push(message);
    return Promise.resolve(recorder.warnResult);
  },
  showQuickPick(items: unknown[]): Promise<unknown> {
    recorder.quickPicks.push(items);
    return Promise.resolve(recorder.quickPickResult);
  },
  onDidEndTerminalShellExecution: noopEvent(),
  onDidCloseTerminal: noopEvent(),
  onDidChangeTerminalShellIntegration: noopEvent(),
  onDidChangeActiveColorTheme: noopEvent(),
};

export const workspace = {
  get workspaceFolders() { return recorder.workspaceFolders; },
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const full = section ? `${section}.${key}` : key;
        return (recorder.config.has(full) ? recorder.config.get(full) : defaultValue) as T | undefined;
      },
      update(): Promise<void> { return Promise.resolve(); },
    };
  },
  onDidSaveTextDocument: noopEvent(),
  onDidChangeWorkspaceFolders: noopEvent(),
  createFileSystemWatcher() {
    return { onDidCreate: noopEvent(), onDidChange: noopEvent(), onDidDelete: noopEvent(), dispose() {} };
  },
};

export const env = {
  get shell() { return recorder.shell; },
};

export const commands = {
  registerCommand: () => new StubDisposable(),
  executeCommand: () => Promise.resolve(undefined),
};

export const extensions = {
  getExtension: () => undefined,
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ViewColumn = { One: 1, Two: 2, Active: -1, Beside: -2 };
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
