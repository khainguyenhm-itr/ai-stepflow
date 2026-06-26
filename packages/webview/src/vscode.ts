declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage: (message: any) => void;
      getState: () => any;
      setState: (state: any) => void;
    };
  }
}

export const isVSCodeWebview = () =>
  typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function';

let vscodeApi: ReturnType<NonNullable<Window['acquireVsCodeApi']>> | undefined;

export function getVSCodeApi() {
  if (!isVSCodeWebview()) return undefined;
  if (!vscodeApi) {
    vscodeApi = window.acquireVsCodeApi!();
  }
  return vscodeApi;
}

/** Post a message to the extension host; in browser preview it just logs. */
export function sendToVSCode(type: string, payload: Record<string, unknown> = {}) {
  if (!isVSCodeWebview()) {
    console.info('[AI StepFlow preview]', { type, ...payload });
    return;
  }
  getVSCodeApi()?.postMessage({ type, ...payload });
}
