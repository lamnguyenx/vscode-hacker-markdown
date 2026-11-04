// Integration test for tables in a narrow preview viewport.
//
// Regression: in `fit` mode a table could not shrink below the longest
// unbreakable token in each cell (inline code, URLs), so in a narrow sidebar /
// panel it stayed wider than the reading column. The page body clips
// `overflow-x: hidden`, so the right-hand columns became unreachable — the
// rendered table appeared to lose text.
//
// Verifies:
//   - fit mode in a narrow pane: every table stays inside the reading column,
//     the last column is visible, and no horizontal scrolling is required;
//   - pan mode at the same width: the table is a horizontal scroll region and
//     the last column is reachable by scrolling;
//   - fit mode at 200% zoom (below the cells' padding floor): the table scrolls
//     internally instead of being clipped by the page.
//
// The narrow width is forced by shrinking the workbench page over CDP
// (Emulation.setDeviceMetricsOverride) — the workbench reflows its panes just
// like a sash drag, so the preview's own viewport narrows for real.
//
// Usage: bun tests/integration/narrow_table_ix.ts [cdp-port]
import { connectPreview, evalUntil, sleep } from './cdp';
import { restEval, restOpenFile } from './rest';
import { createSuite, SAMPLES } from './test_utils';

const FIXTURE = `${SAMPLES}/long-table-fail-02.md`;
// Shrinking the workbench page reflows the workbench itself (sidebars, editor
// groups), so the preview viewport narrows the same way it does when the user
// drags a sash — no synthetic webview sizing. The resulting preview width
// depends on the user's layout; the checks only require "narrower than the
// fixture's 833px table min-content".
const NARROW_PAGE_PX = 500;

const setTables = (value: string | undefined): Promise<unknown> =>
	restEval(
		`vscode.workspace.getConfiguration('hackerMarkdown').update('media.tables', ${JSON.stringify(value)}, vscode.ConfigurationTarget.Global)`,
	);

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const handle = await connectPreview(port);
	if (!handle) {
		console.error('NO_PREVIEW: run bun tests/integration/open_view.ts <port> first');
		process.exit(2);
	}

	const { check, finish } = createSuite();

	// Snapshot the settings so the suite leaves the shared workbench untouched.
	const tablesBefore = await restEval<string | null>(
		`vscode.workspace.getConfiguration('hackerMarkdown').inspect('media.tables').globalValue ?? null`,
	);
	const zoomBefore = await restEval<number | null>(
		`vscode.workspace.getConfiguration('hackerMarkdown').inspect('media.zoom').globalValue ?? null`,
	);

	// Force a narrow preview viewport by shrinking the workbench page. VS Code
	// reflows its own layout (the preview follows the sash-drag path); clearing
	// the override restores the real window size.
	await handle.page.send('Emulation.setDeviceMetricsOverride', {
		width: NARROW_PAGE_PX,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await sleep(700);

	const restoreViewport = async (): Promise<void> => {
		await handle.page.send('Emulation.clearDeviceMetricsOverride');
	};

	try {
		await restOpenFile(FIXTURE);
		await evalUntil(handle, `d.querySelector('.toolbar .doc-name')?.textContent === 'long-table-fail-02.md'`, 20000);
		await evalUntil(handle, `!!d.querySelector('.markdown-body table')`, 20000);

		const width = await handle.pEval(`d.defaultView.innerWidth`);
		// On an OOPIF dev host page emulation may not reach the webview target;
		// report that honestly instead of failing, and still run the clipping
		// assertions at whatever width we got.
		check('preview viewport is narrow', width <= NARROW_PAGE_PX, `innerWidth=${width}`, width > NARROW_PAGE_PX);

		// -------------------------------------------------------------------
		// 1. fit mode: the wide table must wrap inside the column
		// -------------------------------------------------------------------
		await setTables('fit');
		await evalUntil(handle, `d.body.dataset.tables === 'fit'`, 10000);

		const fit = await handle.pEval(`(() => {
			const bodyRect = d.body.getBoundingClientRect();
			const mb = d.querySelector('.markdown-body');
			const mbRect = mb.getBoundingClientRect();
			const mbStyle = d.defaultView.getComputedStyle(mb);
			const contentRight = mbRect.right - parseFloat(mbStyle.paddingRight || '0');
			const tables = [...d.querySelectorAll('.markdown-body table')];
			const wide = tables.find(t => t.rows[0]?.cells.length >= 6) || tables[0];
			const lastHeader = wide?.rows[0]?.cells[wide.rows[0].cells.length - 1];
			return {
				innerWidth: d.defaultView.innerWidth,
				bodyRight: Math.round(bodyRect.right),
				contentRight: Math.round(contentRight),
				tables: tables.map(t => ({
					right: Math.round(t.getBoundingClientRect().right),
					scrollWidth: t.scrollWidth,
					clientWidth: t.clientWidth,
					rows: t.rows.length,
					cols: t.rows[0]?.cells.length || 0,
				})),
				lastHeaderText: lastHeader?.textContent || '',
				lastHeaderRight: lastHeader ? Math.round(lastHeader.getBoundingClientRect().right) : null,
			};
		})()`);

		const wide = fit.tables.find((t: any) => t.cols >= 6) || fit.tables[0];
		check('wide table rendered with all 6 columns', wide?.cols === 6 && wide.rows === 3, `cols=${wide?.cols} rows=${wide?.rows}`);
		check(
			'fit: no table extends past the reading column',
			fit.tables.every((t: any) => t.right <= fit.contentRight + 1),
			`contentRight=${fit.contentRight} tables=${fit.tables.map((t: any) => t.right).join(',')}`,
		);
		check(
			'fit: no table extends past the page clip edge',
			fit.tables.every((t: any) => t.right <= fit.bodyRight + 1),
			`bodyRight=${fit.bodyRight} tables=${fit.tables.map((t: any) => t.right).join(',')}`,
		);
		check(
			'fit: last column is visible',
			fit.lastHeaderRight !== null && fit.lastHeaderRight <= fit.contentRight + 1 && fit.lastHeaderText.includes('Compiler toolchain'),
			`right=${fit.lastHeaderRight} text="${fit.lastHeaderText}"`,
		);
		check(
			'fit: table needs no horizontal scrolling',
			fit.tables.every((t: any) => t.scrollWidth <= t.clientWidth + 1),
			fit.tables.map((t: any) => `${t.scrollWidth}/${t.clientWidth}`).join(','),
		);

		// -------------------------------------------------------------------
		// 2. pan mode: the table pans and the last column stays reachable
		// -------------------------------------------------------------------
		await setTables('pan');
		await evalUntil(handle, `d.body.dataset.tables === 'pan'`, 10000);

		const pan = await handle.pEval(`(() => {
			const bodyRect = d.body.getBoundingClientRect();
			const tables = [...d.querySelectorAll('.markdown-body table')];
			const wide = tables.find(t => t.rows[0]?.cells.length >= 6) || tables[0];
			const ov = d.defaultView.getComputedStyle(wide).overflowX;
			const before = { scrollLeft: wide.scrollLeft, scrollWidth: wide.scrollWidth, clientWidth: wide.clientWidth };
			wide.scrollLeft = wide.scrollWidth;
			const rect = wide.getBoundingClientRect();
			const lastCells = [...wide.rows].map(r => r.cells[r.cells.length - 1]);
			return {
				bodyRight: Math.round(bodyRect.right),
				tableRight: Math.round(rect.right),
				overflowX: ov,
				before,
				scrolled: wide.scrollLeft,
				lastCellsInView: lastCells.every(c => c.getBoundingClientRect().right <= rect.right + 1),
			};
		})()`);

		check(
			'pan: table is its own horizontal scroll region',
			pan.overflowX === 'auto' && pan.before.scrollWidth > pan.before.clientWidth,
			`overflowX=${pan.overflowX} ${pan.before.scrollWidth}/${pan.before.clientWidth}`,
		);
		check('pan: table stays inside the page clip edge', pan.tableRight <= pan.bodyRight + 1, `tableRight=${pan.tableRight} bodyRight=${pan.bodyRight}`);
		check('pan: last column reachable by scrolling', pan.scrolled > 0 && pan.lastCellsInView, `scrollLeft=${pan.scrolled} inView=${pan.lastCellsInView}`);

		// -------------------------------------------------------------------
		// 3. fit mode at 200% zoom: even wrapping cannot shrink below the
		//    cells' padding floor, so the table must scroll instead of clipping
		// -------------------------------------------------------------------
		await setTables('fit');
		await restEval(`vscode.workspace.getConfiguration('hackerMarkdown').update('media.zoom', 200, vscode.ConfigurationTarget.Global)`);
		await evalUntil(handle, `d.documentElement.style.getPropertyValue('--hmk-zoom') === '2'`, 10000);
		const zoomed = await handle.pEval(`(() => {
			const bodyRect = d.body.getBoundingClientRect();
			const tables = [...d.querySelectorAll('.markdown-body table')];
			const wide = tables.find(t => t.rows[0]?.cells.length >= 6) || tables[0];
			const rect = wide.getBoundingClientRect();
			return {
				bodyRight: Math.round(bodyRect.right),
				tableRight: Math.round(rect.right),
				scrollWidth: wide.scrollWidth,
				clientWidth: wide.clientWidth,
			};
		})()`);
		check(
			'fit @200%: table is not clipped by the page',
			zoomed.tableRight <= zoomed.bodyRight + 1,
			`tableRight=${zoomed.tableRight} bodyRight=${zoomed.bodyRight}`,
		);
		check(
			'fit @200%: table scrolls internally instead',
			zoomed.scrollWidth > zoomed.clientWidth,
			`${zoomed.scrollWidth}/${zoomed.clientWidth}`,
		);
	} finally {
		// Restore the shared state even if an assertion threw.
		await setTables(tablesBefore ?? undefined);
		await restEval(`vscode.workspace.getConfiguration('hackerMarkdown').update('media.zoom', ${zoomBefore ?? 100}, vscode.ConfigurationTarget.Global)`);
		await restoreViewport();
		handle.close();
		await finish();
	}
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
