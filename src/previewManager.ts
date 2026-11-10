import * as vscode from 'vscode';
import { PreviewHost, isCssLength, type PreviewHostOptions } from './previewHost';
import { rewritePumlFences } from './plantuml/renderFragment';
import { inlinePlantumlSvgs } from './plantuml/inlineSvg';
import { saltInvocationLines, type ProcRange } from './plantuml/invocations';
import { rewriteMermaidFences } from './mermaid/renderFragment';

const RENDER_DELAY_MS = 300;
const SCROLL_SYNC_GRACE_MS = 1500;

/**
 * Tracks the active markdown document and drives every attached
 * {@link PreviewHost} (docked views + editor panels). Rendering is done by
 * the built-in `markdown-language-features` extension via
 * `markdown.api.render`, so the preview stays feature-identical to the
 * built-in one (front matter, syntax highlighting, contributed plugins).
 */
export class PreviewManager implements vscode.Disposable, vscode.WebviewPanelSerializer {

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
				this.followActiveEditor();
				// A doc switch does not always fire a selection-change, so
				// push the cursor position here so the highlight shows
				// immediately (the webview re-applies it after rendering).
				if (editor?.document && isMarkdownDocument(editor.document) && this.cursorSyncEnabled()) {
					for (const host of this.hostsForDocument(editor.document)) {
						host.cursorLine(editor.selection.active.line);
					}
				}
			}),
			// The active tab can change without `activeTextEditor` changing
			// (notably when switching to/from a custom editor tab). Keep the
			// preview on the document of the active tab in that case too.
			vscode.window.tabGroups.onDidChangeTabGroups(() => {
				this.followActiveEditor();
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.isDisplayedDocument(e.document) && !this.renderOnSave()) {
					this.scheduleRender();
				}
			}),
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (this.isDisplayedDocument(document) && this.renderOnSave()) {
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
						this.setDocument(this.activeDocument());
					}
					break;
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (this.isDisplayedDocument(e.textEditor.document)) {
					this.onEditorSelection(e.textEditor.document, e.selections[0].active.line);
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
		return !!this.displayedDocument();
	}

	/** The document currently followed by the docked/editor-panel previews. */
	public displayedDocument(): vscode.TextDocument | undefined {
		return this.doc ?? this.activeDocument();
	}

	private renderOnSave(): boolean {
		return vscode.workspace.getConfiguration('hackerMarkdown').get<boolean>('renderOnSave', true);
	}

	public createHost(
		webview: vscode.Webview,
		onDisposed: vscode.Event<void>,
		options: PreviewHostOptions,
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
		if (host.boundDocument) {
			// Custom editor tab: always render the document it was opened for,
			// independent of whichever editor is active. Pinning doesn't apply
			// (the tab is already bound to one document).
			this.bindHostDocument(host, host.boundDocument);
			this.scheduleRender(0);
		} else {
			this.pushCurrentState(host);
		}
		return host;
	}

	/**
	 * Creates the preview for the in-place custom editor tab. The host is
	 * bound to `document`, so switching editors never changes what this tab
	 * shows (matching a normal editor tab).
	 */
	public resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
		this.createHost(panel.webview, panel.onDidDispose, {
			showOpenInEditor: false,
			showPin: false,
			showShowSource: true,
			boundDocument: document
		});
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
			this.setDocument(this.activeDocument());
		}
	}

	private pushPinState(): void {
		for (const host of this.hosts) {
			if (!host.boundDocument) {
				host.post({ type: 'pinState', pinned: !!this.pinnedDoc });
			}
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

	private setDocument(document: vscode.TextDocument | undefined, force = false): void {
		const next = document && isMarkdownDocument(document) ? document : undefined;
		if (!force && this.doc === next) {
			return;
		}
		this.doc = next;
		for (const host of this.hosts) {
			if (host.boundDocument) {
				continue;
			}
			this.bindHostDocument(host, this.doc);
		}
		this.scheduleRender(0);
	}

	/**
	 * Re-binds a following (docked / editor-panel) host to the active
	 * document, or shows its empty state. Bound custom-editor hosts are
	 * skipped by the callers.
	 */
	private bindHostDocument(host: PreviewHost, document: vscode.TextDocument | undefined): void {
		host.docUri = document?.uri;
		if (document) {
			host.setResourceRoots(document.uri.scheme === 'file' ? [vscode.Uri.joinPath(document.uri, '..')] : []);
			host.setDocument(document.uri);
		} else {
			host.empty();
		}
	}

	private pushCurrentState(host: PreviewHost): void {
		this.bindHostDocument(host, this.doc);
		host.post({ type: 'pinState', pinned: !!this.pinnedDoc });
		if (this.doc) {
			this.scheduleRender(0);
		}
	}

	/**
	 * Follows the active editor/tab. A custom editor (the in-place preview or
	 * any Markdown custom editor) has no `activeTextEditor`, so resolve its
	 * document from the active tab instead of blanking the preview.
	 */
	private followActiveEditor(): void {
		if (this.pinnedDoc) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			this.setDocument(editor.document);
			return;
		}
		const doc = this.activeDocument();
		if (doc) {
			this.setDocument(doc);
		}
		// No text editor and no Markdown custom editor: keep the last
		// document (focus may have moved to a panel, terminal or settings).
	}

	private activeDocument(): vscode.TextDocument | undefined {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			return isMarkdownDocument(editor.document) ? editor.document : undefined;
		}
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (!tab?.input || !(tab.input instanceof vscode.TabInputCustom)) {
			return undefined;
		}
		const uri = tab.input.uri.toString();
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri)
			?? [...this.hosts].map((host) => host.boundDocument).find((d) => d?.uri.toString() === uri);
		return doc && isMarkdownDocument(doc) ? doc : undefined;
	}

	/** True when `document` is rendered by the active preview or a bound tab. */
	private isDisplayedDocument(document: vscode.TextDocument): boolean {
		if (this.doc === document) {
			return true;
		}
		for (const host of this.hosts) {
			if (host.boundDocument === document) {
				return true;
			}
		}
		return false;
	}

	private hostsForDocument(document: vscode.TextDocument): PreviewHost[] {
		const hosts: PreviewHost[] = [];
		for (const host of this.hosts) {
			if ((host.boundDocument ?? this.doc) === document) {
				hosts.push(host);
			}
		}
		return hosts;
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
		if (this.renderInFlight) {
			this.renderQueued = true;
			return;
		}
		const docs = new Map<string, vscode.TextDocument>();
		const add = (doc: vscode.TextDocument | undefined) => {
			if (doc) {
				docs.set(doc.uri.toString(), doc);
			}
		};
		add(this.doc);
		for (const host of this.hosts) {
			add(host.boundDocument);
		}
		if (!docs.size) {
			return;
		}
		this.renderInFlight = true;
		try {
			for (const doc of docs.values()) {
				try {
					const fragment = await this.renderDocument(doc);
					if (!fragment) {
						continue;
					}
					// Only broadcast if the host still shows this document (the
					// active editor may have changed while rendering).
					for (const host of this.hosts) {
						if ((host.boundDocument ?? this.doc) === doc) {
							host.render(this.rewriteImageSources(fragment, doc, host));
						}
					}
				} catch (e) {
					// One unreadable/unrenderable document must not prevent the
					// other previews (e.g. the docked view) from rendering.
					console.error(`Hacker Markdown: render failed for ${doc.uri.toString()}`, e);
				}
			}
		} finally {
			this.renderInFlight = false;
			if (this.renderQueued) {
				this.renderQueued = false;
				this.scheduleRender(0);
			}
		}
	}

	/** Renders one document to an HTML fragment (engine + diagram rewrites). */
	private async renderDocument(doc: vscode.TextDocument): Promise<string | undefined> {
		let fragment = await vscode.commands.executeCommand<string>('markdown.api.render', doc);
		if (!fragment) {
			return undefined;
		}
		// Render `puml`/`plantuml`/`uml` fences to PlantUML-server images
		// for this preview only (the stock preview is untouched — we
		// rewrite our own copy of the fragment, not the shared engine).
		fragment = rewritePumlFences(fragment, doc);
		// Replace the diagram `<img>`s with the fetched SVGs so the
		// webview can read the server's `data-source-code` salt ranges
		// (cursor highlight + click-to-source). A failed fetch keeps the
		// `<img>` — the diagram still renders as a plain image.
		fragment = await inlinePlantumlSvgs(fragment);
		// Procedure-rendered salt mockups (`SALT(x)` invocations) get no
		// `data-source-code` from the server, so embed the first-occurrence
		// invocation lines per fence (`data-hmk-salts`); the webview zips
		// them onto the SVG's rangeless mockup groups in order.
		const saltResult = saltInvocationLines(doc.getText());
		fragment = attachSaltInvocationLines(fragment, saltResult);
		// The mermaid plugin drops the engine's `data-line` source map, so
		// attach the fence/container spans from the document instead
		// (cursor highlight + click-to-source for rendered diagrams).
		fragment = rewriteMermaidFences(fragment, doc);
		return fragment;
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
				if (host.boundDocument) {
					this.bindHostDocument(host, host.boundDocument);
					this.scheduleRender(0);
				} else {
					host.post({ type: 'pinState', pinned: !!this.pinnedDoc });
					this.setDocument(this.doc, true);
				}
				break;
			case 'openLink':
				this.openLink(host, String(message.href ?? ''));
				break;
			case 'scrollLine':
				this.onPreviewScroll(host, Number(message.line) || 0);
				break;
			case 'editorLine': {
				const doc = host.boundDocument ?? this.doc;
				if (!doc) {
					break;
				}
				const line = Number(message.line) || 0;
				const from = typeof message.from === 'number' ? message.from : NaN;
				const to = typeof message.to === 'number' ? message.to : NaN;
				if (!isNaN(from) && !isNaN(to)) {
					this.revealEditorRange(doc, from, to);
				} else {
					this.revealEditorLine(doc, line);
				}
				break;
			}
			case 'setMedia':
				this.setMedia(String(message.key ?? ''), String(message.value ?? ''));
				break;
			case 'command':
				switch (message.id) {
					case 'refresh':
						this.refresh();
						break;
					case 'openSource':
						if (host.docUri) {
							void vscode.commands.executeCommand('vscode.open', host.docUri, { preview: true });
						}
						break;
					case 'openInEditor':
						this.openInEditor();
						break;
					case 'reopenAsSource':
						void vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
						break;
					case 'togglePreview':
						void vscode.commands.executeCommand('hackerMarkdown.togglePreview');
						break;
					case 'openInNewWindow':
						void vscode.commands.executeCommand('hackerMarkdown.openInNewWindow');
						break;
					case 'openInPrimarySidebar':
						void vscode.commands.executeCommand('hackerMarkdown.openInPrimarySidebar');
						break;
					case 'openInSecondarySidebar':
						void vscode.commands.executeCommand('hackerMarkdown.openInSecondarySidebar');
						break;
					case 'openPumlSettings':
						void vscode.commands.executeCommand('workbench.action.openSettings', 'hackerMarkdown.plantuml.server');
						break;
					case 'resetColumn':
						this.setMedia('columnWidth', '100%');
						break;
					case 'resetZoom':
						this.setMedia('zoom', '100');
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
	private mediaState(): { invert: 'auto' | 'dark' | 'light' | 'off'; columnWidth: string; tables: 'pan' | 'fit'; zoom: number } {
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		const invert = config.get<string>('media.invert', 'auto');
		const tables = config.get<string>('media.tables', 'pan');
		const columnWidth = config.get<string>('media.columnWidth', '100%');
		const rawZoom = config.get<number>('media.zoom', 100);
		return {
			invert: invert === 'dark' || invert === 'light' || invert === 'off' ? invert : 'auto',
			tables: tables === 'fit' ? 'fit' : 'pan',
			columnWidth: isCssLength(columnWidth) ? columnWidth : '100%',
			zoom: Math.max(50, Math.min(200, typeof rawZoom === 'number' ? rawZoom : 100))
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
		} else if (key === 'zoom') {
			const n = Number(value);
			if (isFinite(n) && n >= 50 && n <= 200) {
				void config.update('media.zoom', Math.round(n), vscode.ConfigurationTarget.Global);
			}
		}
	}

	private openLink(host: PreviewHost, href: string): void {
		if (/^(?:https?|mailto|vscode):/i.test(href)) {
			void vscode.env.openExternal(vscode.Uri.parse(href));
			return;
		}
		const doc = host.boundDocument ?? this.doc;
		if (!doc) {
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
			target = vscode.Uri.joinPath(vscode.Uri.joinPath(doc.uri, '..'), path).with({ fragment });
		} catch {
			return;
		}
		void vscode.workspace.openTextDocument(target).then(
			(document) => void vscode.window.showTextDocument(document),
			() => void vscode.window.showWarningMessage(`Cannot open '${path}'`),
		);
	}

	// --- scroll sync ---------------------------------------------------------

	private onEditorSelection(document: vscode.TextDocument, line: number): void {
		const config = vscode.workspace.getConfiguration('hackerMarkdown');
		const hosts = this.hostsForDocument(document);
		// Cursor highlight is independent of scroll sync: it has no preview ->
		// editor direction, so it needs neither the scroll setting nor the
		// scroll-sync grace timer.
		if (this.cursorSyncEnabled()) {
			for (const host of hosts) {
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
		for (const host of hosts) {
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
		const doc = host.boundDocument ?? this.doc;
		if (!doc) {
			return;
		}
		// `activeTextEditor` is not reliable while a webview has focus (and
		// the source of a toggled-away preview is not visible at all).
		const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === doc);
		if (!editor) {
			return;
		}
		const target = Math.min(line, doc.lineCount - 1);
		const range = new vscode.Range(target, 0, target, 0);
		editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
	}

	// --- click-to-source (preview -> editor) --------------------------------

	/**
	 * A block was clicked in a preview: move the editor cursor to the matching
	 * source line. The selection change fires `onDidChangeTextEditorSelection`,
	 * which re-highlights the same block in the preview (harmless echo) and
	 * would recenter it — the `lastPreviewScrollAt` stamp below makes the
	 * scroll-sync grace timer swallow that echo, so the clicked block stays put.
	 * Focus stays in the preview (`preserveFocus`) so you can keep clicking.
	 */
	private revealEditorLine(doc: vscode.TextDocument, line: number): void {
		if (!vscode.workspace.getConfiguration('hackerMarkdown').get<boolean>('clickToSource', true)) {
			return;
		}
		this.lastPreviewScrollAt = Date.now();
		const target = Math.min(Math.max(0, line), doc.lineCount - 1);
		const range = new vscode.Range(target, 0, target, 0);
		void vscode.window.showTextDocument(doc, { preserveFocus: true, selection: range });
	}

	/**
	 * Click-to-source for a whole source range (0-based, inclusive) — e.g. a
	 * SALT mockup inside a puml diagram, whose exact `data-source-code` span
	 * the server embeds in the SVG. Reveals and selects the full lines so the
	 * exact code that produced the element is visible.
	 */
	private revealEditorRange(doc: vscode.TextDocument, startLine: number, endLine: number): void {
		if (!vscode.workspace.getConfiguration('hackerMarkdown').get<boolean>('clickToSource', true)) {
			return;
		}
		this.lastPreviewScrollAt = Date.now();
		const start = Math.min(Math.max(0, startLine), doc.lineCount - 1);
		const end = Math.min(Math.max(0, endLine), doc.lineCount - 1);
		const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
		void vscode.window.showTextDocument(doc, { preserveFocus: true, selection: range });
	}

	// --- editor area ---------------------------------------------------------

	public static readonly panelViewType = 'hackerMarkdown.panel';

	/**
	 * The custom editor used by `Hacker Markdown: Toggle Preview` to take over
	 * the Markdown tab in place (and give it back when toggled again).
	 */
	public static readonly previewEditorViewType = 'hackerMarkdown.previewEditor';

	private editorPanel?: vscode.WebviewPanel;
	private editorPanelAlive = false;

	public openInEditor(): void {
		if (this.editorPanelAlive && this.editorPanel) {
			this.editorPanel.reveal(vscode.ViewColumn.Beside, true);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			PreviewManager.panelViewType,
			'Markdown Preview',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
			}
		);
		this.editorPanel = panel;
		this.editorPanelAlive = true;
		panel.onDidDispose(() => {
			if (this.editorPanel === panel) {
				this.editorPanelAlive = false;
			}
		});
		this.createEditorHost(panel);
		if (this.doc) {
			panel.title = `Preview ${this.doc.uri.path.split('/').pop() ?? ''}`;
		}
	}

	/**
	 * Restores an editor-area preview that survived a window reload or was
	 * moved to another window (VS Code re-created it here via the
	 * `WebviewPanelSerializer`; the webview saved the document it was showing
	 * with `acquireVsCodeApi().setState`). Re-creates the host, then opens the
	 * serialized document so the preview follows it — the active-editor
	 * tracking broadcasts the state to every host, the new one included.
	 */
	public async deserializeWebviewPanel(webview: vscode.WebviewPanel, state: unknown): Promise<void> {
		this.editorPanel = webview;
		this.editorPanelAlive = true;
		webview.onDidDispose(() => {
			if (this.editorPanel === webview) {
				this.editorPanelAlive = false;
			}
		});
		const host = this.createEditorHost(webview);
		const uri = typeof (state as { uri?: unknown } | undefined)?.uri === 'string'
			? (state as { uri: string }).uri
			: undefined;
		if (uri) {
			try {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
				await vscode.window.showTextDocument(doc, { preview: false });
			} catch {
				// The document is gone — the preview shows the empty state.
			}
		}
	}

	private createEditorHost(panel: vscode.WebviewPanel): PreviewHost {
		const host = this.createHost(panel.webview, panel.onDidDispose, { showOpenInEditor: false });
		this.disposables.push(host);
		panel.onDidDispose(() => {
			this.disposables.splice(this.disposables.indexOf(host), 1);
		});
		return host;
	}
}

/** Languages the built-in Markdown preview treats as Markdown. */
function isMarkdownDocument(document: vscode.TextDocument): boolean {
	return /^(markdown|prompt|instructions|chatagent|skill)$/.test(document.languageId);
}

/**
 * Adds `data-hmk-salts` (comma-separated `line:alias` pairs, 0-based absolute
 * invocation lines) and `data-hmk-procs` (semicolon-separated `from:to:alias`
 * triples, 0-based absolute procedure body ranges) to each inlined PlantUML
 * `<svg>` root, keyed by the fence's `data-hmk-from`. Fences with no SALT
 * invocations get neither attribute.
 */
function attachSaltInvocationLines(fragment: string, result: { invocations: Map<number, { line: number; alias: string }[]>; procRanges: Map<number, ProcRange[]> }): string {
	if (!result.invocations.size) {
		return fragment;
	}
	return fragment.replace(/<svg\b([^>]*\bdata-hmk-from="(\d+)"[^>]*)>/gi, (full, attrs: string, from: string) => {
		const entries = result.invocations.get(Number(from));
		if (!entries || !entries.length) {
			return full;
		}
		const salts = entries.map((e) => `${e.line}:${e.alias}`).join(',');
		let resultAttr = ` data-hmk-salts="${salts}"`;
		const procs = result.procRanges.get(Number(from));
		if (procs && procs.length) {
			resultAttr += ` data-hmk-procs="${procs.map((p) => `${p.from}:${p.to}:${p.alias}`).join(';')}"`;
		}
		return `<svg ${attrs.trim()}${resultAttr}>`;
	});
}
