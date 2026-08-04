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
		this.docName = uri.path.split('/').pop() || 'Preview';
		this.post({ type: 'setDoc', name: this.docName });
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
				${this.getContributedStyles()}
				${this.getUserStyles()}
			</head>
			<body class="vscode-body">
				<div class="toolbar" role="toolbar">
					<span class="doc-name" title=""></span>
					<span class="spacer"></span>
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
		return out.join(' ');
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

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

const svgRefresh = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M13.65 2.35A6.96 6.96 0 0 0 8 1A7 7 0 1 0 8 15a6.96 6.96 0 0 0 5.14-2.2l-.7-.72A5.96 5.96 0 1 1 8 2a5.96 5.96 0 0 1 4.95 2.6L10.5 7H14V3.5l-1.35 1.35a6.96 6.96 0 0 0-3.99-2.1A6.9 6.9 0 0 1 13.65 2.35z"/></svg>`;
const svgFile = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M10.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L10.5 1zM10 2.2L12.8 5H10V2.2zM12 14H4V2h5v4h3v8z"/></svg>`;
const svgEditor = /* html */ `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M4.5 1.5l-3 4L2.7 6.5l2.4-3.2 2.4 3.2 1.2-1-3-4H4.5zM11.5 1.5l3 4-1.2 1-2.4-3.2-2.4 3.2-1.2-1 3-4h1.2zM1 9h14v1H1V9zm0 3h14v1H1v-1z"/></svg>`;
