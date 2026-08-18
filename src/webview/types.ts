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
	/** `uri` is the document the preview shows — the webview persists it via `setState` so a serialized editor panel can be restored. */
	| { type: 'setDoc'; name: string; uri?: string }
	| { type: 'render'; html: string }
	| { type: 'empty' }
	| { type: 'scrollToLine'; line: number }
	| { type: 'cursorLine'; line: number }
	| { type: 'pinState'; pinned: boolean }
	| ({ type: 'mediaState' } & MediaState);

/** Webview -> host (see `PreviewManager.onHostMessage`). */
export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'openLink'; href: string }
	| { type: 'scrollLine'; line: number }
	| { type: 'command'; id: string }
	/** `from`/`to` are set when the click maps to a whole source range (a SALT block). */
	| { type: 'editorLine'; line: number; from?: number; to?: number }
	| { type: 'setMedia'; key: 'invert' | 'columnWidth' | 'tables'; value: string };
