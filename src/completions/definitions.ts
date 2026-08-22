import * as vscode from 'vscode';
import { fenceAt } from './fences';
import { aliasDefinitions, aliasOccurrences, invocationReferences, procedureFoldRanges } from '../plantuml/invocations';

/** The word under or adjacent to `position`, or undefined. */
function wordAt(line: string, char: number): { word: string; start: number; end: number } | undefined {
	let start = char;
	while (start > 0 && /\w/.test(line[start - 1]!)) {
		start--;
	}
	let end = char;
	while (end < line.length && /\w/.test(line[end]!)) {
		end++;
	}
	if (start >= end) {
		return undefined;
	}
	return { word: line.slice(start, end), start, end };
}

/** Resolves alias from cursor word: direct match, or `_`-prefix fallback. */
function resolveAlias(text: string, fenceStart: number, word: string): string | undefined {
	const defs = aliasDefinitions(text, fenceStart);
	if (defs.has(word)) {
		return word;
	}
	if (word.startsWith('_') && defs.has(word.slice(1))) {
		return word.slice(1);
	}
	return undefined;
}

const definitionProvider: vscode.DefinitionProvider = {
	provideDefinition(document, position): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
		const fence = fenceAt(document.getText(), position.line);
		if (!fence) {
			return undefined;
		}
		const line = document.lineAt(position.line).text;
		const w = wordAt(line, position.character);
		if (!w) {
			return undefined;
		}
		const defs = aliasDefinitions(document.getText(), fence.startLine);
		let defLine = defs.get(w.word);
		if (defLine === undefined && w.word.startsWith('_')) {
			defLine = defs.get(w.word.slice(1));
		}
		if (defLine === undefined) {
			return undefined;
		}
		return new vscode.Location(
			document.uri,
			new vscode.Range(defLine, 0, defLine, document.lineAt(defLine).text.length),
		);
	}
};

const referenceProvider: vscode.ReferenceProvider = {
	provideReferences(document, position, _context): vscode.ProviderResult<vscode.Location[]> {
		const fence = fenceAt(document.getText(), position.line);
		if (!fence) {
			return undefined;
		}
		const line = document.lineAt(position.line).text;
		const w = wordAt(line, position.character);
		if (!w) {
			return undefined;
		}
		const alias = w.word.startsWith('_') ? w.word.slice(1) : w.word;
		const defs = aliasDefinitions(document.getText(), fence.startLine);
		const defLine = defs.get(alias);
		if (defLine === undefined) {
			return undefined;
		}
		const refLines = invocationReferences(document.getText(), fence.startLine, fence.endLine, alias);
		const locations = refLines.map((l) => {
			const textLine = document.lineAt(l).text;
			const col = textLine.indexOf(`SALT(${alias})`);
			return new vscode.Location(
				document.uri,
				new vscode.Range(l, col, l, col + `SALT(${alias})`.length),
			);
		});
		if (defLine >= 0) {
			const textLine = document.lineAt(defLine).text;
			const col = textLine.indexOf(alias);
			if (col >= 0) {
				locations.unshift(new vscode.Location(
					document.uri,
					new vscode.Range(defLine, col, defLine, col + alias.length),
				));
			}
		}
		return locations;
	}
};

const hoverProvider: vscode.HoverProvider = {
	provideHover(document, position): vscode.ProviderResult<vscode.Hover> {
		const fence = fenceAt(document.getText(), position.line);
		if (!fence) {
			return undefined;
		}
		const line = document.lineAt(position.line).text;
		const w = wordAt(line, position.character);
		if (!w) {
			return undefined;
		}
		const alias = resolveAlias(document.getText(), fence.startLine, w.word);
		if (!alias) {
			return undefined;
		}
		const defs = aliasDefinitions(document.getText(), fence.startLine);
		const defLine = defs.get(alias)!;
		const defText = document.lineAt(defLine).text.trim();
		const occurrences = aliasOccurrences(document.getText(), fence.startLine, fence.endLine, alias);
		const refCount = occurrences.filter((o) => o.kind === 'invocation').length;
		const md = new vscode.MarkdownString();
		md.appendCodeblock(defText, 'plantuml');
		md.appendMarkdown(`**${refCount} reference${refCount !== 1 ? 's' : ''}** &middot; line ${defLine + 1}`);
		return new vscode.Hover(md);
	}
};

const renameProvider: vscode.RenameProvider = {
	prepareRename(document, position): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
		const fence = fenceAt(document.getText(), position.line);
		if (!fence) {
			return undefined;
		}
		const line = document.lineAt(position.line).text;
		const w = wordAt(line, position.character);
		if (!w) {
			return undefined;
		}
		const alias = resolveAlias(document.getText(), fence.startLine, w.word);
		if (!alias) {
			return undefined;
		}
		return {
			range: new vscode.Range(position.line, w.start, position.line, w.end),
			placeholder: alias,
		};
	},

	provideRenameEdits(document, position, newName): vscode.ProviderResult<vscode.WorkspaceEdit> {
		if (!/^\w+$/.test(newName)) {
			return undefined;
		}
		const fence = fenceAt(document.getText(), position.line);
		if (!fence) {
			return undefined;
		}
		const line = document.lineAt(position.line).text;
		const w = wordAt(line, position.character);
		if (!w) {
			return undefined;
		}
		const alias = resolveAlias(document.getText(), fence.startLine, w.word);
		if (!alias) {
			return undefined;
		}
		const occurrences = aliasOccurrences(document.getText(), fence.startLine, fence.endLine, alias);
		const edit = new vscode.WorkspaceEdit();
		for (const occ of occurrences) {
			const replacement = occ.kind === 'definition' ? `_${newName}` : newName;
			edit.replace(document.uri, new vscode.Range(occ.line, occ.startCol, occ.line, occ.endCol), replacement);
		}
		return edit;
	}
};

const highlightProvider: vscode.DocumentHighlightProvider = {
	provideDocumentHighlights(document, position): vscode.ProviderResult<vscode.DocumentHighlight[]> {
		const fence = fenceAt(document.getText(), position.line);
		if (!fence) {
			return undefined;
		}
		const line = document.lineAt(position.line).text;
		const w = wordAt(line, position.character);
		if (!w) {
			return undefined;
		}
		const alias = resolveAlias(document.getText(), fence.startLine, w.word);
		if (!alias) {
			return undefined;
		}
		const occurrences = aliasOccurrences(document.getText(), fence.startLine, fence.endLine, alias);
		return occurrences.map((occ) => {
			const kind = occ.kind === 'definition' ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read;
			return new vscode.DocumentHighlight(new vscode.Range(occ.line, occ.startCol, occ.line, occ.endCol), kind);
		});
	}
};

const codeLensProvider: vscode.CodeLensProvider = {
	provideCodeLenses(document): vscode.ProviderResult<vscode.CodeLens[]> {
		const text = document.getText();
		const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
		const lenses: vscode.CodeLens[] = [];
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i]!.trim();
			const procMatch = /^\s*!procedure\s+_([a-zA-Z0-9_]+)\s*\(/.exec(trimmed);
			if (!procMatch) {
				continue;
			}
			const fence = fenceAt(text, i);
			if (!fence) {
				continue;
			}
			const alias = procMatch[1]!;
			const occurrences = aliasOccurrences(text, fence.startLine, fence.endLine, alias);
			const refCount = occurrences.filter((o) => o.kind === 'invocation').length;
			const defLine = aliasDefinitions(text, fence.startLine).get(alias);
			const locations = defLine !== undefined
				? occurrences.map((o) => new vscode.Location(
					document.uri,
					new vscode.Range(o.line, o.startCol, o.line, o.endCol),
				))
				: [];
			lenses.push(new vscode.CodeLens(
				new vscode.Range(i, trimmed.search(/\S/), i, lines[i]!.length),
				{
					title: `${refCount} reference${refCount !== 1 ? 's' : ''}`,
					command: refCount > 0 ? 'editor.action.showReferences' : '',
					arguments: refCount > 0 ? [document.uri, new vscode.Position(i, 0), locations] : undefined,
				},
			));
		}
		return lenses;
	}
};

const foldingProvider: vscode.FoldingRangeProvider = {
	provideFoldingRanges(document): vscode.ProviderResult<vscode.FoldingRange[]> {
		const ranges = procedureFoldRanges(document.getText());
		return ranges.map((r) => new vscode.FoldingRange(r.startLine, r.endLine));
	}
};

export function registerDefinitions(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider({ language: 'markdown' }, definitionProvider),
		vscode.languages.registerReferenceProvider({ language: 'markdown' }, referenceProvider),
		vscode.languages.registerHoverProvider({ language: 'markdown' }, hoverProvider),
		vscode.languages.registerRenameProvider({ language: 'markdown' }, renameProvider),
		vscode.languages.registerDocumentHighlightProvider({ language: 'markdown' }, highlightProvider),
		vscode.languages.registerCodeLensProvider({ language: 'markdown' }, codeLensProvider),
		vscode.languages.registerFoldingRangeProvider({ language: 'markdown' }, foldingProvider),
	);
}