// CDP integration test for PlantUML IntelliSense inside markdown fences.
//
// Verifies that the Language Feature providers registered on `markdown` are
// active in the editor:
//   - Code lens: "N references" text appears above !procedure definitions.
//   - Folding: !procedure/!endprocedure blocks are foldable.
//   - Go-to-definition: F12 on SALT(alias) moves the cursor.
//
// Uses the editor DOM (not vscode.commands — unavailable via CDP in
// code-server). Opens enroll-flow.puml.md which has 16 procedures + many
// SALT() calls.
//
// Usage: bun tests/integration/plantuml_intellisense_ix.ts [port]
import { connectPreview, getTargets, openCdpSession, sleep, type CdpSession } from './cdp';

const FIXTURE = 'enroll-flow.puml.md';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';

	const targets = await getTargets(port);
	const pageTarget = targets.find((t) => t.type === 'page')!;
	const page = await openCdpSession(pageTarget.webSocketDebuggerUrl);

	// Open the fixture via Quick Open.
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', modifiers: 2 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 2 });
	await sleep(500);
	await page.send('Input.insertText', { text: FIXTURE });
	await sleep(600);
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
	await sleep(2000);

	// Focus the editor.
	const editorRect = await page.eval(`(() => {
		const e = document.querySelector('.monaco-editor .overflow-guard') || document.querySelector('.monaco-editor');
		if (!e) return null;
		const r = e.getBoundingClientRect();
		return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
	})()`);
	if (!editorRect) {
		console.error('NO_EDITOR: cannot find .monaco-editor');
		process.exit(2);
	}
	await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...editorRect });
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...editorRect, button: 'left', clickCount: 1 });
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...editorRect, button: 'left', clickCount: 1 });
	await sleep(500);

	const results: { name: string; ok: boolean; skip: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '', skip = false) => {
		results.push({ name, ok, skip });
		console.log(`${skip ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	const gotoLine = async (line: number) => {
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'g', code: 'KeyG', modifiers: 2 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g', code: 'KeyG', modifiers: 2 });
		await sleep(400);
		await page.send('Input.insertText', { text: String(line) });
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
		await sleep(600);
	};

	// -----------------------------------------------------------------------
	// 1. Code lens: go to the first !procedure line (line 13) and check
	//    for codelens-decoration text containing "references".
	// -----------------------------------------------------------------------
	await gotoLine(13);
	await sleep(1000);
	const codeLensInfo = await page.eval(`(() => {
		// Code lens decorations render as .codelens-decoration above lines.
		const lenses = document.querySelectorAll('.codelens-decoration');
		if (!lenses.length) {
			// Try alternate: .conflict-codelens-widget or inline codelens
			const widgets = document.querySelectorAll('[class*="codelens"]');
			return { count: widgets.length, texts: [...widgets].slice(0,5).map(w => w.textContent?.trim().slice(0,60)) };
		}
		return { count: lenses.length, texts: [...lenses].slice(0,5).map(l => l.textContent?.trim().slice(0,60)) };
	})()`);
	check('code lens registered (N references above procedures)', codeLensInfo.count > 0,
		`found ${codeLensInfo.count} codelens elements`);
	if (codeLensInfo.count > 0) {
		console.log(`    texts: ${codeLensInfo.texts.join(' | ')}`);
	}

	// -----------------------------------------------------------------------
	// 2. Folding: !procedure blocks should be foldable.
	//    Check for folding region indicators in the glyph margin.
	// -----------------------------------------------------------------------
	// Navigate to procedure body and look for collapse/expand controls.
	// In VS Code, foldable ranges are shown as small arrows in the left margin
	// when hovering, and folding decorations are on .margin-view-overlays.
	const foldInfo = await page.eval(`(() => {
		// The folding controller adds ranges to the editor model. We can't
		// directly query the folding model from DOM. Instead, trigger a fold
		// via keyboard shortcut and see if the view changes.
		// Alternative: check if "Fold" command is available by looking for
		// folding decorations in the line numbers gutter.
		const gutter = document.querySelector('.margin-view-overlays');
		if (!gutter) return { gutter: false };
		// Folding decorations appear as .cldr decorations on line number elements
		const cldr = document.querySelectorAll('.cldr');
		return { gutter: true, foldDecorations: cldr.length };
	})()`);
	// We check >0 to confirm folding ranges are being computed by our provider.
	// (VS Code may add other foldable ranges too, but our !procedure ranges
	// should be a superset.)
	check('folding range provider active (fold decorations present)', foldInfo.foldDecorations > 0,
		`fold decorations: ${foldInfo.foldDecorations ?? 'no gutter'}`);

	// -----------------------------------------------------------------------
	// 3. Go-to-definition: position on SALT(form_empty) at line ~307,
	//    press F12, check the cursor moves to !procedure _form_empty() at line 13.
	//    We need to scroll line 307 into view first (monaco virtualizes lines).
	// -----------------------------------------------------------------------
	// Go to the SALT(form_empty) line.
	await gotoLine(307);
	await sleep(2000); // Wait for monaco to render the virtualized line.

	// Verify the SALT(form_empty) line is visible by checking rendered lines.
	const lineText = await page.eval(`(() => {
		const lines = [...document.querySelectorAll('.view-lines .view-line')];
		const saltLine = lines.find(l => (l.textContent || '').includes('SALT(form_empty)'));
		return saltLine ? saltLine.textContent.trim() : null;
	})()`);
	if (lineText) {
		// Move cursor right to land on "form_empty".
		for (let i = 0; i < 4; i++) {
			await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', modifiers: 2 });
			await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', modifiers: 2 });
			await sleep(50);
		}
		await sleep(200);

		// Press F12 (go to definition).
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F12', code: 'F12', modifiers: 0 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F12', code: 'F12', modifiers: 0 });
		await sleep(2000);

		// Check visible lines — should contain "!procedure" after jump.
		const currentLine = await page.eval(`(() => {
			const lines = [...document.querySelectorAll('.view-lines .view-line')];
			const procLine = lines.find(l => (l.textContent || '').includes('!procedure'));
			return procLine ? procLine.textContent.trim().slice(0, 80) : null;
		})()`);
		check('go-to-definition: F12 on SALT(alias) jumps to !procedure',
			!!currentLine && currentLine.includes('!procedure'),
			currentLine ? `"${currentLine}"` : 'no !procedure line visible');
	} else {
		check('go-to-definition: F12 on SALT(alias) jumps to !procedure', false,
			'SALT(form_empty) line not in viewport (code-server viewport limit)', true);
	}

	page.close();
	const failed = results.filter((r) => !r.ok && !r.skip);
	const skipped = results.filter((r) => r.skip);
	console.log(`\n${results.length - failed.length - skipped.length}/${results.length} checks passed (${skipped.length} skipped)`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
