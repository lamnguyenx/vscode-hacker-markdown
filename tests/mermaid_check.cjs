// Pure-logic check of the mermaid source-span rewrite (src/mermaid/fences.ts).
// Exercises the real shipped code in out/mermaid/fences.js — no dev host, no
// vscode — so it can run in plain Node.
//
// Usage: node tests/mermaid_check.cjs
const assert = require('assert');
const { mermaidSpans, rewriteMermaidSpans } = require('../out/mermaid/fences.js');

const section = (name) => console.log(`\n== ${name} ==`);

section('mermaidSpans: basic ```mermaid fence');
{
  const src = [
    '## Mermaid',        // 0
    '',                  // 1
    '```mermaid',        // 2
    'flowchart LR',      // 3
    '    A --> B',       // 4
    '```',               // 5
    '',                  // 6
    '## Next'            // 7
  ].join('\n');
  const spans = mermaidSpans(src);
  assert.deepStrictEqual(spans, [{ from: 2, to: 5 }]);
  console.log('ok - single fence span');
}

section('mermaidSpans: multiple fences + non-mermaid fences between');
{
  const src = [
    '```python',         // 0
    'print(1)',          // 1
    '```',               // 2
    '',                  // 3
    '```mermaid',        // 4
    'graph TD; A;',      // 5
    '```',               // 6
    '',                  // 7
    '```mermaid',        // 8
    'sequenceDiagram',   // 9
    'A->>B: hi',         // 10
    '```',               // 11
    '',                  // 12
    '```ts',             // 13
    'const x = 1;',      // 14
    '```'                // 15
  ].join('\n');
  const spans = mermaidSpans(src);
  assert.deepStrictEqual(spans, [{ from: 4, to: 6 }, { from: 8, to: 11 }]);
  console.log('ok - two mermaid fences, python/ts fences not matched');
}

section('mermaidSpans: a mermaid marker inside a non-mermaid fence is ignored');
{
  const src = [
    '```md',             // 0
    '```mermaid',        // 1  <-- looks like a fence, but we are inside a fence
    '```',               // 2  closes the md fence
    '',                  // 3
    '```mermaid',        // 4
    'graph A;',          // 5
    '```'                // 6
  ].join('\n');
  const spans = mermaidSpans(src);
  assert.deepStrictEqual(spans, [{ from: 4, to: 6 }]);
  console.log('ok - inner mermaid marker not an opening fence');
}

section('mermaidSpans: tilde fences and unclosed fence at EOF');
{
  const src = [
    '~~~mermaid',        // 0
    'graph A;',          // 1
    '~~~',               // 2
    '',                  // 3
    '```mermaid',        // 4
    'graph B;'           // 5 (unclosed)
  ].join('\n');
  const spans = mermaidSpans(src);
  assert.deepStrictEqual(spans, [{ from: 0, to: 2 }, { from: 4, to: 5 }]);
  console.log('ok - tilde + unclosed-at-EOF span');
}

section('mermaidSpans: :::mermaid container');
{
  const src = [
    ':::mermaid',        // 0
    'graph A;',          // 1
    ':::',
    ''
  ].join('\n');
  const spans = mermaidSpans(src);
  assert.deepStrictEqual(spans, [{ from: 0, to: 2 }]);
  console.log('ok - colon container span');
}

section('rewriteMermaidSpans: attaches spans in order');
{
  const html = [
    '<p data-line="0">intro</p>',
    '<pre class="mermaid" style="all: unset;">graph A;</pre>',
    '<p data-line="7">more</p>',
    '<div class="mermaid">graph B;</div>'
  ].join('\n');
  const out = rewriteMermaidSpans(html, [{ from: 2, to: 5 }, { from: 9, to: 12 }]);
  assert.ok(out.includes('<pre class="mermaid" data-hmk-from="2" data-hmk-to="5" style="all: unset;">'), 'fence tag rewritten');
  assert.ok(out.includes('<div class="mermaid" data-hmk-from="9" data-hmk-to="12">'), 'div tag rewritten');
  assert.strictEqual((out.match(/data-hmk-from=/g) || []).length, 2);
  console.log('ok - spans injected onto pre + div');
}

section('rewriteMermaidSpans: extra blocks get no range');
{
  const html = '<pre class="mermaid">only one</pre>\n<pre class="mermaid">two</pre>';
  const out = rewriteMermaidSpans(html, [{ from: 0, to: 2 }]);
  assert.ok(out.includes('data-hmk-from="0"'));
  assert.ok(!out.includes('data-hmk-to="3"'));
  assert.strictEqual((out.match(/data-hmk-to=/g) || []).length, 1);
  console.log('ok - block beyond the span list degrades gracefully');
}

console.log('\nmermaid_check: all checks passed');