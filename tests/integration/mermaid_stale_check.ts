// Regression test for the "Re-rendering…" badge stuck on mermaid diagrams.
//
// See src/webview/stale.ts: `.mermaid-wrapper` must be excluded from the stale
// snapshot so the mermaid library's own re-render lifecycle runs undisturbed.
//
// This script drives the preview via CDP: it polls the preview DOM for
// `.hmk-stale-holder` / `.hmk-stale` during a refresh of a mermaid document
// and asserts neither ever appears.
//
// Usage:
//   npm run compile
//   vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/mermaid-fail.md"
//   bun tests/integration/mermaid_stale_check.ts 9024
import assert from 'node:assert';

import { connectPreview, sleep } from './cdp';

async function run(port: number): Promise<void> {
	const handle = await connectPreview(port);
	if (!handle) {
		console.log('SKIP: no preview webview found. Open a .md file with a ```mermaid fence first.');
		process.exit(0);
	}

	// 1. Verify a mermaid diagram is present. (Under code-server the "d" here
	//    is the preview document.)
	const info = await handle.pEval(`(() => {
		const wrapper = d.querySelector('.mermaid-wrapper');
		const mermaidPre = d.querySelector('pre.mermaid, .mermaid');
		const refreshBtn = d.querySelector('.toolbar-button[data-command="refresh"]');
		return {
			docName: (d.querySelector('.doc-name') || {}).textContent || '',
			hasMermaid: !!(wrapper || mermaidPre),
			hasWrapper: !!wrapper,
			hasRefresh: !!refreshBtn,
			childTags: Array.from(d.getElementById('preview').children).map(c => c.tagName + (c.className ? '.' + String(c.className).split(' ')[0] : ''))
		};
	})()`);
	console.log('Port ' + port + ': preview "' + info.docName + '"');
	console.log('  has .mermaid-wrapper: ' + info.hasWrapper);
	console.log('  has refresh button:   ' + info.hasRefresh);
	console.log('  preview children:     ' + info.childTags.join(', '));

	if (!info.hasMermaid) {
		handle.close();
		console.error('\nFAIL: no mermaid diagram in the preview — open a .md file with a ```mermaid fence.');
		process.exit(1);
	}
	if (!info.hasRefresh) {
		handle.close();
		console.error('\nFAIL: no refresh button in the toolbar.');
		process.exit(1);
	}

	// 2. Install a high-frequency poller that records every sample where a
	//    `.hmk-stale-holder` or `.hmk-stale` is present, then trigger refresh.
	//    The poll runs for 3 s after the click.
	await handle.pEval(`
		(() => {
			const preview = d.getElementById('preview');
			const samples = [];
			const t0 = performance.now();
			const poll = () => {
				const holder = preview.querySelector('.hmk-stale-holder, .hmk-stale');
				const svg = preview.querySelector('.mermaid-wrapper svg, .mermaid svg');
				samples.push({ t: Math.round(performance.now() - t0), h: holder ? 1 : 0, svg: svg ? 1 : 0 });
				if (performance.now() - t0 < 3000) { setTimeout(poll, 10); }
				else { d.defaultView.__staleResults = samples; }
			};
			d.defaultView.__staleResults = null;
			setTimeout(() => {
				const btn = d.querySelector('.toolbar-button[data-command="refresh"]');
				if (btn) btn.click();
				poll();
			}, 50);
			return 'polling started';
		})()
	`);

	// 3. Wait for the 3 s poll window to finish, then collect results.
	await sleep(3500);
	const result = await handle.pEval(`
		(() => {
			const s = d.defaultView.__staleResults || [];
			const holderSeen = s.filter(e => e.h === 1);
			return {
				total: s.length,
				holderSeenCount: holderSeen.length,
				firstSample: s[0] || null,
				lastSample: s[s.length - 1] || null,
			};
		})()
	`);
	handle.close();

	console.log('\n  samples collected:    ' + result.total);
	console.log('  stale-holder samples: ' + result.holderSeenCount);
	console.log('  range:                ' + (result.firstSample ? result.firstSample.t : '?') + 'ms – ' + (result.lastSample ? result.lastSample.t : '?') + 'ms');

	assert.strictEqual(result.holderSeenCount, 0, '\nFAIL: .hmk-stale-holder appeared ' + result.holderSeenCount + ' time(s) during a mermaid refresh.\n      The stale-diagram keeper should never fire for mermaid diagrams.');
	console.log('\nPASS: no .hmk-stale-holder appeared during mermaid refresh.');
}

const port = parseInt(process.env.CDP_PORT || process.argv[2] || '9024', 10);
run(port).catch((e: Error) => {
	console.error('ERROR:', e.message);
	process.exit(2);
});
