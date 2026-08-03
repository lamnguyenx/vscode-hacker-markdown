import * as vscode from 'vscode';

export interface PreviewHostOptions {
	/** Show the "Open in Editor" button in the toolbar (docked view only). */
	readonly showOpenInEditor: boolean;
}

export interface PreviewHostMessage {
	type: string;
	[key: string]: unknown;
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
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
		};

		webview.html = this.buildHtml();
		this.disposables.push(webview.onDidReceiveMessage((message) => this.onMessage(message as PreviewHostMessage)));
	}

	public setResourceRoots(extraRoots: readonly vscode.Uri[]): void {
		this.webview.options = {
			...this.webview.options,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), ...extraRoots]
		};
	}

	public setDocument(uri: vscode.Uri): void {
		this.docName = uri.path.split('/').pop() || 'Preview';
		this.post({ type: 'setDoc', name: this.docName });
	}

	public render(fragment: string): void {
		this.post({ type: 'render', html: fragment });
	}

	public empty(): void {
		this.post({ type: 'empty' });
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

	private asMediaWebviewUri(relativePath: string): vscode.Uri {
		return this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', relativePath));
	}

	private buildHtml(): string {
		const nonce = getNonce();
		const cspSource = this.webview.cspSource;

		const mainCss = this.asMediaWebviewUri('main.css');
		const markdownCss = this.asMediaWebviewUri('markdown.css');
		const highlightCss = this.asMediaWebviewUri('highlight.css');
		const mainJs = this.asMediaWebviewUri('index.js');

		return /* html */ `<!DOCTYPE html>
			<html style="${escapeAttribute(this.getSettingsOverrideStyles())}">
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="
					default-src 'none';
					img-src ${cspSource} https: data: http://localhost:* http://127.0.0.1:*;
					media-src ${cspSource} https: data: http://localhost:* http://127.0.0.1:*;
					script-src 'nonce-${nonce}';
					style-src ${cspSource} 'unsafe-inline';
					font-src ${cspSource} https: data:;
					">

				<link rel="stylesheet" type="text/css" href="${markdownCss}">
				<link rel="stylesheet" type="text/css" href="${highlightCss}">
				<link rel="stylesheet" type="text/css" href="${mainCss}">
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

	/** User styles from the built-in `markdown.styles` setting. */
	private getUserStyles(): string {
		const styles = vscode.workspace.getConfiguration('markdown').get<string[]>('styles') ?? [];
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

	private resolveStyleHref(style: string): string {
		if (/^(https?:|file:)/i.test(style)) {
			return this.webview.asWebviewUri(vscode.Uri.parse(style)).toString();
		}
		if (style.startsWith('/')) {
			const folder = this.docUri ? vscode.workspace.getWorkspaceFolder(this.docUri) : undefined;
			const root = folder ?? vscode.workspace.workspaceFolders?.[0];
			if (root) {
				return this.webview.asWebviewUri(vscode.Uri.joinPath(root.uri, style)).toString();
			}
			return style;
		}
		if (this.docUri && this.docUri.scheme === 'file') {
			return this.webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.joinPath(this.docUri, '..'), style)).toString();
		}
		const root = vscode.workspace.workspaceFolders?.[0];
		if (root) {
			return this.webview.asWebviewUri(vscode.Uri.joinPath(root.uri, style)).toString();
		}
		return style;
	}

	/** The markdown document currently rendered by this host. */
	public docUri: vscode.Uri | undefined;
}

function escapeAttribute(value: string): string {
	return value.replace(/"/g, '&quot;');
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
