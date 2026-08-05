import * as vscode from 'vscode';
import { fenceAt } from './fences';
import { PLANTUML_LANGUAGE_WORDS, type PlantumlCompletionKind } from './words';

/**
 * PlantUML code completion inside `plantuml`/`puml`/`uml` markdown fences.
 *
 * VS Code has no grammar-scoped completion (microsoft/vscode#208862), so this
 * provider is registered on the whole `markdown` language and returns
 * `undefined` (contributes nothing, widget stays closed) unless the cursor is
 * inside a puml fence. The catalog is the static list ported from
 * `jebbs/plantuml` (`words.ts`); no jar, no external dependency.
 */

const KIND_BY_NAME: Record<PlantumlCompletionKind, vscode.CompletionItemKind> = {
	struct: vscode.CompletionItemKind.Struct,
	keyword: vscode.CompletionItemKind.Keyword,
	function: vscode.CompletionItemKind.Function,
	field: vscode.CompletionItemKind.Field,
	color: vscode.CompletionItemKind.Color
};

/**
 * Characters that may appear in the token being completed, so a partial like
 * `@startum` or `part` is replaced wholesale (markdown's own word pattern
 * would stop at `@`/`!`).
 */
const WORD_CHAR_REG = /[@!$:a-zA-Z0-9_.-]/;

let cachedItems: vscode.CompletionItem[] | undefined;

/** Builds the completion items once (the catalog is static). */
function buildItems(): vscode.CompletionItem[] {
	if (cachedItems) {
		return cachedItems;
	}
	const items: vscode.CompletionItem[] = [];
	for (const group of PLANTUML_LANGUAGE_WORDS) {
		const kind = KIND_BY_NAME[group.kind];
		for (const word of group.words) {
			const item = new vscode.CompletionItem(word, kind);
			item.insertText = word;
			items.push(item);
		}
	}
	cachedItems = items;
	return items;
}

function completionsEnabled(): boolean {
	return vscode.workspace.getConfiguration('hackerMarkdown').get<boolean>('completions.enabled', true);
}

/** The document range spanning the partial word before the cursor. */
function wordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
	const line = document.lineAt(position.line).text;
	let start = position.character;
	while (start > 0 && WORD_CHAR_REG.test(line[start - 1]!)) {
		start--;
	}
	return new vscode.Range(position.line, start, position.line, position.character);
}

const provider: vscode.CompletionItemProvider = {
	provideCompletionItems(document, position): vscode.CompletionItem[] | undefined {
		if (!completionsEnabled()) {
			return undefined;
		}
		const fence = fenceAt(document.getText(), position.line);
		if (!fence) {
			return undefined;
		}
		const range = wordRange(document, position);
		// Each request gets fresh item objects (VS Code mutates `range`), so
		// build from the cached labels rather than sharing cached items.
		return buildItems().map((cached) => {
			const item = new vscode.CompletionItem(cached.label, cached.kind);
			item.insertText = cached.insertText;
			item.range = range;
			return item;
		});
	}
};

export function registerCompletions(context: vscode.ExtensionContext): void {
	// '@' and '!' are the two directive families: `@start…`/`@end…` and
	// `!include`/`!define`/…. Plain letters rely on the editor's default
	// quickSuggestions (and Ctrl+Space always works).
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			{ language: 'markdown' },
			provider,
			'@',
			'!'
		)
	);
}
