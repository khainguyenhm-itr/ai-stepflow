import { useEffect, useRef } from 'react';
import { isVSCodeWebview, sendToVSCode } from '../vscode';

/**
 * Wire the webview ↔ extension message channel. Registers a single `message`
 * listener for the component's lifetime, dispatching each message to the latest
 * `onMessage` via a ref so the listener never goes stale. On mount it sends the
 * `ready` handshake to the host, or invokes `onPreviewInit` in browser preview.
 */
export function useVsCodeBridge(onMessage: (message: any) => void, onPreviewInit: () => void) {
  const messageRef = useRef(onMessage);
  const previewRef = useRef(onPreviewInit);
  messageRef.current = onMessage;
  previewRef.current = onPreviewInit;

  useEffect(() => {
    const listener = (event: MessageEvent) => messageRef.current(event.data);
    window.addEventListener('message', listener);
    if (isVSCodeWebview()) {
      sendToVSCode('ready');
    } else {
      previewRef.current();
    }
    return () => window.removeEventListener('message', listener);
  }, []);
}
