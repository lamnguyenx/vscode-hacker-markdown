import { test, expect, chromium, type FrameLocator, type Page } from '@playwright/test';

/**
 * Zoom reset button regression test (CDP 9024 — code-server on pp browser).
 *
 * Bug: the reset-zoom button (the percentage readout, `data-command="resetZoom"`)
 * had no dedicated click handler — it fell through to the generic toolbar
 * handler in main.ts, which sent a `command` message to the host for a config
 * round-trip (setMedia → config.update → onDidChangeConfiguration → mediaState
 * broadcast). The round-trip took ~2s and stale stepZoom broadcasts from rapid
 * prior clicks arrived out of order, overriding the reset (zoom bounced to
 * 105–120% instead of staying at 100%).
 *
 * Fix (src/webview/menus.ts): the reset button now calls the local
 * `resetZoom()` directly (instant, like zoom-step buttons), with an echo guard
 * that ignores stale `mediaState` broadcasts within 3s of a local zoom action.
 *
 * See docs/important/how-to-test.md (Option A) and
 * docs/important/dev-code-on-nuc-test-on-pp.md for the CDP topology.
 */

const CDP_PORT = process.env.CDP_PORT || '9024';
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const CODE_SERVER_URL =
	'https://localhost:9620/?folder=/home/lamnt45/git/vscode-hacker-markdown';

/**
 * Connects to the pp CDP browser, finds the code-server tab, and returns a
 * FrameLocator for the hacker-markdown webview document.
 *
 * code-server nests the webview in same-origin iframes:
 *   workbench → iframe[src*="extensionId=…"] → iframe (preview doc with .toolbar)
 */
async function connectToPreview(): Promise<{
	browser: import('@playwright/test').Browser;
	page: Page;
	preview: FrameLocator;
}> {
	const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
	const context = browser.contexts()[0]!;
	const page = context
		.pages()
		.find((p) => p.url().includes('localhost:9620')) ?? (await context.newPage());

	if (!page.url().includes('localhost:9620')) {
		await page.goto(CODE_SERVER_URL, { waitUntil: 'domcontentloaded' });
	}

	// Descend into the code-server iframe nesting (2 levels: ext → preview).
	const preview = page
		.frameLocator('iframe[src*="extensionId=lamnguyenx.hacker-markdown"]')
		.frameLocator('iframe');

	// Wait for the toolbar to mount (the panel may already be visible).
	await preview.locator('.toolbar').waitFor({ timeout: 15000 });

	// Reset zoom to 100% so tests start from a known state (zoom persists
	// across tests in the shared code-server workspace).
	const resetBtn = preview.locator('[data-command="resetZoom"]');
	await resetBtn.click();
	await page.waitForTimeout(500);

	return { browser, page, preview };
}

test.describe('Zoom controls', () => {
	test('reset button instantly resets zoom to 100%', async () => {
		const { browser, page, preview } = await connectToPreview();
		try {
			const zoomValue = preview.locator('[data-command="resetZoom"]');
			const zoomIn = preview.locator('[data-zoom-step="+1"]');

			await expect(zoomValue).toHaveText('100%');

			for (let i = 0; i < 3; i++) await zoomIn.click();
			await expect(zoomValue).toHaveText('115%');

			// Reset must take effect immediately (bug: took ~2s).
			await zoomValue.click();
			await expect(zoomValue).toHaveText('100%');

			// Must stay at 100% through the stale-broadcast echo window (bug:
			// stale stepZoom broadcasts bumped it to 105–120%).
			await page.waitForTimeout(4500);
			await expect(zoomValue).toHaveText('100%');
		} finally {
			await browser.close();
		}
	});

	test('reset not overridden after rapid zoom-in', async () => {
		test.setTimeout(45000);
		const { browser, page, preview } = await connectToPreview();
		try {
			const zoomValue = preview.locator('[data-command="resetZoom"]');
			const zoomIn = preview.locator('[data-zoom-step="+1"]');

			await expect(zoomValue).toHaveText('100%');

			// Rapid-fire zoom in 5× → 125%.
			for (let i = 0; i < 5; i++) await zoomIn.click();
			await expect(zoomValue).toHaveText('125%');

			// Immediately reset.
			await zoomValue.click();
			await expect(zoomValue).toHaveText('100%');

			// The 5 stale setMedia posts fire onDidChangeConfiguration seconds
			// late — the echo guard must suppress them all.
			await page.waitForTimeout(5500);
			await expect(zoomValue).toHaveText('100%');
		} finally {
			await browser.close();
		}
	});

	test('Ctrl+0 keyboard shortcut resets zoom', async () => {
		const { browser, page, preview } = await connectToPreview();
		try {
			const zoomValue = preview.locator('[data-command="resetZoom"]');
			const zoomIn = preview.locator('[data-zoom-step="+1"]');

			await expect(zoomValue).toHaveText('100%');

			for (let i = 0; i < 2; i++) await zoomIn.click();
			await expect(zoomValue).toHaveText('110%');

			await preview.locator('.toolbar').press('Control+0');

			await expect(zoomValue).toHaveText('100%');
			await page.waitForTimeout(4500);
			await expect(zoomValue).toHaveText('100%');
		} finally {
			await browser.close();
		}
	});
});
