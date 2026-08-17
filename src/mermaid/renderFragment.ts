import * as vscode from 'vscode';
import { mermaidSpans, rewriteMermaidSpans } from './fences';

/**
 * vscode boundary around the pure `fences.ts` span rewrite: scans the markdown
 * document for mermaid fences/containers and attaches their source spans to the
 * rendered fragment's mermaid blocks (see `fences.ts` for why the fragment
 * alone cannot carry them).
 */
export function rewriteMermaidFences(fragment: string, doc: vscode.TextDocument): string {
	return rewriteMermaidSpans(fragment, mermaidSpans(doc.getText()));
}