// Integration test for PlantUML fence rendering in the preview.
//
// Verifies that `plantuml`/`puml`/`uml` fenced code blocks render as server-fetched
// SVGs (or `<img>` fallbacks) inside the live preview webview, and that the
// fence source spans (`data-hmk-from`/`data-hmk-to`) are correctly attached.
//
// Uses REST API to open the fixture (deterministic — no Quick Open clicking)
// and CDP for assert only (read webview DOM).
//
// Usage: bun tests/integration/plantuml_render_check.ts [cdp-port]
import { connectPreview, evalUntil, sleep } from './cdp';
import { restOpenFile, restCmd } from './rest';
import { createSuite } from './test_utils';

const WS = '/home/lamnt45/git/vscode-hacker-markdown/tests/samples/workspace';
const FIXTURE = `${WS}/plantuml-render.md`;

const FENCE1 = { from: '4', to: '9' };
const FENCE2 = { from: '13', to: '19' };
const FENCE3 = { from: '23', to: '27' };
const PUML_FENCE_LANGS = ['plantuml', 'puml', 'uml'];

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';

	// 1. Connect to the preview.
	let handle = await connectPreview(port);
	if (!handle) {
		await restCmd('hackerMarkdown.open');
		await sleep(2000);
		handle = await connectPreview(port);
	}
	if (!handle) {
		console.error('NO_PREVIEW: open the Hacker Markdown view first');
		process.exit(2);
	}
	console.log(`preview connected (offset ${handle.offset.x},${handle.offset.y})`);

	const { check, finish } = createSuite();

	// 2. Open the fixture via REST (deterministic — no Quick Open).
	await restOpenFile(FIXTURE);
	await sleep(1500);

	// 3. Wait for rendering.
	const docName = await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent || ''`, 30000);
	console.log(`preview doc: ${docName}`);

	// Wait for the first puml element (server fetch + inline may take seconds).
	const found = await evalUntil(handle, `d.querySelectorAll('#preview [data-hmk-puml]').length`, 60000);
	if (!found || found === 0) {
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
	check('puml fence renders as svg or img', info.count >= 3, `got ${info.count} element(s)`);

	// -----------------------------------------------------------------------
	// Check 2: first fence source span
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
	check('fence 2 renders 2 pages (newpage)', f2All.length === 2, `got ${f2All.length} page(s)`);

	// -----------------------------------------------------------------------
	// Check 4: puml alias fence (different info-string) also renders
	// -----------------------------------------------------------------------
	const f3 = info.items.find((it: any) => it.from === FENCE3.from);
	check(`puml alias fence source span [${FENCE3.from}..${FENCE3.to}]`, !!f3 && f3.to === FENCE3.to,
		f3 ? `from=${f3.from} to=${f3.to}` : 'not found');

	// -----------------------------------------------------------------------
	// Check 5: no raw puml source left unreplaced
	// -----------------------------------------------------------------------
	const rawLeftover = await handle.pEval(`(() => {
		const codes = [...d.querySelectorAll('#preview pre code')];
		return codes.filter(c => {
			const cls = c.className || '';
			return ${JSON.stringify(PUML_FENCE_LANGS)}.some(lang => cls.includes('language-' + lang));
		}).length;
	})()`);
	check('no raw puml source left in preview', rawLeftover === 0,
		rawLeftover > 0 ? `${rawLeftover} unreplaced <pre><code>` : '');

	// -----------------------------------------------------------------------
	// Check 6: img src is valid or SVGs are inlined
	// -----------------------------------------------------------------------
	const imgItems = info.items.filter((it: any) => it.tag === 'IMG');
	const svgItems = info.items.filter((it: any) => it.tag === 'SVG');
	if (svgItems.length >= 3) {
		check(`svgs are inlined (${svgItems.length}/${info.count} are <svg>)`, true);
	} else if (imgItems.length >= 3) {
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

	handle.close();
	await finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
