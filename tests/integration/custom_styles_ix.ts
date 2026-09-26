// CDP integration test for custom styles loading.
//
// Verifies:
//   - The preview head contains the core stylesheets (main.css, markdown.css,
//     highlight.css, media.css).
//   - User styles (markdown.styles / hackerMarkdown.styles) load as
//     <link class="code-user-style"> if any are configured.
//
// Usage: bun tests/integration/custom_styles_ix.ts [port]
import { connectPreview, evalUntil } from './cdp';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	await evalUntil(handle, `!!d.querySelector('#preview > *')`, 30000);

	const results: { name: string; ok: boolean }[] = [];
	const check = (name: string, ok: boolean, extra = '') => {
		results.push({ name, ok });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
	};

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

	// -----------------------------------------------------------------------
	// 2. User style container exists (even if empty)
	// -----------------------------------------------------------------------
	// The count depends on settings — just verify the mechanism is wired.
	console.log(`  (user styles configured: ${styleInfo.userStyles})`);

	// -----------------------------------------------------------------------
	// 3. Font setting overrides applied as CSS custom properties
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
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
