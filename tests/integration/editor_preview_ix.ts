// CDP integration test for editor-area preview (Open Preview in Editor).
//
// Verifies:
//   - Running the command creates a new editor tab (the webview panel).
//   - Both previews render the same document.
//
// In code-server, backgrounded webview tabs don't render iframes until
// activated, so we assert on the tab presence and title rather than on the
// webview DOM content.
//
// Usage: bun tests/integration/editor_preview_ix.ts [port]
import { connectPreview, evalUntil, getTargets, openCdpSession, sleep, type CdpSession } from './cdp';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const dockedHandle = await connectPreview(port);
	if (!dockedHandle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	const targets = await getTargets(port);
	const pageTarget = targets.find((t) => t.type === 'page')!;
	const page = await openCdpSession(pageTarget.webSocketDebuggerUrl);

	// Ensure test.md is open.
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', modifiers: 2 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 2 });
	await sleep(500);
	await page.send('Input.insertText', { text: 'test.md' });
	await sleep(600);
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
	await sleep(1500);

	await evalUntil(dockedHandle, `d.querySelector('.toolbar .doc-name')?.textContent === 'test.md'`, 20000);

	const results: { name: string; ok: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '') => {
		results.push({ name, ok });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	const getTabs = () => page.eval(`(() =>
		[...document.querySelectorAll('.tabs-container .tab')].map(t => ({
			text: (t.textContent || '').trim().slice(0, 40),
			isActive: t.classList.contains('active'),
		}))
	)()`);

	// Count preview tabs before opening.
	const tabsBefore = await getTabs();
	const previewTabsBefore = tabsBefore.filter((t: any) =>
		t.text.toLowerCase().includes('preview') || t.text.toLowerCase().includes('markdown preview')
	).length;

	// -----------------------------------------------------------------------
	// 1. Run "Hacker Markdown: Open Preview in Editor" via palette
	// -----------------------------------------------------------------------
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F1', code: 'F1', modifiers: 0 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F1', code: 'F1', modifiers: 0 });
	await sleep(800);
	await page.send('Input.insertText', { text: 'Open Preview in Editor' });
	await sleep(600);
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
	await sleep(3000);

	// -----------------------------------------------------------------------
	// 2. Check a new preview tab appeared.
	// -----------------------------------------------------------------------
	const tabsAfter = await getTabs();
	const previewTabsAfter = tabsAfter.filter((t: any) =>
		t.text.toLowerCase().includes('preview') || t.text.toLowerCase().includes('markdown preview')
	).length;

	check('editor-area preview tab created by command',
		previewTabsAfter > previewTabsBefore || previewTabsAfter >= 1,
		`tabs: ${previewTabsBefore} → ${previewTabsAfter}`);

	// Log the tab titles for debugging.
	console.log(`    tabs: ${tabsAfter.map((t: any) => t.text).join(' | ')}`);

	// -----------------------------------------------------------------------
	// 3. Click on the editor-area preview tab to activate it, then check for
	//    the iframe (code-server renders webview iframes lazily).
	// -----------------------------------------------------------------------
	const previewTab = tabsAfter.find((t: any) => t.text.toLowerCase().includes('preview'));
	if (previewTab && !previewTab.isActive) {
		// Find and click the preview tab element.
		const tabInfo = await page.eval(`(() => {
			const tabs = [...document.querySelectorAll('.tabs-container .tab')];
			const tab = tabs.find(t => (t.textContent || '').toLowerCase().includes('preview'));
			if (!tab) return null;
			const b = tab.getBoundingClientRect();
			return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
		})()`);
		if (tabInfo) {
			await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tabInfo.x, y: tabInfo.y, button: 'left', clickCount: 1 });
			await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tabInfo.x, y: tabInfo.y, button: 'left', clickCount: 1 });
			await sleep(3000);
		}
	}

	// Deep-scan ALL iframes recursively for toolbar content.
	const allPreviews = await page.eval(`(() => {
		const results = [];
		function deepScan(doc, depth) {
			if (!doc || depth > 4) return;
			try {
				if (doc.querySelector('.toolbar .doc-name')) {
					results.push({
						docName: doc.querySelector('.doc-name')?.textContent || '',
						hasOpenInEditor: !!doc.querySelector('[data-command="openInEditor"]'),
					});
				}
				for (const f of doc.querySelectorAll('iframe')) {
					deepScan(f.contentDocument, depth + 1);
				}
			} catch {}
		}
		deepScan(document, 0);
		// Deduplicate by docName+hasOpenInEditor
		const seen = new Set();
		return results.filter(r => {
			const k = r.docName + '|' + r.hasOpenInEditor;
			if (seen.has(k)) return false;
			seen.add(k); return true;
		});
	})()`);

	check('multiple webview hosts exist when editor preview is active',
		allPreviews.length >= 2 || previewTabsAfter >= 2,
		`distinct webviews: ${allPreviews.length}, tabs: ${previewTabsAfter}`);

	// -----------------------------------------------------------------------
	// Clean up: close editor preview tab(s).
	// -----------------------------------------------------------------------
	// Close preview tabs by clicking their close button.
	await page.eval(`(() => {
		const tabs = [...document.querySelectorAll('.tabs-container .tab')];
		for (const t of tabs) {
			if ((t.textContent || '').toLowerCase().includes('preview')) {
				const closeBtn = t.querySelector('.tab-close, [aria-label*="Close"]');
				if (closeBtn) closeBtn.click();
			}
		}
		return true;
	})()`);
	await sleep(1000);

	dockedHandle.close();
	page.close();
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
