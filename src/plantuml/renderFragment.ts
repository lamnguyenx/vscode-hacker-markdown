import * as vscode from 'vscode';
import { rewritePumlFences as rewriteFences } from './fences';
import { getServer, getIncludePaths } from './settings';

/**
 * vscode boundary around the pure `fences.ts` rewrite: reads the
 * `hackerMarkdown.plantuml` settings for the document and delegates.
 */
export function rewritePumlFences(fragment: string, doc: vscode.TextDocument): string {
	return rewriteFences(fragment, {
		server: getServer(doc.uri),
		includePaths: getIncludePaths(doc.uri),
		docUri: doc.uri,
	});
}
