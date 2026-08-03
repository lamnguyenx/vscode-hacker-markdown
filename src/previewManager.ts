import * as vscode from 'vscode';
import { PreviewHost } from './previewHost';

const RENDER_DELAY_MS = 300;
const SCROLL_SYNC_GRACE_MS = 1500;

/**
 * Tracks the active markdown document and drives every attached
 * {@link PreviewHost} (docked views + editor panels). Rendering is done by
 * the built-in `markdown-language-features` extension via
 * `markdown.api.render`, so the preview stays feature-identical to the
 * built-in one (front matter, syntax highlighting, contributed plugins).
 */
export class PreviewManager implements vscode.Disposable {

	private readonly extensionUri: vscode.Uri;
	private readonly hosts = new Set<PreviewHost>();
	private readonly disposables: vscode.Disposable[] = [];

	private doc?: vscode.TextDocument;
	private renderTimer?: NodeJS.Timeout;
	private renderInFlight = false;
	private renderQueued = false;

	private lastEditorSyncAt = 0;
	private lastPreviewScrollAt = 0;

	constructor(extensionUri: vscode.Uri) {
		this.extensionUri = extensionUri;

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor?.document) {
					this.setDocument(editor.document);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.doc && e.document === this.doc && !this.renderOnSave()) {
					this.scheduleRender();
				}
			}),
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (this.doc === document && this.renderOnSave()) {
					this.scheduleRender();
				}
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (this.doc === document) {
					this.setDocument(undefined);
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.textEditor.document === this.doc) {
					this.onEditorSelection(e.selections[0].active.line);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('hackerMarkdown.renderOnSave')) {
					// Picking up unsaved changes (or switching back to live
					// rendering) should be reflected immediately.
					this.scheduleRender(0);
				}
				if (e.affectsConfiguration('hackerMarkdown.styles') || e.affectsConfiguration('markdown.styles')) {
					for (const host of this.hosts) {
						host.rebuild();
					}
				}
			})
		);

		this.setDocument(vscode.window.activeTextEditor?.document);
	}

	public hasMarkdownDocument(): boolean {
		return !!this.doc;
	}

	private renderOnSave(): boolean {
		return vscode.workspace.getConfiguration('hackerMarkdown').get<boolean>('renderOnSave', true);
	}

	public createHost(
		webview: vscode.Webview,
		onDisposed: vscode.Event<void>,
		options: { readonly showOpenInEditor: boolean },
	): PreviewHost {
		const host = new PreviewHost(webview, onDisposed, this.extensionUri, options, (message) => {
			this.onHostMessage(host, message);
		});
		this.hosts.add(host);
		onDisposed(() => {
			this.hosts.delete(host);
			host.dispose();
		});
		this.pushCurrentState(host);
		return host;
	}

	public refresh(): void {
		if (this.hasUserStyles()) {
			// Rebuild the webviews so stylesheet links are regenerated (and
			// cache-busted by mtime), then re-render the markdown.
			for (const host of this.hosts) {
				host.rebuild();
			}
		}
		this.scheduleRender(0);
	}

	private hasUserStyles(): boolean {
		const styles = vscode.workspace.getConfiguration('hackerMarkdown').get<string[]>('styles') ?? [];
		if (styles.length > 0) {
			return true;
		}
		return (vscode.workspace.getConfiguration('markdown').get<string[]>('styles') ?? []).length > 0;
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
	}

	// --- document tracking --------------------------------------------------

	private setDocument(document: vscode.TextDocument | undefined): void {
		this.doc = document && isMarkdownDocument(document) ? document : undefined;
		for (const host of this.hosts) {
			host.docUri = this.doc?.uri;
			if (this.doc) {
				host.setResourceRoots(this.doc.uri.scheme === 'file' ? [vscode.Uri.joinPath(this.doc.uri, '..')] : []);
				host.setDocument(this.doc.uri);
			} else {
				host.empty();
			}
		}
		this.scheduleRender(0);
	}

	private pushCurrentState(host: PreviewHost): void {
		host.docUri = this.doc?.uri;
		if (this.doc) {
			host.setResourceRoots(this.doc.uri.scheme === 'file' ? [vscode.Uri.joinPath(this.doc.uri, '..')] : []);
			host.setDocument(this.doc.uri);
			this.scheduleRender(0);
		} else {
			host.empty();
		}
	}

	// --- rendering ----------------------------------------------------------

	private scheduleRender(delay = RENDER_DELAY_MS): void {
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
		}
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			void this.render();
		}, delay);
	}

	private async render(): Promise<void> {
		const doc = this.doc;
		if (!doc) {
			return;
		}
		if (this.renderInFlight) {
			this.renderQueued = true;
			return;
		}
		this.renderInFlight = true;
		try {
			const fragment = await vscode.commands.executeCommand<string>('markdown.api.render', doc);
			if (!fragment) {
				return;
			}
			// Only broadcast if the document didn't change while rendering.
			if (this.doc === doc) {
				for (const host of this.hosts) {
					host.render(this.rewriteImageSources(fragment, doc, host));
				}
			}
		} catch (e) {
			console.error('Hacker Markdown: render failed', e);
		} finally {
			this.renderInFlight = false;
			if (this.renderQueued) {
				this.renderQueued = false;
				this.scheduleRender(0);
			}
		}
	}

	/**
	 * `markdown.api.render` cannot rewrite relative image paths (that is done
	 * per-webview by the built-in preview's resource provider), so resolve
	 * them here relative to the markdown file, like `#fixHref` in
	 * `documentRenderer.ts`.
	 */
	private rewriteImageSources(fragment: string, doc: vscode.TextDocument, host: PreviewHost): string {
		if (doc.uri.scheme !== 'file') {
			return fragment;
		}
		const dir = vscode.Uri.joinPath(doc.uri, '..');
		return fragment.replace(/\ssrc="([^"]+)"/g, (full, src: string) => {
			if (/^(?:https?:|file:|data:|blob:|mailto:|#|vscode-)/i.test(src)) {
				return full;
			}
			try {
				const resolved = vscode.Uri.joinPath(dir, src);
				return full.replace(src, host.webview.asWebviewUri(resolved).toString());
			} catch {
				return full;
			}
		});
	}

	// --- messages from the webview ------------------------------------------

	private onHostMessage(host: PreviewHost, message: { type: string; [key: string]: unknown }): void {
		switch (message.type) {
			case 'openLink':
				this.openLink(host, String(message.href ?? ''));
				break;
			case 'scrollLine':
				this.onPreviewScroll(host, Number(message.line) || 0);
				break;
			case 'command':
				switch (message.id) {
					case 'refresh':
						this.refresh();
						break;
					case 'openSource':
						if (this.doc) {
							void vscode.commands.executeCommand('vscode.open', this.doc.uri, { preview: true });
						}
						break;
					case 'openInEditor':
						this.openInEditor();
						break;
				}
				break;
		}
	}

	private openLink(host: PreviewHost, href: string): void {
		if (/^(?:https?|mailto|vscode):/i.test(href)) {
			void vscode.env.openExternal(vscode.Uri.parse(href));
			return;
		}
		if (!this.doc) {
			return;
		}
		const fragmentIndex = href.indexOf('#');
		const fragment = fragmentIndex >= 0 ? href.slice(fragmentIndex) : '';
		const path = fragmentIndex >= 0 ? href.slice(0, fragmentIndex) : href;
		if (!path) {
			// pure fragment links are handled in the webview
			return;
		}
		let target: vscode.Uri;
		if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
			void vscode.env.openExternal(vscode.Uri.parse(path + fragment));
			return;
		}
		try {
			target = vscode.Uri.joinPath(vscode.Uri.joinPath(this.doc.uri, '..'), path).with({ fragment });
		} catch {
			return;
		}
		void vscode.workspace.openTextDocument(target).then(
			(document) => void vscode.window.showTextDocument(document),
			() => void vscode.window.showWarningMessage(`Cannot open '${path}'`),
		);
	}

	// --- scroll sync ---------------------------------------------------------

	private onEditorSelection(line: number): void {
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		if (!config.get<boolean>('scrollPreviewWithEditor', true)) {
			return;
		}
		if (Date.now() - this.lastPreviewScrollAt < SCROLL_SYNC_GRACE_MS) {
			return;
		}
		this.lastEditorSyncAt = Date.now();
		for (const host of this.hosts) {
			host.scrollToLine(line);
		}
	}

	private onPreviewScroll(host: PreviewHost, line: number): void {
		this.lastPreviewScrollAt = Date.now();
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		if (!config.get<boolean>('scrollEditorWithPreview', true)) {
			return;
		}
		if (Date.now() - this.lastEditorSyncAt < SCROLL_SYNC_GRACE_MS) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document !== this.doc) {
			return;
		}
		const target = Math.min(line, editor.document.lineCount - 1);
		const range = new vscode.Range(target, 0, target, 0);
		editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
	}

	// --- editor area ---------------------------------------------------------

	public openInEditor(): void {
		const panel = vscode.window.createWebviewPanel(
			'hackerMarkdown.panel',
			'Markdown Preview',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
			}
		);
		const host = this.createHost(panel.webview, panel.onDidDispose, { showOpenInEditor: false });
		this.disposables.push(host);
		panel.onDidDispose(() => {
			this.disposables.splice(this.disposables.indexOf(host), 1);
		});
		if (this.doc) {
			panel.title = `Preview ${this.doc.uri.path.split('/').pop() ?? ''}`;
		}
	}
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
	return document.languageId === 'markdown';
}
