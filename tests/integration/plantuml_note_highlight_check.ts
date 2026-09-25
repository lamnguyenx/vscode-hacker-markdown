// Regression test for the PlantUML note-on-link highlighting bug
// (vue.volar injection grammar corruption).
//
// Scans the visible .view-line tokens in the Monaco editor, asserts that
// `note on link`, `-->`, and `end note` lines have multiple mtk spans.
//
// Usage:
//   bun tests/integration/plantuml_note_highlight_check.ts [port]
import { getTargets, openCdpSession, sleep, type CdpSession } from './cdp';

interface Token {
	t: string;
	c: string;
}

interface Sample {
	text: string;
	tokens: Token[];
	bad: boolean;
}

async function run(port: number): Promise<void> {
	const targets = await getTargets(port);
	const page = targets.find((t) => t.type === 'page' && ((t.url || '').startsWith('vscode-file') || (t.url || '').includes('localhost')));
	if (!page) throw new Error(`no workbench page target on port ${port}`);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
	ws.addEventListener('message', (ev) => {
		const msg = JSON.parse(String(ev.data));
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id)!;
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		}
	});
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve);
		ws.addEventListener('error', reject);
	});
	const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
		new Promise((resolve, reject) => {
			const mid = ++id;
			pending.set(mid, { resolve, reject });
			ws.send(JSON.stringify({ id: mid, method, params }));
		});
	await send('Runtime.enable');

	// 1. Focus the monaco editor.
	const center = await send('Runtime.evaluate', {
		returnByValue: true,
		expression:
			'(() => { const e = document.querySelector(".monaco-editor .overflow-guard") || document.querySelector(".monaco-editor"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()',
	});
	if (!center.result.value) throw new Error('no .monaco-editor in workbench — open a markdown file first');
	const pt = center.result.value;
	await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt });
	await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt });
	await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt });
	await sleep(400);

	// 2. Go to line 320 (first `note on link` of the activity diagram; test fixture is 1-based).
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71 });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71 });
	await sleep(300);
	await send('Input.insertText', { text: '320' });
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await sleep(900);

	// 3. Read every visible .view-line; collect its `mtk*` token spans.
	const probe = await send('Runtime.evaluate', {
		returnByValue: true,
		expression:
			'(() => {' +
			'  const lines = document.querySelectorAll(".view-lines .view-line");' +
			'  const out = [];' +
			'  for (const l of lines) {' +
			'    const toks = Array.from(l.querySelectorAll("span[class*=\\"mtk\\"]"))' +
			'      .map((s) => ({ t: s.textContent, c: s.className }));' +
			'    out.push({ text: l.textContent, toks });' +
			'  }' +
			'  return out;' +
			'})()',
	});
	ws.close();

	const rows: any[] = probe.result.value;
	if (!Array.isArray(rows) || rows.length === 0)
		throw new Error('no .view-line rows received — editor may not have focus');

	// 4. Filter and assert.
	const norm = (t: string) => t.replace(/\u00a0/g, ' ').trim();
	const flat = (toks: Token[]) => toks.length <= 1;
	const hasUnexpectedClose = (toks: Token[]) => toks.some((t) => /\bunexpected-closing-bracket\b/.test(t.c || ''));
	const isNoteOpen = (t: string) => norm(t) === 'note on link';
	const isArrowLine = (t: string) => /-->/.test(t) && /SALT\(/.test(t);
	const isNoteClose = (t: string) => norm(t) === 'end note';

	const failing: { text: string; kind: string; tokens: Token[] }[] = [];
	const samples: { keyword: Sample[]; arrows: Sample[]; endnote: Sample[] } = { keyword: [], arrows: [], endnote: [] };
	for (const row of rows) {
		const text = row.text;
		const normText = norm(text);
		if (normText === '') continue;
		if (isNoteOpen(text)) {
			const bad = flat(row.toks);
			samples.keyword.push({ text: normText, tokens: row.toks, bad });
			if (bad) failing.push({ text: normText, kind: 'note-on-link', tokens: row.toks });
		} else if (isArrowLine(text)) {
			const bad = flat(row.toks) || hasUnexpectedClose(row.toks);
			samples.arrows.push({ text: normText, tokens: row.toks, bad });
			if (bad) failing.push({ text: normText, kind: 'arrow', tokens: row.toks });
		} else if (isNoteClose(text)) {
			samples.endnote.push({ text: normText, tokens: row.toks, bad: false });
		}
	}

	console.log(`Port ${port}: scanned ${rows.length} visible .view-line rows`);
	if (process.env.DEBUG) {
		console.log('--- all visible line texts:');
		for (const r of rows) {
			const cps = Array.from(r.text as string).map((c) => c.codePointAt(0)).filter((cp) => cp !== 0x20 && (cp! < 0x21 || cp! > 0x7e));
			console.log(`  ${JSON.stringify((r.text as string).slice(0, 60))} toks=${r.toks.length} weird_cps=[${cps.join(',')}]`);
		}
	}
	console.log(`  'note on link' lines seen:  ${samples.keyword.length}`);
	console.log(`  '--> SALT(...)' lines seen: ${samples.arrows.length}`);
	console.log(`  'end note' lines seen:      ${samples.endnote.length}`);

	const dump = (arr: Sample[]) =>
		arr
			.slice(0, 6)
			.map(
				(s) =>
					`    ${JSON.stringify(s.text)} bad=${s.bad} toks=${s.tokens.length} classes=[${[...new Set(s.tokens.map((t) => t.c.split(' ')[0]))].join(',')}] unexpected_close=${s.tokens.some((t) => /\bunexpected-closing-bracket\b/.test(t.c || ''))}`
			)
			.join('\n');
	console.log('  note-on-link samples:\n' + dump(samples.keyword));
	console.log('  arrow samples:\n' + dump(samples.arrows));

	if (failing.length > 0) {
		console.error(`\nFAIL: ${failing.length} line(s) collapsed to a single flat token span after the first 'end note'.`);
		console.error('      This is the documented Volar+PlantUML SALT bug when vue.volar is enabled.');
		process.exit(1);
	}

	console.log('\nPASS: every note/--> line in the visible window has more than one token span.');
}

const port = parseInt(process.env.CDP_PORT || process.argv[2] || '9024', 10);
run(port).catch((e: Error) => {
	console.error('ERROR:', e.message);
	process.exit(2);
});