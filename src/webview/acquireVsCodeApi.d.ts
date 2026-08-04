/**
 * Minimal shape of the VS Code webview API injected into the webview before
 * our script runs. Declared as a global so the compiled modules type-check
 * with the DOM lib (the real `acquireVsCodeApi` is a global in the webview,
 * and the test harnesses stub `window.acquireVsCodeApi`).
 */
interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
