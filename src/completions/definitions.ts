import * as vscode from 'vscode';
import { fenceAt } from './fences';
import { aliasDefinitions, invocationReferences } from '../plantuml/invocations';

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
		// Direct alias lookup (cursor on `enroll_uploading_1` in SALT(...)).
		let defLine = defs.get(w.word);
		// When cursor starts with `_` (cursor on `_enroll_uploading_1` inside
		// a procedure definition), strip the underscore and try again. VS Code
		// then sees "1 result at cursor position" and automatically fires the
		// alternative command (default: `editor.action.goToReferences`), so
		// Alt+Click on a procedure name shows all its `SALT(x)` call sites.
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
		// If the cursor word starts with `_`, it is likely a procedure definition
		// name (`_enroll_uploading_1`). Strip it to get the invocation alias.
		const alias = w.word.startsWith('_') ? w.word.slice(1) : w.word;
		// Verify the alias actually exists as a procedure definition.
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
		// Include the definition itself as a reference so "show references" shows
		// the full picture (definition + all invocations).
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

export function registerDefinitions(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider({ language: 'markdown' }, definitionProvider)
	);
	context.subscriptions.push(
		vscode.languages.registerReferenceProvider({ language: 'markdown' }, referenceProvider)
	);
}