// Integration test for PlantUML IntelliSense inside markdown fences.
//
// Verifies that the Language Feature providers registered on `markdown` are
// active in the editor:
//   - Code lens: "N references" text appears above !procedure definitions.
//   - Folding: !procedure/!endprocedure blocks are foldable.
//   - Go-to-definition: F12 on SALT(alias) moves the cursor.
//
// Uses REST API exclusively — `vscode.executeCodeLensProvider`,
// `vscode.executeFoldingRangeProvider`, and `vscode.executeDefinitionProvider`
// are all called directly in the extension host. No monaco virtualization
// issues, no F12 timing, no viewport-wait SKIP.
//
// Usage: bun tests/integration/plantuml_intellisense_ix.ts [cdp-port]
import { restOpenFile, restEval } from './rest';
import { createSuite } from './test_utils';

const WS = '/home/lamnt45/git/vscode-hacker-markdown/tests/samples';
const FIXTURE = `${WS}/enroll-flow.puml.md`;

async function main(): Promise<void> {
	const { check, finish } = createSuite();

	// Open the fixture via REST.
	await restOpenFile(FIXTURE);
	await new Promise(r => setTimeout(r, 3000));

	// -----------------------------------------------------------------------
	// 1. Code lens: count lenses via the language provider.
	// -----------------------------------------------------------------------
	const codeLenses = await restEval<{
		count: number;
		samples: { line: number; title: string }[];
	}>(`
		(async () => {
			const uri = vscode.window.activeTextEditor.document.uri;
			const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
			if (!Array.isArray(lenses)) return { count: 0, samples: [] };
			const samples = lenses.slice(0, 5).map(l => ({
				line: l.range.start.line,
				title: l.command?.title || ''
			}));
			return { count: lenses.length, samples };
		})()
	`);
	check('code lens registered (N references above procedures)', codeLenses.count > 0,
		`found ${codeLenses.count} codelens elements`);
	if (codeLenses.count > 0) {
		console.log(`    samples: ${codeLenses.samples.map(s => s.title).join(' | ')}`);
	}

	// -----------------------------------------------------------------------
	// 2. Folding: call `vscode.executeFoldingRangeProvider`.
	// -----------------------------------------------------------------------
	const foldRanges = await restEval<{ count: number }>(`
		(async () => {
			const uri = vscode.window.activeTextEditor.document.uri;
			const ranges = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', uri);
			return { count: Array.isArray(ranges) ? ranges.length : 0 };
		})()
	`);
	check('folding range provider active (foldable ranges present)',
		foldRanges.count > 0, `fold ranges: ${foldRanges.count}`);

	// -----------------------------------------------------------------------
	// 3. Go-to-definition: find a SALT(alias) call and resolve its definition.
	//    All done inside a single REST eval — the alias position and definition
	//    result are both computed in the extension host.
	// -----------------------------------------------------------------------
	const defResult = await restEval<{ found: boolean; line: number; text: string } | null>(`
		(async () => {
			const doc = vscode.window.activeTextEditor.document;
			const text = doc.getText();
			const lines = text.split('\\n');
			// Find first SALT(alias) — measure the column of the alias word.
			let saltLine = -1, saltCol = -1, alias = '';
			for (let i = 0; i < lines.length; i++) {
				const m = lines[i].match(/SALT\\((\\w+)/);
				if (m) { saltLine = i; saltCol = lines[i].indexOf(m[1]); alias = m[1]; break; }
			}
			if (saltLine < 0) return null;
			const pos = new vscode.Position(saltLine, saltCol);
			const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos);
			if (!result || !result.length) return { found: false, line: -1, text: '' };
			const loc = Array.isArray(result) ? result[0] : result;
			const range = loc.range || loc;
			const defLine = range.start ? range.start.line : loc.line;
			return { found: true, line: defLine, text: doc.lineAt(defLine).text };
		})()
	`);

	if (!defResult) {
		check('go-to-definition: SALT(alias) found in fixture', false, 'no SALT() calls found', true);
	} else {
		check('go-to-definition: SALT(alias) resolves to !procedure line',
			defResult.found && !!defResult.text && defResult.text.includes('!procedure'),
			defResult.found ? `"${defResult.text}"` : 'no definition found');
	}

	finish();
}

main().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
