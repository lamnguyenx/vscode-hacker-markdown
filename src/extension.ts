import * as vscode from 'vscode';
import { PreviewManager } from './previewManager';
import { PreviewHost } from './previewHost';
import { registerCompletions } from './completions/provider';
import { registerDefinitions } from './completions/definitions';

class MarkdownPreviewViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'hackerMarkdown.preview';

	private _view?: vscode.WebviewView;

	constructor(private readonly manager: PreviewManager) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		this.manager.createHost(webviewView.webview, webviewView.onDidDispose, { showOpenInEditor: true });
	}

	public show(): void {
		this._view?.show(true);
	}

	/** True once the docked view has been resolved at least once (so `show()` can reveal it). */
	public isReady(): boolean {
		return !!this._view;
	}
}

export function activate(context: vscode.ExtensionContext): void {

	const manager = new PreviewManager(context.extensionUri);
	context.subscriptions.push(manager);

	registerCompletions(context);
	registerDefinitions(context);

	const provider = new MarkdownPreviewViewProvider(manager);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(MarkdownPreviewViewProvider.viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		})
	);

	// The editor-area preview survives window reloads and can be moved to
	// another window (drag the tab, or "Move Editor to New Window") — VS Code
	// restores it here via the state the webview saved with `setState`.
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(PreviewManager.panelViewType, manager)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.open', async () => {
			await openPreview(provider, manager);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.openInEditor', () => {
			manager.openInEditor();
		})
	);

	// Bound to Ctrl/Cmd+Shift+V (see the `hackerMarkdown.togglePreview`
	// keybinding). The keybinding shadows the built-in preview's — the
	// `hackerMarkdown.overridePreviewShortcut` setting decides what it runs.
	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.togglePreview', async () => {
			if (vscode.workspace.getConfiguration('hackerMarkdown').get<boolean>('overridePreviewShortcut', true)) {
				await openPreview(provider, manager);
			} else {
				await vscode.commands.executeCommand('markdown.togglePreview');
			}
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

async function openPreview(provider: MarkdownPreviewViewProvider, manager: PreviewManager): Promise<void> {
	// The docked view can only be revealed once it has been resolved (the user
	// opened the panel at least once); until then fall back to an editor panel
	// so the shortcut/command always shows a preview.
	if (provider.isReady()) {
		provider.show();
	} else {
		manager.openInEditor();
	}
	if (!manager.hasMarkdownDocument()) {
		const picked = await pickMarkdownFile();
		if (picked) {
			await vscode.window.showTextDocument(picked);
		}
	}
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
