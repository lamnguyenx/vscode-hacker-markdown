import * as vscode from 'vscode';
import { fenceAt } from './fences';
import { procedureNames } from '../plantuml/invocations';
import { PLANTUML_LANGUAGE_WORDS, type PlantumlCompletionKind } from './words';

/**
 * PlantUML code completion inside `plantuml`/`puml`/`uml` markdown fences.
 *
 * VS Code has no grammar-scoped completion (microsoft/vscode#208862), so this
 * provider is registered on the whole `markdown` language and returns
 * `undefined` (contributes nothing, widget stays closed) unless the cursor is
 * inside a puml fence. The catalog is the static list ported from
 * `jebbs/plantuml` (`words.ts`); no jar, no external dependency. Procedure
 * aliases defined with `!procedure _<name>()` in the current fence are added
 * dynamically, so `SALT(name` and bare `name` both suggest the alias.
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

/** Builds dynamic completion items for every `!procedure` / `!unquoted procedure` in the fence. */
function buildAliasItems(text: string, fenceStart: number, range: vscode.Range): vscode.CompletionItem[] {
	const items: vscode.CompletionItem[] = [];
	const names = procedureNames(text, fenceStart);
	const seen = new Set<string>();
	// Build line-number map: we know the docs are small enough for a second pass.
	const defLines = new Map<string, number>();
	const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
	for (let i = fenceStart + 1; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		if (/^(`{3,}|~{3,})\s*$/.test(trimmed)) {
			break;
		}
		const match = /^\s*!(?:unquoted\s+)?procedure\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i.exec(trimmed);
		if (match) {
			defLines.set(match[1]!, i);
		}
	}
	for (const name of names) {
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		const line = defLines.get(name) ?? 0;
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
		item.insertText = name;
		item.range = range;
		const prefix = name.startsWith('_') ? '' : 'unquoted ';
		item.detail = `!${prefix}procedure ${name}() (line ${line + 1})`;
		items.push(item);
		// For `_`-prefixed names also suggest the bare alias.
		if (name.startsWith('_') && !seen.has(name.slice(1))) {
			const bare = new vscode.CompletionItem(name.slice(1), vscode.CompletionItemKind.Function);
			bare.insertText = name.slice(1);
			bare.range = range;
			bare.detail = `!procedure ${name}() (line ${line + 1})`;
			items.push(bare);
		}
	}
	return items;
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
		const staticItems = buildItems().map((cached) => {
			const item = new vscode.CompletionItem(cached.label, cached.kind);
			item.insertText = cached.insertText;
			item.range = range;
			return item;
		});
		const aliasItems = buildAliasItems(document.getText(), fence.startLine, range);
		return [...staticItems, ...aliasItems];
	}
};

export function registerCompletions(context: vscode.ExtensionContext): void {
	// '@' and '!' are the two directive families: `@start…`/`@end…` and
	// `!include`/`!define`/….
	// '(' triggers when the user types the opening paren of a SALT(…) call
	// or a procedure call — the provider returns all procedure names + aliases.
	// For bare-letter typing (e.g. `SA` → `SALT`, `sam` → `sample_done`)
	// use Ctrl+Space or the editor's quickSuggestions (the procedure names are
	// in the document text, so built-in word completion picks them up).
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			{ language: 'markdown' },
			provider,
			'@',
			'!',
			'('
		)
	);
}
