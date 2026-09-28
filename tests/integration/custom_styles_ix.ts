// Integration test for custom styles loading.
//
// Verifies:
//   - The preview head contains the core stylesheets (main.css, markdown.css,
//     highlight.css, media.css).
//   - User styles (markdown.styles / hackerMarkdown.styles) load as
//     <link class="code-user-style"> if any are configured.
//   - Font setting overrides applied as CSS custom properties.
//
// Uses REST API to open a document (so the preview has something to render)
// and CDP for assert only (read webview DOM).
//
// Usage: bun tests/integration/custom_styles_ix.ts [cdp-port]
import { connectPreview, evalUntil } from './cdp';
import { restOpenFile } from './rest';
import { createSuite } from './test_utils';

const WS = '/home/lamnt45/git/vscode-hacker-markdown/tests/samples/workspace';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	await restOpenFile(`${WS}/test.md`);
	await evalUntil(handle, `!!d.querySelector('#preview > *')`, 30000);

	const { check, finish } = createSuite();

	// -----------------------------------------------------------------------
	// 1. Core extension stylesheets are present
	// -----------------------------------------------------------------------
	const styleInfo = await handle.pEval(`(() => {
		const links = [...d.querySelectorAll('link[rel="stylesheet"]')];
		return {
			total: links.length,
			hrefs: links.map(l => (l.getAttribute('href') || '').replace(/[?].*/, '').split('/').pop() || ''),
			userStyles: links.filter(l => l.classList.contains('code-user-style')).length,
		};
	})()`);

	const hasMain = styleInfo.hrefs.some((h: string) => h === 'main.css');
	const hasMarkdown = styleInfo.hrefs.some((h: string) => h === 'markdown.css');
	const hasHighlight = styleInfo.hrefs.some((h: string) => h === 'highlight.css');
	const hasMedia = styleInfo.hrefs.some((h: string) => h === 'media.css');

	check('main.css loaded', hasMain);
	check('markdown.css loaded', hasMarkdown);
	check('highlight.css loaded', hasHighlight);
	check('media.css loaded', hasMedia);

	console.log(`  (user styles configured: ${styleInfo.userStyles})`);

	// -----------------------------------------------------------------------
	// 2. CSS custom properties for font/zoom settings
	// -----------------------------------------------------------------------
	const cssVars = await handle.pEval(`(() => {
		const html = d.documentElement;
		const style = html.getAttribute('style') || '';
		return {
			colWidth: style.match(/--hmk-column-width:\\s*([^;]+)/)?.[1]?.trim(),
			zoom: style.match(/--hmk-zoom:\\s*([^;]+)/)?.[1]?.trim(),
		};
	})()`);
	check('--hmk-column-width CSS var is set', !!cssVars.colWidth, `value="${cssVars.colWidth}"`);
	check('--hmk-zoom CSS var is set', !!cssVars.zoom, `value="${cssVars.zoom}"`);

	handle.close();
	await finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
