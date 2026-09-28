/**
 * REST API helper for integration tests.
 *
 * Uses `vscode-hacker-rest-control` (port 47067 by default) to execute code in
 * the VS Code extension host via plain HTTP. This replaces fragile CDP keyboard
 * gymnastics (Ctrl+P, palette row clicks, Ctrl+S, Ctrl+G…) with deterministic
 * vscode API calls — works identically under code-server and dev host.
 *
 * **Test model:**
 *
 *   REST API → arrange + act  (open files, type, save, settings, commands)
 *   CDP      → assert only    (read webview DOM: #preview, .hmk-frame, …)
 *
 * Core helpers:
 *   `restEval(code)`       — arbitrary JS in the extension host (async OK)
 *   `restCmd(command)`     — `vscode.commands.executeCommand`
 *   `restOpenFile(path)`   — open a file as the active editor
 *   `restSave()`           — save the active document
 *   `restTypeAt(line,col,text)` — insert text at an exact position
 *   `restConfig(section,value?)` — get/set a workspace config
 */
import * as http from 'node:http';

const DEFAULT_PORT = 47067;

const REVIVE_MARKER = '__hmk_rest_revive__';

export interface RestOptions {
	/** Port the REST Control server is listening on (default 47067). */
	port?: number;
	/** Request timeout in ms (default 30 000). */
	timeout?: number;
}

let _globalPort: number = DEFAULT_PORT;

/** Set the default port used by all helpers, overriding the 47067 default. */
export function setRestPort(port: number): void {
	_globalPort = port;
}

/** Returns true if the REST Control endpoint is reachable. */
export async function isRestAvailable(port: number = _globalPort): Promise<boolean> {
	try {
		await restRaw('custom.getCommands', undefined, { port });
		return true;
	} catch {
		return false;
	}
}

function send(port: number, body: unknown, timeout: number): Promise<any> {
	const data = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
			let buf = '';
			res.on('data', (c: Buffer) => (buf += c));
			res.on('end', () => {
				try { resolve(JSON.parse(buf)); }
				catch { reject(new Error(`REST response not JSON: ${buf.slice(0, 200)}`)); }
			});
		});
		req.on('error', reject);
		req.setTimeout(timeout, () => { req.destroy(); reject(new Error(`REST timeout after ${timeout}ms`)); });
		req.write(data);
		req.end();
	});
}

/** Low-level: send a command + args to the REST endpoint. */
export function restRaw(command: string, args: unknown[] = [], opts: RestOptions = {}): Promise<any> {
	const port = opts.port ?? _globalPort;
	const timeout = opts.timeout ?? 30_000;
	return send(port, { command, args }, timeout);
}

/**
 * Execute arbitrary code in the extension host. `vscode` is in scope.
 * Async code is fine — return a Promise and it will be awaited.
 *
 * When reviving `vscode.Uri` / `Position` / `Range` / `Location` objects in
 * the test script, append `.toJSON()` in the eval block or pass a string to
 * avoid serializing circular objects.
 */
export async function restEval<T = unknown>(code: string, opts: RestOptions = {}): Promise<T> {
	const result = await send(opts.port ?? _globalPort, { command: 'custom.eval', args: [code] }, opts.timeout ?? 30_000);
	if (result && typeof result === 'object' && result.name === 'Error' && typeof result.message === 'string') {
		throw new Error(`restEval failed: ${result.message}`);
	}
	return result as T;
}

/** Execute a VS Code command via `vscode.commands.executeCommand`. */
export function restCmd(command: string, ...args: unknown[]): Promise<any> {
	return restRaw(command, args);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/** Open a file as the active editor, optionally at a line/column. */
export async function restOpenFile(path: string, line?: number, col?: number): Promise<void> {
	await restEval(`
		(async () => {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(path)}));
			const opts = ${line !== undefined ? `{ selection: new vscode.Range(${line}, ${col ?? 0}, ${line}, ${col ?? 0}) }` : '{}'};
			await vscode.window.showTextDocument(doc, opts);
		})()
	`);
}

/** Save the active document. */
export async function restSave(): Promise<void> {
	await restEval(`vscode.window.activeTextEditor?.document.save()`);
}

/** Insert text at an exact (0-based line, 0-based char) position. */
export async function restTypeAt(line: number, char: number, text: string): Promise<void> {
	await restEval(`
		(async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			editor.selection = new vscode.Selection(${line}, ${char}, ${line}, ${char});
			await editor.edit(b => b.insert(new vscode.Position(${line}, ${char}), ${JSON.stringify(text)}));
		})()
	`);
}

/** Replace text in a range (all 0-based, inclusive). */
export async function restReplace(line: number, startChar: number, endChar: number, text: string): Promise<void> {
	await restEval(`
		(async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			editor.selection = new vscode.Selection(${line}, ${startChar}, ${line}, ${endChar});
			await editor.edit(b => b.replace(new vscode.Range(${line}, ${startChar}, ${line}, ${endChar}), ${JSON.stringify(text)}));
		})()
	`);
}

/** Move the cursor to a line + column (0-based), making the editor active first. */
export async function restGoto(line: number, col = 0): Promise<void> {
	await restEval(`
		(async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const pos = new vscode.Position(${line}, ${col});
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		})()
	`);
}

/** Close all open editors. */
export async function restCloseAll(): Promise<void> {
	await restCmd('workbench.action.closeAllEditors');
}

/**
 * Restore a clean workbench after a test:
 *
 *   1. discard + close every dirty editor (works for untitled docs too —
 *      force-closing a tab via the tab-groups API still pops the "Do you want
 *      to save?" dialog for a dirty *untitled* doc under code-server);
 *   2. close every remaining non-webview tab (clean/duplicate text editors);
 *      webview panels are kept — that is the preview the next test attaches to;
 *   3. delete the `/tmp/hmk-*` fixtures the tests create.
 *
 * Best-effort and never throws — safe to call from a suite's `finish()`.
 */
export async function restCleanup(opts: RestOptions = {}): Promise<void> {
	try {
		await restEval(`
			(async () => {
				// 1. Dirty editors: revert + close. The command acts on the
				//    active editor, so reveal the doc first.
				for (const doc of [...vscode.workspace.textDocuments]) {
					if (!doc.isDirty) continue;
					try {
						await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
						await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
					} catch {}
				}
				// 2. Close remaining text/diff tabs (now clean — force-close
				//    won't prompt), but keep webview panels (the preview).
				const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
				const closeable = tabs.filter(t => !(t.input instanceof vscode.TabInputWebview));
				if (closeable.length) {
					try { await vscode.window.tabGroups.close(closeable, true); } catch {}
				}
				// 3. Leftover temp fixtures from createTempFile().
				try {
					const dir = vscode.Uri.file('/tmp');
					for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
						if (type === vscode.FileType.File && name.startsWith('hmk-')) {
							try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name)); } catch {}
						}
					}
				} catch {}
			})()
		`, opts);
	} catch {
		// REST unavailable — nothing to clean up.
	}
}

/** Undo the last edit in the active editor. */
export async function restUndo(): Promise<void> {
	await restCmd('undo');
}

export interface ConfigResult<T = unknown> {
	key: string;
	value?: T;
}

/** Get a configuration value, or set it if `value` is provided (Global scope). */
export async function restConfig<T = unknown>(section: string, value?: T): Promise<T | undefined> {
	if (value === undefined) {
		return restEval(`vscode.workspace.getConfiguration().get(${JSON.stringify(section)})`);
	}
	await restEval(`
		vscode.workspace.getConfiguration().update(
			${JSON.stringify(section)},
			${JSON.stringify(value)},
			vscode.ConfigurationTarget.Global
		)
	`);
	// Wait for the config change event to propagate.
	await new Promise(r => setTimeout(r, 500));
	return value;
}

/** Execute `markdown.api.render` on a file and return the HTML fragment. */
export async function restRenderMarkdown(path: string): Promise<string> {
	return restEval(`
		(async () => {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(path)}));
			return vscode.commands.executeCommand('markdown.api.render', doc);
		})()
	`);
}
