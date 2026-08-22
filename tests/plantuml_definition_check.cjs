#!/usr/bin/env node
'use strict';
/**
 * Pure-logic check for the PlantUML go-to-definition feature
 * (src/completions/definitions.ts + src/plantuml/invocations.ts).
 * Exercises the real shipped code in out/plantuml/invocations.js
 * against synthetic markdown documents — no dev host, no vscode API needed.
 *
 * Run after a compile:
 *   npm run compile && node tests/plantuml_definition_check.cjs
 */
const assert = require('assert');

const { aliasDefinitions, aliasOccurrences, invocationReferences, procedureFoldRanges, procedureNames } = require('../out/plantuml/invocations.js');

function run(label, fn) {
	fn();
	console.log(`  ok - ${label}`);
}

let count = 0;
function section(name) {
	count++;
	console.log(`\n#${count} ${name}`);
}

section('basic alias mapping');

//           0: # Title
//           1: (empty)
// fence->   2: ```plantuml
//           3: @startuml
//           4: (empty)
//           5: !procedure _form_empty()
//           6: {+
//           7:   "form text"
//           8: }
//           9: !endprocedure
//          10: (empty)
//          11: !procedure _sample_recording()
//          12: {+
//          13:   "recording"
//          14: }
//          15: !endprocedure
//          16: (empty)
//          17: (*) --> SALT(form_empty)
//          18: form_empty --> SALT(sample_recording)
//          19: (empty)
//          20: @enduml
// fclose->  21: ```
//           0: # Title
//           1: (empty)
// fence->   2: ```plantuml
//           3: @startuml
//           4: (empty)
//           5: !procedure _form_empty()
//           6: {+
//           7:   "form text"
//           8: }
//           9: !endprocedure
//          10: (empty)
//          11: !procedure _sample_recording()
//          12: {+
//          13:   "recording"
//          14: }
//          15: !endprocedure
//          16: (empty)
//          17: (*) --> SALT(form_empty)
//          18: form_empty --> SALT(sample_recording)
//          19: (empty)
//          20: @enduml
// fclose->  21: ```
const DOC_BASIC = [
	'# Title',
	'',
	'```plantuml',
	'@startuml',
	'',
	'!procedure _form_empty()',
	'{+',
	'  "form text"',
	'}',
	'!endprocedure',
	'',
	'!procedure _sample_recording()',
	'{+',
	'  "recording"',
	'}',
	'!endprocedure',
	'',
	'(*) --> SALT(form_empty)',
	'form_empty --> SALT(sample_recording)',
	'',
	'@enduml',
	'```',
].join('\n');

run('returns all aliases for the puml fence', () => {
	const defs = aliasDefinitions(DOC_BASIC, 2);
	assert.strictEqual(defs.size, 2);
	assert.strictEqual(defs.get('form_empty'), 5);
	assert.strictEqual(defs.get('sample_recording'), 11);
});

run('returns empty map for a fence with no procedures', () => {
	const doc = '```plantuml\n@startuml\nA -> B\n@enduml\n```';
	const defs = aliasDefinitions(doc, 0);
	assert.strictEqual(defs.size, 0);
});

run('returns empty map for a fence line that does not exist', () => {
	const defs = aliasDefinitions(DOC_BASIC, 9999);
	assert.strictEqual(defs.size, 0);
});

section('per-fence isolation');

//           0: ```puml        ← fence A
//           1: !procedure _foo()
//           2-5: body
//           6: (empty)
//           7: !procedure _bar()
//           8-11: body
//          12: ```
//          13: (empty)
//          14: ```puml        ← fence B
//          15: !procedure _baz()
//          16-19: body
//          20: ```
const DOC_MULTI = [
	'```puml',
	'!procedure _foo()',
	'{+',
	'  "foo"',
	'}',
	'!endprocedure',
	'',
	'!procedure _bar()',
	'{+',
	'  "bar"',
	'}',
	'!endprocedure',
	'```',
	'',
	'```puml',
	'!procedure _baz()',
	'{+',
	'  "baz"',
	'}',
	'!endprocedure',
	'```',
].join('\n');

run('fence A returns only its own aliases', () => {
	const defs = aliasDefinitions(DOC_MULTI, 0);
	assert.strictEqual(defs.size, 2);
	assert.ok(defs.has('foo'));
	assert.ok(defs.has('bar'));
	assert.strictEqual(defs.has('baz'), false);
});

run('fence B returns only its own aliases', () => {
	const defs = aliasDefinitions(DOC_MULTI, 14);
	assert.strictEqual(defs.size, 1);
	assert.strictEqual(defs.get('baz'), 15);
	assert.strictEqual(defs.has('foo'), false);
});

section('duplicate alias, first wins');

//           0: ```plantuml
//           1: !procedure _dup()
//           2-4: body
//           5: (empty)
//           6: !procedure _dup()
//           7-9: body
//          10: ```
const DOC_DUP = [
	'```plantuml',
	'!procedure _dup()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'!procedure _dup()',
	'{+',
	'}',
	'!endprocedure',
	'```',
].join('\n');

run('duplicate alias returns the first definition line', () => {
	const defs = aliasDefinitions(DOC_DUP, 0);
	assert.strictEqual(defs.size, 1);
	assert.strictEqual(defs.get('dup'), 1);
});

section('underscore stripping');

//           0: ```plantuml
//           1: !procedure _form_empty()
//           2-4: body
//           5: (empty)
//           6: !procedure __highlight()   — leading double underscore, alias is `_highlight`
//           7-9: body
//          10: ```
const DOC_UNDERSCORE = [
	'```plantuml',
	'!procedure _form_empty()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'!procedure __highlight()',
	'{+',
	'}',
	'!endprocedure',
	'```',
].join('\n');

run('leading underscore is stripped from alias', () => {
	const defs = aliasDefinitions(DOC_UNDERSCORE, 0);
	assert.strictEqual(defs.get('form_empty'), 1);
	assert.strictEqual(defs.has('_form_empty'), false);
});

run('only the first leading underscore is stripped', () => {
	const defs = aliasDefinitions(DOC_UNDERSCORE, 0);
	assert.strictEqual(defs.get('_highlight'), 6);
	assert.strictEqual(defs.has('__highlight'), false);
});

section('tildes and mixed fence types');

//           0: ~~~puml
//           1: !procedure _tilde_proc()
//           2-4: body
//           5: ~~~
const DOC_TILDE = [
	'~~~puml',
	'!procedure _tilde_proc()',
	'{+',
	'}',
	'!endprocedure',
	'~~~',
].join('\n');

run('tilde puml fence also finds procedures', () => {
	const defs = aliasDefinitions(DOC_TILDE, 0);
	assert.strictEqual(defs.size, 1);
	assert.strictEqual(defs.get('tilde_proc'), 1);
});

section('invocation references');

//           0: ```puml
//           1: !procedure _form_empty()
//           2-4: body
//           5: !endprocedure
//           6: !procedure _sample_recording()
//           7-9: body
//          10: !endprocedure
//          11: (empty)
//          12: (*) --> SALT(form_empty)            ← invocation #1
//          13: form_empty --> SALT(sample_recording)
//          14: note on link
//          15:   {{salt
//          16:   Type name
//          17:   }}
//          18: end note
//          19: (empty)
//          20: form_empty --> SALT(form_empty)      ← invocation #2 (repeated)
//          21: form_empty --> SALT(sample_recording) ← invocation #3 (repeated)
//          22: @enduml
//          23: ```
const DOC_REFERENCES = [
	'```puml',
	'!procedure _form_empty()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'!procedure _sample_recording()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'(*) --> SALT(form_empty)',
	'form_empty --> SALT(sample_recording)',
	'note on link',
	'  {{salt',
	'  Type name',
	'  }}',
	'end note',
	'',
	'form_empty --> SALT(form_empty)',
	'form_empty --> SALT(sample_recording)',
	'@enduml',
	'```',
].join('\n');

run('finds all SALT invocations for a repeated alias', () => {
	const refs = invocationReferences(DOC_REFERENCES, 0, 23, 'form_empty');
	assert.strictEqual(refs.length, 2);
	assert.strictEqual(refs[0], 11);
	assert.strictEqual(refs[1], 19);
});

run('finds SALT invocations for a non-repeated alias', () => {
	const refs = invocationReferences(DOC_REFERENCES, 0, 23, 'sample_recording');
	assert.strictEqual(refs.length, 2);
	assert.strictEqual(refs[0], 12);
	assert.strictEqual(refs[1], 20);
});

run('SALT calls in note/comments ignored by skip but not in args', () => {
	// The skip only applies to lines starting with ! or ' — note lines are
	// content lines. But `SALT(x)` inside a note block should not match a
	// different alias. Confirm `extra_alias` not in the fence returns empty.
	const refs = invocationReferences(DOC_REFERENCES, 0, 23, 'extra_alias');
	assert.strictEqual(refs.length, 0);
});

run('unknown alias returns empty array', () => {
	const refs = invocationReferences(DOC_REFERENCES, 0, 23, 'unknown');
	assert.strictEqual(refs.length, 0);
});

run('non-puml fence returns empty', () => {
	// The fence must contain data; a missing alias scans nothing.
	const refs = invocationReferences('```python\nx = 1\n```', 0, 2, 'x');
	assert.strictEqual(refs.length, 0);
});

section('aliasOccurrences basic detection');

//           0: ```puml
//           1: !procedure _form_empty()
//           2-4: body
//           5: !endprocedure
//           6: (empty)
//           7: --> SALT(form_empty)
//           8: (empty)
//           9: @enduml
//          10: ```
const DOC_OCC = [
	'```puml',
	'!procedure _form_empty()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'--> SALT(form_empty)',
	'',
	'@enduml',
	'```',
].join('\n');

run('aliasOccurrences finds definition + invocation', () => {
	const occs = aliasOccurrences(DOC_OCC, 0, 10, 'form_empty');
	assert.strictEqual(occs.length, 2);
	const def = occs.find((o) => o.kind === 'definition');
	const inv = occs.find((o) => o.kind === 'invocation');
	assert.ok(def);
	assert.strictEqual(def.line, 1);
	assert.strictEqual(def.startCol, 11); // _form_empty starts at col 11
	assert.strictEqual(def.endCol, 22);   // _form_empty ends at col 22
	assert.strictEqual(def.kind, 'definition');
	assert.ok(inv);
	assert.strictEqual(inv.line, 6);
	assert.strictEqual(inv.startCol, 9); // form_empty starts at col 9 (after SALT()
	assert.strictEqual(inv.endCol, 19);
	assert.strictEqual(inv.kind, 'invocation');
});

run('aliasOccurrences returns empty for unknown alias', () => {
	const occs = aliasOccurrences(DOC_OCC, 0, 10, 'unknown');
	assert.strictEqual(occs.length, 0);
});

run('aliasOccurrences returns empty outside fence', () => {
	const occs = aliasOccurrences(DOC_OCC, 999, 1000, 'form_empty');
	assert.strictEqual(occs.length, 0);
});

section('aliasOccurrences substring safety');

//           0: ```plantuml
//           1: !procedure _foo()
//           2-4: body
//           5: !endprocedure
//           6: (empty)
//           7: --> SALT(foo)
//           8: --> SALT(foobar)
//           9: !procedure _foobar()
//          10-12: body
//          13: !endprocedure
//          14: ```
const DOC_SUBSTR = [
	'```plantuml',
	'!procedure _foo()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'--> SALT(foo)',
	'--> SALT(foobar)',
	'!procedure _foobar()',
	'{+',
	'}',
	'!endprocedure',
	'```',
].join('\n');

run('SALT(foo) does not match SALT(foobar)', () => {
	const occs = aliasOccurrences(DOC_SUBSTR, 0, 13, 'foo');
	assert.strictEqual(occs.length, 2);
	assert.ok(occs.every((o) => o.line === 1 || o.line === 6));
});

run('_foo definition does not match _foobar', () => {
	const occs = aliasOccurrences(DOC_SUBSTR, 0, 13, 'foobar');
	assert.strictEqual(occs.length, 2); // definition + invocation
});

section('aliasOccurrences multiple invocations');

//           0: ```puml
//           1: !procedure _dup()
//           2-4: body
//           5: !endprocedure
//           6: (empty)
//           7: --> SALT(dup)   ← first
//           8: --> SALT(dup)   ← second
//           9: ```
const DOC_MULTI_INVOC = [
	'```puml',
	'!procedure _dup()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'--> SALT(dup)',
	'--> SALT(dup)',
	'```',
].join('\n');

run('aliasOccurrences finds all repeated invocations', () => {
	const occs = aliasOccurrences(DOC_MULTI_INVOC, 0, 9, 'dup');
	assert.strictEqual(occs.length, 3); // 1 definition + 2 invocations
	const invs = occs.filter((o) => o.kind === 'invocation');
	assert.strictEqual(invs.length, 2);
	assert.strictEqual(invs[0].line, 6);
	assert.strictEqual(invs[1].line, 7);
});

section('procedureFoldRanges');

//           0: ```plantuml
//           1: !procedure _a()
//           2-4: body
//           5: !endprocedure
//           6: (empty)
//           7: !procedure _b()
//           8-12: body
//          13: !endprocedure
//          14: ```
const DOC_FOLD = [
	'```plantuml',
	'!procedure _a()',
	'{+',
	'}',
	'!endprocedure',
	'',
	'!procedure _b()',
	'{+',
	'}',
	'}',
	'  inside b',
	'}',
	'!endprocedure',
	'```',
].join('\n');

run('procedureFoldRanges returns all pairs', () => {
	const ranges = procedureFoldRanges(DOC_FOLD);
	assert.strictEqual(ranges.length, 2);
	assert.strictEqual(ranges[0].startLine, 1);
	assert.strictEqual(ranges[0].endLine, 4);
	assert.strictEqual(ranges[1].startLine, 6);
	assert.strictEqual(ranges[1].endLine, 12);
});

run('procedureFoldRanges returns empty for no-proc fence', () => {
	const doc = '```puml\n@startuml\nA -> B\n@enduml\n```';
	assert.strictEqual(procedureFoldRanges(doc).length, 0);
});

run('procedureFoldRanges ignores non-puml fences', () => {
	const doc = '```python\ndef foo():\n    pass\n```';
	assert.strictEqual(procedureFoldRanges(doc).length, 0);
});

section('procedureNames');

//           0: ```plantuml
//           1: !unquoted procedure SALT($x)
//           2-4: body
//           5: !endprocedure
//           6: (empty)
//           7: !procedure _form_empty()
//           8-11: body
//          12: !endprocedure
//          13: ```
const DOC_PROC = [
	'```plantuml',
	'!unquoted procedure SALT($x)',
	'"{{salt',
	'%invoke_procedure("_"+$x)',
	'}}" as $x',
	'!endprocedure',
	'',
	'!procedure _form_empty()',
	'{+',
	'}',
	'!endprocedure',
	'```',
].join('\n');

run('procedureNames finds both !unquoted and !procedure names', () => {
	const names = procedureNames(DOC_PROC, 0);
	assert.strictEqual(names.length, 2);
	assert.ok(names.includes('SALT'));
	assert.ok(names.includes('_form_empty'));
});

run('procedureNames returns empty for no-proc fence', () => {
	const doc = '```puml\n@startuml\nA -> B\n@enduml\n```';
	assert.strictEqual(procedureNames(doc, 0).length, 0);
});

run('procedureNames returns empty outside fence', () => {
	assert.strictEqual(procedureNames(DOC_PROC, 999).length, 0);
});

console.log('\nplantuml_definition_check: all checks passed');