// Prepares the dev host / code-server for testing:
//   1. If the Hacker Markdown preview is already open, verify it.
//   2. Otherwise, open it via the command palette.
//   3. Poll until the preview document is reachable and has rendered content.
//
// Usage: bun tests/integration/open_view.ts [port]
import { connectPreview, evalUntil, getTargets, openCdpSession, runPaletteCommand, sleep } from './cdp';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';

	let handle = await connectPreview(port);

	if (!handle) {
		// Open the preview via the command palette.
		const targets = await getTargets(port);
		const page = targets.find((t) => t.type === 'page');
		if (!page) { console.error('NO_PAGE_TARGET'); process.exit(2); }
		const pageSession = await openCdpSession(page.webSocketDebuggerUrl);

		// Dismiss onboarding overlay (fresh dev-host profiles show it once).
		for (let i = 0; i < 10; i++) {
			const dismissed = await pageSession.eval(`(() => {
				const b = document.querySelector('.onboarding-a-close-btn');
				if (b) { b.click(); return 'dismissed'; }
				return document.querySelector('.onboarding-a-signin') ? 'present' : 'none';
			})()`);
			if (dismissed === 'none') break;
			await sleep(500);
		}

		// Reveal the preview.
		let revealed = false;
		for (let i = 0; i < 3 && !revealed; i++) {
			try {
				await runPaletteCommand(pageSession, 'Hacker Markdown: Open');
				revealed = true;
			} catch {
				await sleep(1000);
			}
		}
		pageSession.close();

		// Poll for the preview to appear.
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			handle = await connectPreview(port);
			if (handle) break;
			await sleep(1000);
		}
	}

	if (!handle) {
		console.error('PREVIEW_TIMEOUT: preview not found after 60s');
		process.exit(2);
	}

	// Verify the preview rendered content.
	const docName = await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent`, 60000);
	console.log(`view open; preview doc: ${docName}`);
	// Wait for at least one rendered element.
	await evalUntil(handle, `!!d.querySelector('#preview > *')`, 60000);
	handle.close();
	process.exit(0);
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
