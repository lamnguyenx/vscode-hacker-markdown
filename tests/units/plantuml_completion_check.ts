#!/usr/bin/env bun
/**
 * Pure-logic check for the PlantUML completion feature (src/completions/*).
 * Exercises the real shipped code in src/completions/{fences,words}.ts
 * against synthetic markdown documents — no dev host, no vscode API needed.
 *
 * Run with bun (no compile step — bun executes the TypeScript sources directly):
 *   bun tests/units/plantuml_completion_check.ts
 */
import assert from 'node:assert';

import { fenceAt, PLANTUML_FENCE_LANGS } from '../../src/completions/fences';
import {
	PLANTUML_LANGUAGE_WORDS,
	PLANTUML_TYPE_WORDS,
	PLANTUML_KEYWORDS,
	PLANTUML_PREPROCESSOR_WORDS,
	PLANTUML_SKINPARAM_WORDS,
	PLANTUML_COLOR_WORDS,
} from '../../src/completions/words';

function run(label: string, fn: () => void): void {
	fn();
	console.log(`  ok - ${label}`);
}

let count = 0;
function section(name: string): void {
	count++;
	console.log(`\n#${count} ${name}`);
}

// A small markdown doc with several fences. 0-indexed lines used below.
const DOC = [
	'# Title',                    // 0
	'',                           // 1
	'```python',                  // 2
	'print(1)',                   // 3
	'```',                        // 4
	'',                           // 5
	'```plantuml',                // 6
	'@startuml',                  // 7
	'participant Alice',          // 8
	'Alice -> Bob',               // 9
	'@enduml',                    // 10
	'```',                        // 11
	'',                           // 12
	'```puml',                    // 13
	'note over A',                // 14
	'```',                        // 15
	'',                           // 16
	'```uml',                     // 17
	'alt else',                   // 18
	'```',                        // 19
].join('\n');

section('inside vs outside fences');
run('inside python fence -> undefined', () => {
	assert.strictEqual(fenceAt(DOC, 3), undefined);
});
run('python opening line -> undefined', () => {
	assert.strictEqual(fenceAt(DOC, 2), undefined);
});
run('plantuml content line -> fence info', () => {
	const f = fenceAt(DOC, 8);
	assert.ok(f, 'expected a fence at line 8');
	assert.strictEqual(f.lang, 'plantuml');
	assert.strictEqual(f.startLine, 6);
	assert.strictEqual(f.endLine, 11);
});
run('puml content line -> fence info', () => {
	const f = fenceAt(DOC, 14);
	assert.ok(f, 'expected a fence at line 14');
	assert.strictEqual(f.lang, 'puml');
	assert.strictEqual(f.startLine, 13);
	assert.strictEqual(f.endLine, 15);
});
run('uml content line -> fence info', () => {
	const f = fenceAt(DOC, 18);
	assert.ok(f, 'expected a fence at line 18');
	assert.strictEqual(f.lang, 'uml');
	assert.strictEqual(f.startLine, 17);
	assert.strictEqual(f.endLine, 19);
});
run('closing fence line -> undefined', () => {
	assert.strictEqual(fenceAt(DOC, 19), undefined);
});
run('plain prose -> undefined', () => {
	assert.strictEqual(fenceAt(DOC, 0), undefined);
	assert.strictEqual(fenceAt(DOC, 5), undefined);
});
run('negative line -> undefined', () => {
	assert.strictEqual(fenceAt(DOC, -1), undefined);
});

section('fence edge cases');
run('case-insensitive info string', () => {
	const doc = ['```PlantUML', 'A -> B', '```'].join('\n');
	const f = fenceAt(doc, 1);
	assert.ok(f, 'expected a fence');
	assert.strictEqual(f.lang, 'plantuml');
});
run('info string with trailing attributes', () => {
	const doc = ['```plantuml title="flow"', 'A -> B', '```'].join('\n');
	const f = fenceAt(doc, 1);
	assert.ok(f, 'expected a fence');
	assert.strictEqual(f.lang, 'plantuml');
	assert.strictEqual(f.startLine, 0);
});
run('tilde fences', () => {
	const doc = ['~~~plantuml', 'A -> B', '~~~'].join('\n');
	const f = fenceAt(doc, 1);
	assert.ok(f, 'expected a fence');
	assert.strictEqual(f.lang, 'plantuml');
	assert.strictEqual(f.endLine, 2);
});
run('longer closing run accepted, shorter not', () => {
	const doc = ['```plantuml', 'A -> B', '````', 'C -> D'].join('\n');
	const f = fenceAt(doc, 1);
	assert.ok(f, 'expected a fence');
	assert.strictEqual(f.startLine, 0);
	assert.strictEqual(f.endLine, 2);
	assert.strictEqual(fenceAt(doc, 3), undefined, 'line after longer closer must be outside');
});
run('unclosed puml fence still completes', () => {
	const doc = ['```plantuml', 'A -> B'].join('\n');
	const f = fenceAt(doc, 1);
	assert.ok(f, 'unclosed fence should still be detected');
	assert.strictEqual(f.endLine, undefined);
});
run('mismatched closer char is content', () => {
	const doc = ['```plantuml', '~~~ not a closer', 'A -> B', '```'].join('\n');
	const f = fenceAt(doc, 2);
	assert.ok(f, 'expected a fence');
	assert.strictEqual(f.startLine, 0);
	assert.strictEqual(f.endLine, 3);
});
run('puml fence after a closed python fence', () => {
	const doc = ['```python', 'x', '```', '', '```puml', '@startuml', '@enduml', '```'].join('\n');
	const f = fenceAt(doc, 5);
	assert.ok(f, 'expected a fence');
	assert.strictEqual(f.lang, 'puml');
});

section('catalog sanity');
const catalogs: readonly (readonly string[])[] = [PLANTUML_TYPE_WORDS, PLANTUML_KEYWORDS, PLANTUML_PREPROCESSOR_WORDS, PLANTUML_SKINPARAM_WORDS, PLANTUML_COLOR_WORDS];
function all(): string[] {
	return catalogs.flat();
}
run('expected sizes match jebbs predefined.ts plus extensions', () => {
	assert.strictEqual(PLANTUML_TYPE_WORDS.length, 29);
	assert.strictEqual(PLANTUML_KEYWORDS.length, 109);
	assert.strictEqual(PLANTUML_PREPROCESSOR_WORDS.length, 28);
	assert.strictEqual(PLANTUML_SKINPARAM_WORDS.length, 514);
	assert.strictEqual(PLANTUML_COLOR_WORDS.length, 154);
});
run('key markers present', () => {
	const words = new Set(all());
	for (const w of ['@startuml', '@enduml', '@startjson', '@endjson', '@startyaml', '@startmindmap', '@startgantt', '@startwbs', 'participant', 'usecase', '!include', '!includesub', '!procedure', '!endprocedure', '!function', '!endfunction', '!return', '!assert', 'skinparam', 'BackgroundColor', 'AliceBlue', 'procedure', 'endprocedure']) {
		assert.ok(words.has(w), `missing ${w}`);
	}
});
run('grouped catalog covers every word', () => {
	const grouped = PLANTUML_LANGUAGE_WORDS.flatMap(g => g.words);
	assert.strictEqual(grouped.length, all().length);
	const kinds = new Set(PLANTUML_LANGUAGE_WORDS.map(g => g.kind));
	assert.deepStrictEqual([...kinds].sort(), ['color', 'field', 'function', 'keyword', 'struct']);
});
run('fence language set matches the three names', () => {
	assert.deepStrictEqual([...PLANTUML_FENCE_LANGS].sort(), ['plantuml', 'puml', 'uml']);
});

console.log('\nplantuml_completion_check: all checks passed');
