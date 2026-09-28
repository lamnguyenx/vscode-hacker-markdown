// Integration test for renderOnSave toggle.
//
// Verifies:
//   - With renderOnSave=true (default): typing does NOT re-render, saving does.
//   - With renderOnSave=false: typing triggers a debounced re-render.
//
// Uses REST API for arrange/act (open file, edit, save) and CDP for assert
// only (read webview DOM). The save check works under code-server because
// we call `document.save()` via REST instead of Ctrl+S (which the browser
// intercepts). The temp file is created in `/tmp/` because the workspace
// mount may be read-only.
//
// Usage: bun tests/integration/render_on_save_ix.ts [cdp-port]
import { connectPreview, evalUntil, sleep } from './cdp';
import { restEval, restSave } from './rest';
import { createSuite } from './test_utils';

/** Create a temp .md file (unique per run to avoid VS Code doc caching). */
async function createTempFile(name: string, content: string): Promise<string> {
	const path = `/tmp/hmk-${name}-${Date.now()}.md`;
	await restEval(`
		(async () => {
			const buf = Buffer.from(${JSON.stringify(JSON.stringify(content))}, 'utf8');
			await vscode.workspace.fs.writeFile(vscode.Uri.file(${JSON.stringify(path)}), buf);
		})()
	`);
	return path;
}

/** Open a file as the active editor. */
async function restOpen(path: string): Promise<void> {
	await restEval(`
		(async () => {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(path)}));
			await vscode.window.showTextDocument(doc);
		})()
	`);
}

/** Replace the full content of a line (0-based). */
async function setLineText(line: number, text: string): Promise<void> {
	await restEval(`
		(async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const len = editor.document.lineAt(${line}).text.length;
			await editor.edit(b => b.replace(new vscode.Range(${line}, 0, ${line}, len), ${JSON.stringify(text)}));
		})()
	`);
}

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	const { check, finish } = createSuite();

	// Create a temp file that can be saved (workspace may be read-only mount).
	const tmpPath = await createTempFile('render-test', '# Test Heading\n\nSome content.\n');
	await restOpen(tmpPath);
	await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent?.startsWith('hmk')`, 20000);

	// -----------------------------------------------------------------------
	// 1. renderOnSave=true (default): type → no re-render → save → re-render
	// -----------------------------------------------------------------------
	const h1Before = await handle.pEval(`d.querySelectorAll('#preview h1').length`);

	// Append " (edited)" to the heading.
	await setLineText(0, '# Test Heading (edited)');
	await sleep(2000); // Wait beyond debounce (300ms) — with renderOnSave=true, no re-render.

	const h1AfterTyping = await handle.pEval(`d.querySelectorAll('#preview h1').length`);
	check('renderOnSave=true: typing does NOT re-render', h1AfterTyping === h1Before,
		`h1: ${h1Before} → ${h1AfterTyping}`);

	// Save via REST — works even under code-server (temp file is writable).
	await restSave();
	const h1Text = await evalUntil(handle, `d.querySelector('#preview h1')?.textContent || ''`, 10000);
	check('renderOnSave=true: save triggers re-render with typed text', h1Text.includes('(edited)'),
		`h1="${h1Text.slice(0, 60)}"`);

	// -----------------------------------------------------------------------
	// 2. renderOnSave=false: typing triggers a debounced re-render
	// -----------------------------------------------------------------------
	await restEval(`vscode.workspace.getConfiguration('hackerMarkdown').update('renderOnSave', false, vscode.ConfigurationTarget.Global)`);
	await sleep(1000);

	await setLineText(0, '# Edited Heading');
	await sleep(2000); // With renderOnSave=false, the 300ms debounce fires.

	const afterType = await handle.pEval(`(() => { const h1 = d.querySelector('#preview h1'); return h1 && h1.textContent.includes('Edited') ? 'edited' : 'no'; })()`);
	check('renderOnSave=false: typing triggers re-render', afterType === 'edited');

	// Cleanup: restore config + delete temp file.
	await restEval(`vscode.workspace.getConfiguration('hackerMarkdown').update('renderOnSave', true, vscode.ConfigurationTarget.Global)`);
	await restEval(`vscode.workspace.fs.delete(vscode.Uri.file(${JSON.stringify(tmpPath)}))`);

	handle.close();
	await finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
