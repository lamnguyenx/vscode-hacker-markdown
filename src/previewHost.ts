import * as vscode from 'vscode';
import * as fs from 'fs';

export interface PreviewHostOptions {
	/** Show the "Open in Editor" button in the toolbar (docked view only). */
	readonly showOpenInEditor: boolean;
}

export interface PreviewHostMessage {
	type: string;
	[key: string]: unknown;
}

interface ContributedPreviewScript {
	readonly resource: vscode.Uri;
	readonly type?: 'module';
}

/**
 * A single markdown-preview webview, either a docked WebviewView or a
 * WebviewPanel in the editor area. All hosts of a {@link PreviewManager}
 * render the same active document and are kept in sync.
 */
export class PreviewHost {

	public readonly webview: vscode.Webview;
	public readonly onDisposed: vscode.Event<void>;

	private readonly extensionUri: vscode.Uri;
	private readonly options: PreviewHostOptions;
	private readonly onMessage: (message: PreviewHostMessage) => void;
	private readonly disposables: vscode.Disposable[] = [];

	private docName = '';
	private lastRenderedHtml = '';
	private isEmpty = true;
	private extraRoots: vscode.Uri[] = [];

	constructor(
		webview: vscode.Webview,
		onDisposed: vscode.Event<void>,
		extensionUri: vscode.Uri,
		options: PreviewHostOptions,
		onMessage: (message: PreviewHostMessage) => void,
	) {
		this.webview = webview;
		this.onDisposed = onDisposed;
		this.extensionUri = extensionUri;
		this.options = options;
		this.onMessage = onMessage;

		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'build')]
		};

		webview.html = this.buildHtml();
		this.disposables.push(webview.onDidReceiveMessage((message) => this.onMessage(message as PreviewHostMessage)));
	}

	public setResourceRoots(extraRoots: readonly vscode.Uri[]): void {
		this.extraRoots = [...extraRoots];
		this.applyResourceRoots();
	}

	private applyResourceRoots(): void {
		this.webview.options = {
			...this.webview.options,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'build'),
				...this.extraRoots,
				...this.styleResourceRoots(),
				...this.contributedPreviewRoots()
			]
		};
	}

	/**
	 * Custom styles may live anywhere on disk (`file://` or absolute paths),
	 * so the parent folders must be added to `localResourceRoots` or the
	 * webview will refuse to load them.
	 */
	private styleResourceRoots(): vscode.Uri[] {
		const roots: vscode.Uri[] = [];
		for (const style of this.customStyles()) {
			if (/^file:/i.test(style)) {
				roots.push(vscode.Uri.joinPath(vscode.Uri.parse(style), '..'));
			} else if (isAbsolutePath(style) && fs.existsSync(style)) {
				roots.push(vscode.Uri.joinPath(vscode.Uri.file(style), '..'));
			}
		}
		return roots;
	}

	public setDocument(uri: vscode.Uri): void {
		this.docUri = uri;
		this.docName = uri.path.split('/').pop() || 'Preview';
		// The webview persists the uri via `setState` so a serialized editor
		// panel (window reload / move to another window) can be restored to
		// the same document.
		this.post({ type: 'setDoc', name: this.docName, uri: uri.toString() });
	}

	public render(fragment: string): void {
		this.lastRenderedHtml = fragment;
		this.isEmpty = false;
		this.post({ type: 'render', html: fragment });
	}

	public empty(): void {
		this.lastRenderedHtml = '';
		this.isEmpty = true;
		this.post({ type: 'empty' });
	}

	/**
	 * Rebuilds the webview HTML from scratch (new styles take effect). The
	 * previous document state is re-posted so the preview does not blank out.
	 * The state messages are deferred past the HTML swap so the page re-render
	 * triggered by the content update cannot race them.
	 */
	public rebuild(): void {
		this.applyResourceRoots();
		this.webview.html = this.buildHtml();
		setTimeout(() => {
			if (this.isEmpty) {
				this.post({ type: 'empty' });
			} else {
				this.post({ type: 'setDoc', name: this.docName });
				this.post({ type: 'render', html: this.lastRenderedHtml });
			}
		}, 50);
	}

	public scrollToLine(line: number): void {
		this.post({ type: 'scrollToLine', line });
	}

	public cursorLine(line: number): void {
		this.post({ type: 'cursorLine', line });
	}

	public post(message: PreviewHostMessage): void {
		void this.webview.postMessage(message);
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}

	/**
	 * Webview asset (bundle or css) served from `build/` — the compiled
	 * build dir (esbuild + copied copy of src/media/*), mtime-busted like
	 * media used to be.
	 */
	private cacheBustBuild(relativePath: string): string {
		const file = vscode.Uri.joinPath(this.extensionUri, 'build', relativePath);
		return this.cacheBust(this.webview.asWebviewUri(file).toString(), file.fsPath);
	}

	private buildHtml(): string {
		const nonce = getNonce();
		const cspSource = this.webview.cspSource;

		// Cache-busted by mtime so a rebuilt page never serves stale assets
		// (the webview resource server otherwise caches index.js / css).
		const mainCss = this.cacheBustBuild('main.css');
		const markdownCss = this.cacheBustBuild('markdown.css');
		const highlightCss = this.cacheBustBuild('highlight.css');
		const mediaCss = this.cacheBustBuild('media.css');
		const mainJs = this.cacheBustBuild('index.js');

		return /* html */ `<!DOCTYPE html>
			<html style="${escapeAttribute(this.getSettingsOverrideStyles())}">
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="
					default-src 'none';
					img-src ${cspSource} https: data: http://localhost:* http://127.0.0.1:*;
					media-src ${cspSource} https: data: http://localhost:* http://127.0.0.1:*;
					script-src 'nonce-${nonce}';
					style-src ${cspSource} 'unsafe-inline' https:;
					font-src ${cspSource} https: data:;
					">

				<link rel="stylesheet" type="text/css" href="${markdownCss}">
				<link rel="stylesheet" type="text/css" href="${highlightCss}">
				<link rel="stylesheet" type="text/css" href="${mainCss}">
				<link rel="stylesheet" type="text/css" href="${mediaCss}">
				${this.getContributedStyles()}
				${this.getUserStyles()}
			</head>
			<body class="vscode-body" ${this.getMediaAttrs()}>
				<div class="toolbar" role="toolbar">
					<span class="doc-name" title=""></span>
					<span class="spacer"></span>
					<span class="toolbar-separator" role="separator"></span>
					${this.getMediaControls()}
					<span class="toolbar-separator" role="separator"></span>
					<button title="Pin Preview" class="toolbar-button" data-command="togglePin" aria-pressed="false" aria-label="Pin to this document"><span class="hmk-pin-icon">${svgPin}</span><span class="hmk-unpin-icon" hidden>${svgUnpin}</span></button>
					<button title="Refresh" class="toolbar-button" data-command="refresh" aria-label="Refresh">${svgRefresh}</button>
					<button title="Open Source File" class="toolbar-button" data-command="openSource" aria-label="Open Source File">${svgFile}</button>
					${this.options.showOpenInEditor
						? `<button title="Open in Editor" class="toolbar-button" data-command="openInEditor" aria-label="Open in Editor">${svgEditor}</button>`
						: ''}
				</div>
				<div class="markdown-body" id="preview" dir="auto"></div>
				<div class="empty-state" id="empty" hidden>
					<p>Open a Markdown file to preview it here.</p>
					<p class="hint">The preview follows the active editor. Drag this view to any sidebar or panel container to re-dock it.</p>
				</div>
				<script src="${mainJs}" nonce="${nonce}"></script>
				${this.getContributedScripts(nonce)}
			</body>
			</html>`;
	}

	/** Mirrors `markdown.preview.fontFamily/fontSize/lineHeight` overrides. */
	private getSettingsOverrideStyles(): string {
		const config = vscode.workspace.getConfiguration('markdown.preview');
		const out: string[] = [];
		const fontFamily = config.get<string>('fontFamily');
		if (fontFamily) {
			out.push(`--markdown-font-family: ${fontFamily};`);
		}
		const fontSize = config.get<number>('fontSize');
		if (typeof fontSize === 'number' && !isNaN(fontSize)) {
			out.push(`--markdown-font-size: ${fontSize}px;`);
		}
		const lineHeight = config.get<number>('lineHeight');
		if (typeof lineHeight === 'number' && !isNaN(lineHeight)) {
			out.push(`--markdown-line-height: ${lineHeight};`);
		}
		// Reading column width: user styles read `max-width: var(--hmk-column-width)`;
		// the webview also updates this property live while the toolbar input is
		// typed in. Invalid values fall back to 100%.
		out.push(`--hmk-column-width: ${this.getColumnWidth()};`);
		return out.join(' ');
	}

	/** `hackerMarkdown.media.columnWidth` if it is a valid CSS length, else `100%`. */
	private getColumnWidth(): string {
		const value = vscode.workspace.getConfiguration('hackerMarkdown').get<string>('media.columnWidth', '100%');
		return isCssLength(value) ? value : '100%';
	}

	/** The body state attributes consumed by user styles (`data-invert`/`data-tables`). */
	private getMediaAttrs(): string {
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		const invert = config.get<string>('media.invert', 'auto');
		const tables = config.get<string>('media.tables', 'pan');
		return [
			`data-invert="${['auto', 'dark', 'light', 'off'].includes(invert) ? invert : 'auto'}"`,
			`data-tables="${tables === 'fit' ? 'fit' : 'pan'}"`
		].join(' ');
	}

	/**
	 * The media controls: an invert-mode dropdown, a table-handling dropdown
	 * and a reading-column-width input with a reset button. The webview wires
	 * the dropdowns/input in `src/webview/menus.ts`; the reset button posts a
	 * `command` message handled by `previewManager.ts`.
	 */
	private getMediaControls(): string {
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		const invert = config.get<string>('media.invert', 'auto');
		const tables = config.get<string>('media.tables', 'pan');
		const columnWidth = this.getColumnWidth();
		const invertItem = (value: string, label: string) =>
			`<button class="hmk-menu-item" role="menuitemradio" aria-checked="${invert === value}" data-value="${value}">${label}</button>`;
		const tablesItem = (value: string, label: string) =>
			`<button class="hmk-menu-item" role="menuitemradio" aria-checked="${tables === value}" data-value="${value}">${label}</button>`;
		return /* html */ `
				<div class="hmk-menu" data-menu-key="invert">
					<button class="toolbar-button" data-menu="invert" aria-haspopup="menu" aria-expanded="false" title="Media invert: ${invert}" aria-label="Media invert mode: ${invert}">${svgInvert}</button>
					<div class="hmk-menu-panel" role="menu" aria-label="Media invert mode" hidden>
						${invertItem('auto', 'auto')}
						${invertItem('dark', 'dark')}
						${invertItem('light', 'light')}
						${invertItem('off', 'off')}
					</div>
				</div>
				<div class="hmk-menu" data-menu-key="tables">
					<button class="toolbar-button" data-menu="tables" aria-haspopup="menu" aria-expanded="false" title="Wide tables: ${tables}" aria-label="Wide table handling: ${tables}">${svgTables}</button>
					<div class="hmk-menu-panel" role="menu" aria-label="Wide table handling" hidden>
						${tablesItem('pan', 'pan')}
						${tablesItem('fit', 'fit')}
					</div>
				</div>
				<div class="hmk-column-control" title="Reading column width (CSS length)">
					<input class="toolbar-input" type="text" value="${escapeAttribute(columnWidth)}" aria-label="Reading column width" spellcheck="false" autocomplete="off">
					<button class="toolbar-button" data-command="resetColumn" title="Reset column width to 100%" aria-label="Reset column width to 100%">${svgReset}</button>
				</div>`;
	}

	/** User styles from the built-in `markdown.styles` + `hackerMarkdown.styles`. */
	private getUserStyles(): string {
		const styles = [
			...(vscode.workspace.getConfiguration('markdown').get<string[]>('styles') ?? []),
			...this.customStyles()
		];
		const out: string[] = [];
		for (const style of styles) {
			try {
				const href = this.resolveStyleHref(style);
				out.push(`<link rel="stylesheet" class="code-user-style" data-source="${escapeAttribute(style)}" href="${escapeAttribute(href)}" type="text/css" media="screen">`);
			} catch {
				// skip unresolvable styles
			}
		}
		return out.join('\n');
	}

	private customStyles(): string[] {
		return vscode.workspace.getConfiguration('hackerMarkdown').get<string[]>('styles') ?? [];
	}

	/**
	 * Preview scripts contributed by other extensions via
	 * `markdown.previewScripts` (e.g. `mermaid-markdown-features` renders
	 * `.mermaid` blocks in the built-in preview this way). Injected like the
	 * built-in preview does in `documentRenderer.ts#getScripts`.
	 */
	private contributedPreviewScripts(): ContributedPreviewScript[] {
		const scripts: ContributedPreviewScript[] = [];
		for (const extension of vscode.extensions.all) {
			const raw = extension.packageJSON?.contributes?.['markdown.previewScripts'];
			if (!Array.isArray(raw)) {
				continue;
			}
			for (const script of raw) {
				const contribution = getPreviewScriptContribution(script);
				if (!contribution) {
					continue;
				}
				try {
					scripts.push({
						resource: vscode.Uri.joinPath(extension.extensionUri, contribution.path),
						type: contribution.type
					});
				} catch {
					// skip unresolvable scripts
				}
			}
		}
		return scripts;
	}

	/** Styles contributed by other extensions via `markdown.previewStyles`. */
	private contributedPreviewStyles(): vscode.Uri[] {
		const styles: vscode.Uri[] = [];
		for (const extension of vscode.extensions.all) {
			const raw = extension.packageJSON?.contributes?.['markdown.previewStyles'];
			if (!Array.isArray(raw)) {
				continue;
			}
			for (const style of raw) {
				try {
					styles.push(vscode.Uri.joinPath(extension.extensionUri, style));
				} catch {
					// skip unresolvable styles
				}
			}
		}
		return styles;
	}

	/** Extension folders that contribute preview scripts/styles (needed as localResourceRoots). */
	private contributedPreviewRoots(): vscode.Uri[] {
		const roots: vscode.Uri[] = [];
		for (const extension of vscode.extensions.all) {
			const contributes = extension.packageJSON?.contributes;
			if (Array.isArray(contributes?.['markdown.previewScripts']) || Array.isArray(contributes?.['markdown.previewStyles'])) {
				roots.push(extension.extensionUri);
			}
		}
		return roots;
	}

	private getContributedStyles(): string {
		return this.contributedPreviewStyles()
			.map((style) => `<link rel="stylesheet" type="text/css" href="${escapeAttribute(this.webview.asWebviewUri(style).toString())}">`)
			.join('\n');
	}

	private getContributedScripts(nonce: string): string {
		return this.contributedPreviewScripts()
			.map((script) => {
				const type = script.type ? ` type="${escapeAttribute(script.type)}"` : '';
				return `<script async${type}
					src="${escapeAttribute(this.webview.asWebviewUri(script.resource).toString())}"
					nonce="${nonce}"
					charset="UTF-8"></script>`;
			})
			.join('\n');
	}

	private resolveStyleHref(style: string): string {
		if (/^https?:/i.test(style)) {
			return this.webview.asWebviewUri(vscode.Uri.parse(style)).toString();
		}
		if (/^file:/i.test(style)) {
			return this.cacheBust(this.webview.asWebviewUri(vscode.Uri.parse(style)).toString(), vscode.Uri.parse(style).fsPath);
		}
		if (isAbsolutePath(style) && fs.existsSync(style)) {
			return this.cacheBust(this.webview.asWebviewUri(vscode.Uri.file(style)).toString(), style);
		}
		if (style.startsWith('/')) {
			const folder = this.docUri ? vscode.workspace.getWorkspaceFolder(this.docUri) : undefined;
			const root = folder ?? vscode.workspace.workspaceFolders?.[0];
			if (root) {
				return this.cacheBust(this.webview.asWebviewUri(vscode.Uri.joinPath(root.uri, style)).toString(), vscode.Uri.joinPath(root.uri, style).fsPath);
			}
			return style;
		}
		if (this.docUri && this.docUri.scheme === 'file') {
			const file = vscode.Uri.joinPath(vscode.Uri.joinPath(this.docUri, '..'), style);
			return this.cacheBust(this.webview.asWebviewUri(file).toString(), file.fsPath);
		}
		const root = vscode.workspace.workspaceFolders?.[0];
		if (root) {
			const file = vscode.Uri.joinPath(root.uri, style);
			return this.cacheBust(this.webview.asWebviewUri(file).toString(), file.fsPath);
		}
		return style;
	}

	/**
	 * Appends the file's modification time to the href so a rebuilt page never
	 * serves a stale cached stylesheet when the CSS file changes on disk.
	 */
	private cacheBust(href: string, fsPath: string): string {
		try {
			return `${href}?v=${fs.statSync(fsPath).mtimeMs}`;
		} catch {
			return href;
		}
	}

	/** The markdown document currently rendered by this host. */
	public docUri: vscode.Uri | undefined;
}

function escapeAttribute(value: string): string {
	return value.replace(/"/g, '&quot;');
}

function getPreviewScriptContribution(script: unknown): { path: string; type?: 'module' } | undefined {
	if (typeof script === 'string') {
		return { path: script };
	}
	if (!script || typeof script !== 'object') {
		return undefined;
	}
	const contribution = script as Record<string, unknown>;
	if (typeof contribution.path !== 'string') {
		return undefined;
	}
	return {
		path: contribution.path,
		type: contribution.type === 'module' ? 'module' : undefined
	};
}

/** True for `/abs/path` (unix) or `C:\abs` (windows); false for workspace-relative `/foo`. */
function isAbsolutePath(value: string): boolean {
	if (/^[a-zA-Z]:[\\/]/.test(value)) {
		return true;
	}
	return value.startsWith('/');
}

/** True for CSS lengths like `700px`, `45vw`, `100%`, `1.5rem`; false for garbage. */
export function isCssLength(value: string): boolean {
	return /^\d*\.?\d+(?:px|vw|vh|%|rem|em|ch|ex|cm|mm|in|pt|pc|q)$/i.test(value);
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

const svgPin = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 3C13.303 3 13.109 3.038 12.923 3.114L8.481 4.967L5.659 4.026C5.505 3.976 5.339 4.001 5.209 4.095C5.078 4.189 5.001 4.339 5.001 4.5V7H1.257L0.5 7.5L1.257 8H5V10.5C5 10.661 5.077 10.812 5.208 10.905C5.338 11 5.504 11.023 5.658 10.974L8.48 10.033L12.925 11.887C13.109 11.962 13.302 12 13.499 12C14.326 12 14.999 11.327 14.999 10.5V4.5C14.999 3.673 14.326 3 13.499 3H13.5ZM14 10.5C14 10.843 13.615 11.09 13.308 10.962L8.693 9.038C8.631 9.013 8.566 9 8.501 9C8.447 9 8.395 9.009 8.343 9.025L6.001 9.806V5.193L8.343 5.974C8.457 6.011 8.581 6.007 8.694 5.961L13.306 4.038C13.629 3.902 14.001 4.156 14.001 4.499V10.499L14 10.5Z"/></svg>`;
const svgUnpin = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.56016 10.2673L14.1464 14.8536C14.3417 15.0488 14.6583 15.0488 14.8536 14.1464C15.0488 14.6583 15.0488 14.3417 15.0488 14.1464L1.85355 1.14645C1.65829 0.951184 1.34171 0.951184 1.14645 1.14645C0.951184 1.34171 0.951184 1.65829 1.14645 1.85355L5.73223 6.43934L5.6526 6.58876L2.8419 7.52566C2.6775 7.58046 2.5532 7.71648 2.51339 7.88513C2.47357 8.05378 2.52392 8.23102 2.64646 8.35356L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5264 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L9.56016 10.2673ZM8.82138 9.52849L8.76403 9.5592C8.65137 9.61951 8.56608 9.72066 8.52567 9.84189L7.7815 12.0744L3.92562 8.21851L6.15812 7.47435C6.27966 7.43383 6.38101 7.34822 6.44126 7.23516L6.47143 7.17854L8.82138 9.52849ZM12.7178 7.4426L10.6636 8.54227L11.4024 9.28105L13.1897 8.32422C14.0759 7.84981 14.2538 6.65509 13.5443 5.94304L10.0589 2.44509C9.34701 1.73062 8.14697 1.90828 7.67261 2.79838L6.71556 4.59421L7.45476 5.33341L8.55511 3.26869C8.71323 2.97199 9.11324 2.91277 9.35055 3.15093L12.836 6.64888C13.0725 6.88623 13.0131 7.28446 12.7178 7.4426Z"/></svg>`;
const svgRefresh = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M13.65 2.35A6.96 6.96 0 0 0 8 1A7 7 0 1 0 8 15a6.96 6.96 0 0 0 5.14-2.2l-.7-.72A5.96 5.96 0 1 1 8 2a5.96 5.96 0 0 1 4.95 2.6L10.5 7H14V3.5l-1.35 1.35a6.96 6.96 0 0 0-3.99-2.1A6.9 6.9 0 0 1 13.65 2.35z"/></svg>`;
const svgFile = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M10.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L10.5 1zM10 2.2L12.8 5H10V2.2zM12 14H4V2h5v4h3v8z"/></svg>`;
const svgEditor = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M4.5 1.5l-3 4L2.7 6.5l2.4-3.2 2.4 3.2 1.2-1-3-4H4.5zM11.5 1.5l3 4-1.2 1-2.4-3.2-2.4 3.2-1.2-1 3-4h1.2zM1 9h14v1H1V9zm0 3h14v1H1v-1z"/></svg>`;
const svgInvert = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5v11a5.5 5.5 0 0 1 0-11z"/></svg>`;
const svgTables = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h12v12H2V2zm1 1v4h4V3H3zm5 0v4h5V3H8zM3 8v5h4V8H3zm5 0v5h5V8H8z"/></svg>`;
const svgReset = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" transform="rotate(180 8 8)" d="M13.65 2.35A6.96 6.96 0 0 0 8 1A7 7 0 1 0 8 15a6.96 6.96 0 0 0 5.14-2.2l-.7-.72A5.96 5.96 0 1 1 8 2a5.96 5.96 0 0 1 4.95 2.6L10.5 7H14V3.5l-1.35 1.35a6.96 6.96 0 0 0-3.99-2.1A6.9 6.9 0 0 1 13.65 2.35z"/></svg>`;
