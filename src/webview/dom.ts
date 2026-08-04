import type { WebviewMessage } from './types';

/** The `acquireVsCodeApi` handle for this webview instance. */
export const vscode = acquireVsCodeApi();

export const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
export const docNameEl = toolbar.querySelector<HTMLElement>('.doc-name')!;
export const previewEl = document.getElementById('preview')!;
export const emptyEl = document.getElementById('empty')!;

/** Typed wrapper around `vscode.postMessage`. */
export function post(message: WebviewMessage): void {
	vscode.postMessage(message);
}
