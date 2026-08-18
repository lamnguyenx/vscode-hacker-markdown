import * as vscode from 'vscode';

const CONFIG_SECTION = 'hackerMarkdown.plantuml';

/**
 * The PlantUML server base URL (e.g. `http://localhost:8080`). Defaults to
 * `http://localhost:9274` (declared in package.json — the
 * `plantuml/docker-compose.yml` stack); an explicitly empty value disables
 * diagram rendering (fences become the in-preview "server is not set" notice).
 * Trailing slashes are trimmed, matching `plantuml.server` handling in the
 * reference implementation.
 */
export function getServer(uri?: vscode.Uri): string {
	const value = vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get<string>('server', '');
	return (value ?? '').trim().replace(/\/+$/g, '');
}

/**
 * Extra folders resolved after the Markdown file's own folder when expanding
 * `!include` / `!includesub` directives.
 */
export function getIncludePaths(uri?: vscode.Uri): string[] {
	return vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get<string[]>('includepaths', []) ?? [];
}
