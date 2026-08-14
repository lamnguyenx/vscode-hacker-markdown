import * as vscode from 'vscode';
import { PreviewHost, isCssLength } from './previewHost';
import { rewritePumlFences } from './plantuml/renderFragment';

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
	/** When set, the preview is pinned to this document (editor switches don't change it). */
	private pinnedDoc?: vscode.TextDocument;
	private renderTimer?: NodeJS.Timeout;
	private renderInFlight = false;
	private renderQueued = false;

	private lastEditorSyncAt = 0;
	private lastPreviewScrollAt = 0;

	constructor(extensionUri: vscode.Uri) {
		this.extensionUri = extensionUri;

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (this.pinnedDoc) {
					// Pinned: the preview keeps showing the pinned document no
					// matter which editor (or non-markdown doc) is focused.
					return;
				}
				if (editor?.document) {
					this.setDocument(editor.document);
					// A doc switch does not always fire a selection-change, so
					// push the cursor position here so the highlight shows
					// immediately (the webview re-applies it after rendering).
					if (isMarkdownDocument(editor.document) && this.cursorSyncEnabled()) {
						for (const host of this.hosts) {
							host.cursorLine(editor.selection.active.line);
						}
					}
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
					// Delayed fallback: `onDidCloseTextDocument` fires when the
					// editor disposes the model (can be minutes after the tab
					// closes), so the prompt release happens in the
					// `onDidChangeTabs` handler below. This branch only runs
					// for documents closed without a tab (e.g. by an
					// extension calling `closeTextDocument`).
					if (this.pinnedDoc === document) {
						this.pinnedDoc = undefined;
						this.pushPinState();
					}
					this.setDocument(undefined);
				}
			}),
			vscode.window.tabGroups.onDidChangeTabs((e) => {
				// The pinned document's last tab was closed: release the pin
				// right away (the text document itself stays alive for a
				// while, so `onDidCloseTextDocument` alone would be too slow).
				if (!this.pinnedDoc) {
					return;
				}
				const pinnedUri = this.pinnedDoc.uri.toString();
				for (const tab of e.closed) {
					const resource = tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
					if (!resource || resource.toString() !== pinnedUri) {
						continue;
					}
					const stillOpen = vscode.window.tabGroups.all.some((group) =>
						group.tabs.some((t) => {
							const r = t.input instanceof vscode.TabInputText ? t.input.uri : undefined;
							return !!r && r.toString() === pinnedUri;
						}));
					if (!stillOpen) {
						this.pinnedDoc = undefined;
						this.pushPinState();
						this.setDocument(vscode.window.activeTextEditor?.document);
					}
					break;
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
				if (e.affectsConfiguration('hackerMarkdown.media')) {
					// Media controls changed (toolbar dropdowns/input or
					// settings.json) — broadcast the new state to every host.
					// No rebuild: the webview applies it in place.
					for (const host of this.hosts) {
						host.post({ type: 'mediaState', ...this.mediaState() });
					}
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
		host.post({ type: 'mediaState', ...this.mediaState() });
		this.pushCurrentState(host);
		return host;
	}

	// --- pin ----------------------------------------------------------------

	/**
	 * Pins/unpins the preview to the currently rendered document. While
	 * pinned, editor switches don't change the preview; the pin is released
	 * automatically if the pinned document is closed.
	 */
	private togglePin(): void {
		if (!this.doc) {
			return;
		}
		this.pinnedDoc = this.pinnedDoc ? undefined : this.doc;
		this.pushPinState();
		if (!this.pinnedDoc) {
			// Unpinned: follow the active editor immediately.
			this.setDocument(vscode.window.activeTextEditor?.document);
		}
	}

	private pushPinState(): void {
		for (const host of this.hosts) {
			host.post({ type: 'pinState', pinned: !!this.pinnedDoc });
		}
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
		host.post({ type: 'pinState', pinned: !!this.pinnedDoc });
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
			let fragment = await vscode.commands.executeCommand<string>('markdown.api.render', doc);
			if (!fragment) {
				return;
			}
			// Render `puml`/`plantuml`/`uml` fences to PlantUML-server images
			// for this preview only (the stock preview is untouched — we
			// rewrite our own copy of the fragment, not the shared engine).
			fragment = rewritePumlFences(fragment, doc);
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
			case 'ready':
				// The webview page signals it finished loading (it may have
				// missed the state pushed at host creation). Re-push the
				// current state and re-render so the preview never gets
				// stuck in the empty state. `this.doc` is used rather than
				// the active editor so a pinned preview re-pushes the pinned
				// document, not whatever editor is focused.
				host.post({ type: 'mediaState', ...this.mediaState() });
				host.post({ type: 'pinState', pinned: !!this.pinnedDoc });
				this.setDocument(this.doc);
				break;
			case 'openLink':
				this.openLink(host, String(message.href ?? ''));
				break;
			case 'scrollLine':
				this.onPreviewScroll(host, Number(message.line) || 0);
				break;
			case 'setMedia':
				this.setMedia(String(message.key ?? ''), String(message.value ?? ''));
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
					case 'openPumlSettings':
						void vscode.commands.executeCommand('workbench.action.openSettings', 'hackerMarkdown.plantuml.server');
						break;
					case 'resetColumn':
						this.setMedia('columnWidth', '100%');
						break;
					case 'togglePin':
						this.togglePin();
						break;
				}
				break;
		}
	}

	// --- media controls -------------------------------------------------------

	/** The current `hackerMarkdown.media.*` state (sanitized) broadcast to hosts. */
	private mediaState(): { invert: 'auto' | 'dark' | 'light' | 'off'; columnWidth: string; tables: 'pan' | 'fit' } {
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		const invert = config.get<string>('media.invert', 'auto');
		const tables = config.get<string>('media.tables', 'pan');
		const columnWidth = config.get<string>('media.columnWidth', '100%');
		return {
			invert: invert === 'dark' || invert === 'light' || invert === 'off' ? invert : 'auto',
			tables: tables === 'fit' ? 'fit' : 'pan',
			columnWidth: isCssLength(columnWidth) ? columnWidth : '100%'
		};
	}

	/**
	 * Applies a toolbar-chosen media value by persisting it to the user's
	 * settings (`ConfigurationTarget.Global`); the resulting config-change
	 * event broadcasts the new state to every host.
	 */
	private setMedia(key: string, value: string): void {
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		if (key === 'invert') {
			if (value === 'auto' || value === 'dark' || value === 'light' || value === 'off') {
				void config.update('media.invert', value, vscode.ConfigurationTarget.Global);
			}
		} else if (key === 'tables') {
			if (value === 'pan' || value === 'fit') {
				void config.update('media.tables', value, vscode.ConfigurationTarget.Global);
			}
		} else if (key === 'columnWidth') {
			if (isCssLength(value)) {
				void config.update('media.columnWidth', value, vscode.ConfigurationTarget.Global);
			}
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
		// Cursor highlight is independent of scroll sync: it has no preview ->
		// editor direction, so it needs neither the scroll setting nor the
		// scroll-sync grace timer.
		if (this.cursorSyncEnabled()) {
			for (const host of this.hosts) {
				host.cursorLine(line);
			}
		}
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

	private cursorSyncEnabled(): boolean {
		return vscode.workspace.getConfiguration('hackerMarkdown').get<boolean>('cursorPreviewWithEditor', true);
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
