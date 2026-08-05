/**
 * Message contracts between the webview and the extension host. Kept in
 * sync with `src/previewHost.ts` (posts `HostMessage`s) and
 * `src/previewManager.ts` (handles `WebviewMessage`s).
 */

/** Host -> webview (see `PreviewHost.post`). */
export type HostMessage =
	| { type: 'setDoc'; name: string }
	| { type: 'render'; html: string }
	| { type: 'empty' }
	| { type: 'scrollToLine'; line: number }
	| { type: 'cursorLine'; line: number };

/** Webview -> host (see `PreviewManager.onHostMessage`). */
export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'openLink'; href: string }
	| { type: 'scrollLine'; line: number }
	| { type: 'command'; id: string };
