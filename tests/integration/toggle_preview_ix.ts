// Integration check for the in-place "Toggle Preview" custom editor.
//
// Verifies:
//   - `Hacker Markdown: Toggle Preview` replaces the active Markdown tab with
//     the custom editor (no extra tab).
//   - Toggling again returns the same tab to the normal text editor.
//
// Rendering of the custom editor webview is intentionally not asserted here:
// code-server does not mount custom-editor webviews (the built-in Markdown
// preview shows the same empty pane), so that check belongs in the desktop dev
// host instead.
//
// Usage: bun tests/integration/toggle_preview_ix.ts [cdp-port]
import { sleep } from './cdp';
import { restCmd, restEval, restOpenFile } from './rest';
import { createSuite, WORKSPACE as WS } from './test_utils';

interface TabInfo {
	label: string;
	viewType?: string;
}

const PREVIEW_EDITOR = 'hackerMarkdown.previewEditor';

async function activeTab(): Promise<TabInfo | null> {
	return restEval<TabInfo | null>(`(() => {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (!tab) return null;
		return {
			label: tab.label,
			viewType: tab.input && 'viewType' in tab.input ? tab.input.viewType : undefined
		};
	})()`);
}

async function main(): Promise<void> {
	const { check, finish } = createSuite();

	await restCmd('workbench.action.closeAllEditors');
	await sleep(1000);
	await restOpenFile(`${WS}/test.md`);
	await sleep(1000);

	// Toggle source -> preview.
	await restCmd('hackerMarkdown.togglePreview');
	await sleep(2500);
	const previewTab = await activeTab();
	check('toggle: active tab is the Hacker Markdown preview editor',
		previewTab?.viewType === PREVIEW_EDITOR,
		`tab=${JSON.stringify(previewTab)}`);

	// Toggle preview -> source.
	await restCmd('hackerMarkdown.togglePreview');
	await sleep(2000);
	const sourceTab = await activeTab();
	check('toggle: active tab is back to the Markdown source',
		!!sourceTab && sourceTab.viewType !== PREVIEW_EDITOR && sourceTab.label.startsWith('test.md'),
		`tab=${JSON.stringify(sourceTab)}`);

	finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
