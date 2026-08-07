/**
 * Message contracts between the webview and the extension host. Kept in
 * sync with `src/previewHost.ts` (posts `HostMessage`s) and
 * `src/previewManager.ts` (handles `WebviewMessage`s).
 */

export type MediaInvert = 'auto' | 'dark' | 'light' | 'off';
export type MediaTables = 'pan' | 'fit';

/** The media-control state the host broadcasts (backed by `hackerMarkdown.media.*` settings). */
export interface MediaState {
	readonly invert: MediaInvert;
	readonly columnWidth: string;
	readonly tables: MediaTables;
}

/** Host -> webview (see `PreviewHost.post`). */
export type HostMessage =
	| { type: 'setDoc'; name: string }
	| { type: 'render'; html: string }
	| { type: 'empty' }
	| { type: 'scrollToLine'; line: number }
	| { type: 'cursorLine'; line: number }
	| ({ type: 'mediaState' } & MediaState);

/** Webview -> host (see `PreviewManager.onHostMessage`). */
export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'openLink'; href: string }
	| { type: 'scrollLine'; line: number }
	| { type: 'command'; id: string }
	| { type: 'setMedia'; key: 'invert' | 'columnWidth' | 'tables'; value: string };
