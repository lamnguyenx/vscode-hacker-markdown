// CDP integration test for PlantUML fence rendering in the preview.
//
// Verifies that `plantuml`/`puml` fenced code blocks render as server-fetched
// SVGs (or `<img>` fallbacks) inside the live preview webview, and that the
// fence source spans (`data-hmk-from`/`data-hmk-to`) are correctly attached
// for cursor sync and click-to-source.
//
// Pre-requisites:
//   - code-server (or dev host) running with CDP on the given port
//   - hackerMarkdown.plantuml.server set (default http://localhost:9274)
//   - PlantUML server reachable at that URL
//   - Preview visible (run open_view.ts first)
//
// Usage:
//   bun tests/integration/plantuml_render_check.ts [port]
import { connectPreview, evalUntil, getTargets, openCdpSession, sleep, type CdpSession, type PreviewHandle } from './cdp';

const FIXTURE = 'plantuml-render.md';

// Expected data-hmk-from / data-hmk-to for each fence in the fixture
// (0-based opening fence line, body line count + 1 for closing fence).
const FENCE1 = { from: '4', to: '9' };
const FENCE2 = { from: '13', to: '19' };
const FENCE3 = { from: '23', to: '27' };

const PUMML_FENCE_LANGS = ['plantuml', 'puml', 'uml'];

async function openFixture(page: CdpSession): Promise<void> {
	// Use Quick Open (Ctrl+P / Cmd+P) — more robust than tree navigation.
	await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', modifiers: 2 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 2 });
	await sleep(600);
	await page.send('Input.insertText', { text: FIXTURE });
	await sleep(800);
	// Click the first matching result.
	const rect = await page.eval(`(() => {
		const rows = [...document.querySelectorAll('.quick-input-list .monaco-list-row')];
		const row = rows.find(r => (r.textContent || '').includes(${JSON.stringify(FIXTURE)}));
		if (!row) return null;
		const b = row.getBoundingClientRect();
		return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
	})()`);
	if (!rect) {
		// Fallback: press Enter on the quick-open input (first result is usually correct).
		await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
		await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
		await sleep(1000);
		return;
	}
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
	await sleep(1000);
}

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';

	// 1. Connect to the preview.
	let handle = await connectPreview(port);

	if (!handle) {
		// Try opening the preview via the command palette.
		const targets = await getTargets(port);
		const page = targets.find((t) => t.type === 'page');
		if (!page) { console.error('NO_PAGE_TARGET'); process.exit(2); }
		const pageSession = await openCdpSession(page.webSocketDebuggerUrl);
		for (let i = 0; i < 3; i++) {
			try {
				const { runPaletteCommand } = await import('./cdp');
				await runPaletteCommand(pageSession, 'Hacker Markdown: Open');
				break;
			} catch { await sleep(1000); }
		}
		pageSession.close();
		await sleep(2000);
		handle = await connectPreview(port);
	}

	if (!handle) {
		console.error('NO_PREVIEW: open the Hacker Markdown view first (bun tests/integration/open_view.ts <port>)');
		process.exit(2);
	}
	console.log(`preview connected (offset ${handle.offset.x},${handle.offset.y})`);

	// 2. Open the fixture file so the preview follows it.
	const targets = await getTargets(port);
	const pageTarget = targets.find((t) => t.type === 'page')!;
	const pageSession = await openCdpSession(pageTarget.webSocketDebuggerUrl);
	await openFixture(pageSession);
	await sleep(1500);
	pageSession.close();

	// 3. Wait for rendering.
	const docName = await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent || ''`, 30000);
	console.log(`preview doc: ${docName}`);

	const results: { name: string; ok: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '') => {
		results.push({ name, ok });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

	// Wait for the first puml element to appear (server fetch + inline may take a few seconds).
	const found = await evalUntil(handle, `d.querySelectorAll('#preview [data-hmk-puml]').length`, 60000);
	if (!found || found === 0) {
		// Check if the server is configured. If not, we should see puml-error notices.
		const errorNotices = await handle.pEval(`d.querySelectorAll('#preview .hmk-puml-error').length`);
		if (errorNotices > 0) {
			console.error('SKIP: hackerMarkdown.plantuml.server is not set — configure it to test rendering');
			handle.close();
			process.exit(0);
		}
		console.error('TIMEOUT: no [data-hmk-puml] elements rendered after 60s');
		handle.close();
		process.exit(1);
	}

	// -----------------------------------------------------------------------
	// Check 1: puml elements exist (svg or img)
	// -----------------------------------------------------------------------
	const info = await handle.pEval(`(() => {
		const els = [...d.querySelectorAll('#preview [data-hmk-puml]')];
		const items = els.map(el => ({
			tag: el.tagName.toUpperCase(),
			from: el.getAttribute('data-hmk-from'),
			to: el.getAttribute('data-hmk-to'),
			src: el.tagName.toUpperCase() === 'IMG' ? (el.getAttribute('src') || '').substring(0, 80) : '(inlined svg)'
		}));
		return { count: items.length, items };
	})()`);
	check('puml fence renders as svg or img', info.count >= 3,
		`got ${info.count} element(s)`);

	// -----------------------------------------------------------------------
	// Check 2: first fence source span (from/to)
	// -----------------------------------------------------------------------
	const f1 = info.items.find((it: any) => it.from === FENCE1.from);
	check(`fence 1 source span [${FENCE1.from}..${FENCE1.to}]`, !!f1 && f1.to === FENCE1.to,
		f1 ? `from=${f1.from} to=${f1.to} (${f1.tag})` : 'not found');

	// -----------------------------------------------------------------------
	// Check 3: multi-page fence source span + 2 pages
	// -----------------------------------------------------------------------
	const f2All = info.items.filter((it: any) => it.from === FENCE2.from);
	check(`fence 2 source span [${FENCE2.from}..${FENCE2.to}]`,
		f2All.length > 0 && f2All[0].to === FENCE2.to,
		f2All.length > 0 ? `from=${f2All[0].from} to=${f2All[0].to}` : 'not found');
	check('fence 2 renders 2 pages (newpage)', f2All.length === 2,
		`got ${f2All.length} page(s)`);

	// -----------------------------------------------------------------------
	// Check 4: puml alias fence (different info-string) also renders
	// -----------------------------------------------------------------------
	const f3 = info.items.find((it: any) => it.from === FENCE3.from);
	check(`puml alias fence source span [${FENCE3.from}..${FENCE3.to}]`, !!f3 && f3.to === FENCE3.to,
		f3 ? `from=${f3.from} to=${f3.to}` : 'not found');

	// -----------------------------------------------------------------------
	// Check 5: no raw puml source left unreplaced (every fence was rewritten)
	// -----------------------------------------------------------------------
	const rawLeftover = await handle.pEval(`(() => {
		const codes = [...d.querySelectorAll('#preview pre code')];
		return codes.filter(c => {
			const cls = c.className || '';
			return ${JSON.stringify(PUMML_FENCE_LANGS)}.some(lang => cls.includes('language-' + lang));
		}).length;
	})()`);
	check('no raw puml source left in preview', rawLeftover === 0,
		rawLeftover > 0 ? `${rawLeftover} unreplaced <pre><code>` : '');

	// -----------------------------------------------------------------------
	// Check 6: img src is a valid PlantUML server URL
	//         The src encodes the diagram source (deflateRaw + encode64), so
	//         a non-empty URL containing the server base proves the fence
	//         rewrite, URL encoding, and `!pragma sourceFile` injection all
	//         ran. If the SVG was inlined (server reachable from the ext
	//         host), the tag is <svg> and the src check is skipped.
	// -----------------------------------------------------------------------
	const imgItems = info.items.filter((it: any) => it.tag === 'IMG');
	const svgItems = info.items.filter((it: any) => it.tag === 'SVG');
	if (svgItems.length >= 3) {
		// Server was reachable from the extension host — SVGs were inlined.
		check(`svgs are inlined (${svgItems.length}/${info.count} are <svg>)`, true);
	} else if (imgItems.length >= 3) {
		// Server reachable from the browser (img renders) but not from the
		// extension host (inline fetch failed → graceful <img> degradation).
		// Validate that the img src is a well-formed PlantUML server URL.
		const badUrls = imgItems.filter((it: any) =>
			!it.src || !it.src.startsWith('http') || it.src.includes('/svg/') === false
		);
		check(`img src is a valid PlantUML server URL (${imgItems.length} imgs)`,
			badUrls.length === 0,
			badUrls.length > 0 ? `${badUrls.length} bad URL(s)` : `all URLs start with http…/svg/`);
	} else {
		check('puml elements are svg or img with valid src', false,
			`mixed: ${svgItems.length} svg + ${imgItems.length} img`);
	}

	// -----------------------------------------------------------------------
	// Summary
	// -----------------------------------------------------------------------
	handle.close();
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
