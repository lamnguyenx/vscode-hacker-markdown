import * as vscode from 'vscode';
import { PreviewManager } from './previewManager';
import { registerCompletions } from './completions/provider';
import { registerDefinitions } from './completions/definitions';

class MarkdownPreviewViewProvider implements vscode.WebviewViewProvider {

	private _view?: vscode.WebviewView;
	private pendingReveal = false;

	constructor(private readonly manager: PreviewManager) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		this.manager.createHost(webviewView.webview, webviewView.onDidDispose, { showOpenInEditor: true });
		if (this.pendingReveal) {
			this.pendingReveal = false;
			webviewView.show(true);
		}
	}

	public show(): void {
		if (this._view) {
			this.pendingReveal = false;
			this._view.show(true);
			return;
		}
		// The container command resolves the view asynchronously; reveal it as
		// soon as `resolveWebviewView` runs.
		this.pendingReveal = true;
	}
}

const PLACEMENTS = {
	panel: { view: 'hackerMarkdown.preview', container: 'hacker-markdown' },
	primary: { view: 'hackerMarkdown.previewPrimary', container: 'hacker-markdown-primary' },
	secondary: { view: 'hackerMarkdown.previewSecondary', container: 'hacker-markdown-secondary' }
} as const;

const VIEWS = [PLACEMENTS.panel.view, PLACEMENTS.primary.view, PLACEMENTS.secondary.view] as const;

export function activate(context: vscode.ExtensionContext): void {

	const manager = new PreviewManager(context.extensionUri);
	context.subscriptions.push(manager);

	registerCompletions(context);
	registerDefinitions(context);

	const providers = new Map<string, MarkdownPreviewViewProvider>();
	for (const viewType of VIEWS) {
		const provider = new MarkdownPreviewViewProvider(manager);
		providers.set(viewType, provider);
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(viewType, provider, {
				webviewOptions: {
					retainContextWhenHidden: true
				}
			})
		);
	}

	const panelProvider = providers.get(PLACEMENTS.panel.view)!;

	// The editor-area preview survives window reloads and can be moved to
	// another window (drag the tab, or "Move Editor to New Window") — VS Code
	// restores it here via the state the webview saved with `setState`.
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(PreviewManager.panelViewType, manager)
	);

	// A custom text editor bound to one document. `Hacker Markdown: Toggle
	// Preview` reopens the active Markdown tab with it, so the preview takes
	// over the same tab (and toggling again returns to the source), matching
	// the built-in Markdown preview.
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(PreviewManager.previewEditorViewType, {
			resolveCustomTextEditor: (document, webviewPanel) => {
				manager.resolveCustomTextEditor(document, webviewPanel);
			}
		}, {
			webviewOptions: {
				retainContextWhenHidden: true
			},
			supportsMultipleEditorsPerDocument: false
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.open', async () => {
			await revealDockedPreview(panelProvider, manager, PLACEMENTS.panel);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.openInPrimarySidebar', async () => {
			const provider = providers.get(PLACEMENTS.primary.view)!;
			await revealDockedPreview(provider, manager, PLACEMENTS.primary);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.openInSecondarySidebar', async () => {
			const provider = providers.get(PLACEMENTS.secondary.view)!;
			await revealDockedPreview(provider, manager, PLACEMENTS.secondary);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.openInEditor', async () => {
			await ensureMarkdownDocument(manager);
			manager.openInEditor();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.openInNewWindow', async () => {
			await openInNewWindow(manager);
		})
	);

	// Bound to Ctrl/Cmd+Shift+V and Ctrl/Cmd+K Ctrl/Cmd+V (see the
	// `hackerMarkdown.togglePreview` keybindings). Ctrl/Cmd+Shift+V only
	// shadows the built-in preview while `hackerMarkdown.overridePreviewShortcut`
	// is enabled; the chord always toggles this preview.
	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.togglePreview', async () => {
			await togglePreview(panelProvider, manager);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.reopenAsSource', async () => {
			await vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.refresh', () => {
			manager.refresh();
		})
	);
}

export function deactivate(): void {
	// noop
}

/**
 * Opens the preview in a contributed view container (Panel / Primary Side
 * Bar / Secondary Side Bar). The view's `.open` command both opens the
 * container and reveals the view, and keeps working if the user moved the view
 * to another container.
 */
async function revealDockedPreview(
	provider: MarkdownPreviewViewProvider,
	manager: PreviewManager,
	placement: { readonly view: string; readonly container: string },
): Promise<void> {
	try {
		// `preserveFocus` avoids the view's built-in toggle behavior: this
		// command must always show the preview, never hide a focused one.
		// `provider.show()` below then reveals and focuses it.
		await vscode.commands.executeCommand(`${placement.view}.open`, { preserveFocus: true });
	} catch {
		// Older workbench builds might not expose per-view open commands.
		await vscode.commands.executeCommand(`workbench.view.extension.${placement.container}`);
	}
	provider.show();
	if (!manager.hasMarkdownDocument()) {
		const picked = await pickMarkdownFile();
		if (picked) {
			await vscode.window.showTextDocument(picked);
		}
	}
}

async function ensureMarkdownDocument(manager: PreviewManager): Promise<void> {
	if (manager.hasMarkdownDocument()) {
		return;
	}
	const picked = await pickMarkdownFile();
	if (picked) {
		await vscode.window.showTextDocument(picked);
	}
}

/**
 * Toggles the preview over the active Markdown tab, like the built-in
 * `Markdown: Toggle Preview`: a source editor is reopened with the Hacker
 * Markdown custom editor, and a preview is reopened as its source.
 *
 * When there is no Markdown editor to toggle (e.g. the command was run from
 * the palette while a non-Markdown editor is active), fall back to revealing
 * the docked panel preview.
 */
async function togglePreview(provider: MarkdownPreviewViewProvider, manager: PreviewManager): Promise<void> {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	if (tab?.input instanceof vscode.TabInputCustom && isPreviewEditorViewType(tab.input.viewType)) {
		await vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (editor && isMarkdownFamily(editor.document) && canOpenWithPreviewEditor(editor.document)) {
		try {
			await vscode.commands.executeCommand('reopenActiveEditorWith', PreviewManager.previewEditorViewType);
			return;
		} catch {
			// Fall through to the docked preview if the internal reopen command
			// is unavailable (e.g. an old workbench build).
		}
	}

	await revealDockedPreview(provider, manager, PLACEMENTS.panel);
}

/**
 * Opens the preview in a separate editor tab and moves that tab into a new
 * window. VS Code implements the move; the custom editor is restored there by
 * the normal custom-editor machinery, so the new window gets a live preview.
 */
async function openInNewWindow(manager: PreviewManager): Promise<void> {
	await ensureMarkdownDocument(manager);
	const doc = manager.displayedDocument();
	if (!doc) {
		return;
	}
	try {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (!(tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === PreviewManager.previewEditorViewType)) {
			await vscode.commands.executeCommand('vscode.openWith', doc.uri, PreviewManager.previewEditorViewType, {
				viewColumn: vscode.ViewColumn.Active,
				preview: false
			});
		}
		// The move can outlive the command (and is unsupported on some
		// browser-based builds), so don't hold the command open on it.
		void vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, (e: unknown) => {
			void vscode.window.showWarningMessage(
				`Hacker Markdown: cannot open a preview window (${e instanceof Error ? e.message : String(e)}).`
			);
		});
	} catch (e) {
		void vscode.window.showWarningMessage(
			`Hacker Markdown: cannot open a preview window (${e instanceof Error ? e.message : String(e)}).`
		);
	}
}

/**
 * Custom editors that show a Markdown preview: ours, and the built-in one
 * (so the toggle also returns the built-in preview tab to its source).
 */
function isPreviewEditorViewType(viewType: string): boolean {
	return viewType === PreviewManager.previewEditorViewType || viewType === 'vscode.markdown.preview.editor';
}

/** True for the languages the built-in preview treats as Markdown. */
function isMarkdownFamily(document: vscode.TextDocument): boolean {
	return /^(markdown|prompt|instructions|chatagent|skill)$/.test(document.languageId);
}

/**
 * The custom editor's selector only matches files with a Markdown-looking
 * name. Guarding here avoids a `reopenActiveEditorWith` no-op for untitled or
 * extensionless buffers (the docked preview is used instead).
 */
function canOpenWithPreviewEditor(document: vscode.TextDocument): boolean {
	return /\.(?:md|mkd|mkdn|mdwn|mdown|markdown|markdn|mdtxt|mdtext|litcoffee|ron|ronn|workbook)$/i.test(document.uri.path);
}

async function pickMarkdownFile(): Promise<vscode.Uri | undefined> {
	const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**', 200);
	if (!files.length) {
		vscode.window.showInformationMessage('No Markdown files found in the workspace.');
		return undefined;
	}
	const items = files.map((uri) => ({
		label: vscode.workspace.asRelativePath(uri),
		detail: uri.path.split('/').pop() ?? '',
		uri
	}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Pick a Markdown file to preview'
	});
	return picked?.uri;
}
