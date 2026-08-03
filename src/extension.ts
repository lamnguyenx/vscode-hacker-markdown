import * as vscode from 'vscode';
import { PreviewManager } from './previewManager';
import { PreviewHost } from './previewHost';

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
}

export function activate(context: vscode.ExtensionContext): void {

	const manager = new PreviewManager(context.extensionUri);
	context.subscriptions.push(manager);

	const provider = new MarkdownPreviewViewProvider(manager);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(MarkdownPreviewViewProvider.viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.open', async () => {
			provider.show();
			if (!manager.hasMarkdownDocument()) {
				const picked = await pickMarkdownFile();
				if (picked) {
					await vscode.window.showTextDocument(picked);
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('hackerMarkdown.openInEditor', () => {
			manager.openInEditor();
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
