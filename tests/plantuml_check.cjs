#!/usr/bin/env node
'use strict';
/**
 * Pure-logic check for the ported PlantUML markdown-preview rendering.
 * Exercises the real shipped code in out/plantuml/* (fences.js / diagram.js /
 * plantumlURL.js / include.js) against synthetic fragments that mimic exactly
 * what the built-in markdown engine's fenced renderer produces for a
 * `puml`/`plantuml`/`uml` block.
 *
 * Run after a compile:
 *   npm run compile && node tests/plantuml_check.cjs
 *
 * No dev host, no PlantUML server, no vscode API needed — the pure modules
 * never import vscode by design (src/plantuml/fences.ts, diagram.ts, ...).
 */
const assert = require('assert');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rewritePumlFences } = require('../out/plantuml/fences.js');
const { getDiagramURIComponent } = require('../out/plantuml/plantumlURL.js');

const SERVER = 'http://localhost:9274';

// markdown-it's escapeHtml escaped-set (used by the engine's highlight fallback)
function escapeHtml(str) {
  return str.replace(/[&<>"]/g, (m) => {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return '&quot;';
  });
}

// Reproduces the built-in engine's fenced output (plus the source-map
// data-line / code-line / hljs attrs the engine adds).
function fenceHtml(lang, source) {
  return `<pre class="code-line hljs" data-line="7" dir="auto"><code class="language-${lang}">${escapeHtml(source)}</code></pre>\n`;
}

// Independent decoder: reverse of the synchro.js encode64 + inflateRaw.
const REV = new Map();
for (let b = 0; b < 10; b++) REV.set(48 + b, b);
for (let b = 0; b < 26; b++) REV.set(65 + b, 10 + b);
for (let b = 0; b < 26; b++) REV.set(97 + b, 36 + b);
REV.set('-'.charCodeAt(0), 62);
REV.set('_'.charCodeAt(0), 63);

function decode64(data) {
  const out = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    const c1 = REV.get(data.charCodeAt(i));
    const c2 = REV.get(data.charCodeAt(i + 1));
    const c3 = REV.get(data.charCodeAt(i + 2));
    const c4 = REV.get(data.charCodeAt(i + 3));
    const n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  return Buffer.from(out);
}

function decodeDiagramUrl(url, srcBytes) {
  const component = url.split('/').pop();
  const inflated = zlib.inflateRawSync(decode64(component));
  const n = Math.min(inflated.length, srcBytes.length);
  assert.strictEqual(inflated.subarray(0, n).equals(srcBytes.subarray(0, n)), true, 'URL does not round-trip source');
  return inflated;
}

function run(label, fn) {
  fn();
  console.log(`  ok - ${label}`);
}

let count = 0;
function section(name) {
  count++;
  console.log(`\n#${count} ${name}`);
}

section('fence infos rewritten, other fences untouched');
run('puml', () => {
  const src = '@startuml\nAlice -> Bob\n@enduml';
  let out;
  out = rewritePumlFences(fenceHtml('puml', src), { server: SERVER, includePaths: [] });
  assert.ok(!out.includes('<pre'), 'puml block not replaced');
  const m = out.match(/<img style="background-color:#FFF;" src="([^"]+)"\/?>/);
  assert.ok(m, 'no img tag: ' + out);
  assert.ok(m[1].startsWith(SERVER + '/svg/'), 'wrong url: ' + m[1]);
  decodeDiagramUrl(m[1], Buffer.from(src));
});
run('plantuml', () => {
  const src = '@startuml\nA -> B\n@enduml';
  const out = rewritePumlFences(fenceHtml('plantuml', src), { server: SERVER, includePaths: [] });
  assert.ok(!out.includes('<pre'), 'plantuml block not replaced');
  assert.ok(out.includes('<img'), 'no img');
});
run('uml', () => {
  const src = '@startuml\nA -> B\n@enduml';
  const out = rewritePumlFences(fenceHtml('uml', src), { server: SERVER, includePaths: [] });
  assert.ok(out.includes('<img'), 'no img');
});
run('mermaid fence untouched', () => {
  const html = fenceHtml('mermaid', 'flowchart LR\n A --> B');
  const out = rewritePumlFences(html, { server: SERVER, includePaths: [] });
  assert.strictEqual(out, html);
});
run('unrelated code fence untouched', () => {
  const html = fenceHtml('python', 'def f():\n    return 1');
  const out = rewritePumlFences(html, { server: SERVER, includePaths: [] });
  assert.strictEqual(out, html);
});

section('no server configured -> fragments left alone');
run('identical output', () => {
  const html = fenceHtml('puml', '@startuml\nA -> B\n@enduml');
  assert.strictEqual(rewritePumlFences(html, { server: '', includePaths: [] }), html);
});

section('format selection');
run('ditaa uses png', () => {
  const src = '@startditaa\n+---+\n| A |\n+---+\n@endditaa';
  const out = rewritePumlFences(fenceHtml('puml', src), { server: SERVER, includePaths: [] });
  const m = out.match(/src="([^"]+)"/);
  assert.ok(m[1].startsWith(SERVER + '/png/'), 'expected png url: ' + m[1]);
  decodeDiagramUrl(m[1], Buffer.from(src));
});
run('salt uses svg', () => {
  const src = '@startsalt\n{+\n "Hello"\n}\n@endsalt';
  const out = rewritePumlFences(fenceHtml('puml', src), { server: SERVER, includePaths: [] });
  const m = out.match(/src="([^"]+)"/);
  assert.ok(m[1].startsWith(SERVER + '/svg/'), 'expected svg url: ' + m[1]);
});

section('newpage -> one img per page');
run('two pages', () => {
  const src = '@startuml\nA\nnewpage\nB\n@enduml';
  const out = rewritePumlFences(fenceHtml('puml', src), { server: SERVER, includePaths: [] });
  const imgs = [...out.matchAll(/<img[^>]*src="([^"]+)"/g)];
  assert.strictEqual(imgs.length, 2, 'expected 2 imgs, got ' + out);
  assert.ok(imgs[0][1].endsWith('/svg/' + getDiagramURIComponent(src)), 'page 0 should omit index');
  assert.ok(imgs[1][1].includes('/svg/1/'), 'page 1 should carry index: ' + imgs[1][1]);
  decodeDiagramUrl(imgs[1][1], Buffer.from(src));
});

section('HTML escaping round-trip');
run('cheapening of < > " in source', () => {
  const src = '@startuml\nA <-> B\n"quoted" <C>\n@enduml';
  const out = rewritePumlFences(fenceHtml('puml', src), { server: SERVER, includePaths: [] });
  const m = out.match(/src="([^"]+)"/);
  decodeDiagramUrl(m[1], Buffer.from(src));
});
run('literal &lt; in source stays literal', () => {
  const src = '@startuml\nParticipant "A&B"\n@enduml';
  const out = rewritePumlFences(fenceHtml('puml', src), { server: SERVER, includePaths: [] });
  const m = out.match(/src="([^"]+)"/);
  decodeDiagramUrl(m[1], Buffer.from(src));
});
run('unicode (salt glyphs) survives', () => {
  const src = '@startsalt\n{+\n  ▁▂▃▂▁\n}\n@endsalt';
  const out = rewritePumlFences(fenceHtml('puml', src), { server: SERVER, includePaths: [] });
  const m = out.match(/src="([^"]+)"/);
  decodeDiagramUrl(m[1], Buffer.from(src));
});

section('!include resolves relative to the markdown file folder');
run('include expands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmk-puml-'));
  try {
    // The included file carries its own @start/@end markers; those must be
    // stripped so the server receives a single well-formed diagram.
    fs.writeFileSync(path.join(dir, 'part.puml'), '@startuml\nAlice -> Bob\n@enduml\n');
    const src = '@startuml\n!include ./part.puml\n@enduml';
    const out = rewritePumlFences(fenceHtml('puml', src), {
      server: SERVER,
      includePaths: [],
      docUri: { scheme: 'file', fsPath: path.join(dir, 'doc.md') },
    });
    const m = out.match(/src="([^"]+)"/);
    const inflated = zlib.inflateRawSync(decode64(m[1].split('/').pop()));
    const body = inflated.toString('utf8');
    assert.ok(body.includes('Alice -> Bob'), 'include body missing: ' + body);
    const starts = (body.match(/@startuml/g) || []).length;
    const ends = (body.match(/@enduml/g) || []).length;
    assert.strictEqual(starts, 1, `included file's @start marker not stripped: ${body}`);
    assert.strictEqual(ends, 1, `included file's @end marker not stripped: ${body}`);
    assert.ok(body.includes('\nAlice -> Bob'), 'included body misplaced: ' + body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
run('missing include file falls back to the include line verbatim', () => {
  const src = '@startuml\n!include ./does-not-exist.puml\n@enduml';
  const out = rewritePumlFences(fenceHtml('puml', src), {
    server: SERVER,
    includePaths: [],
    docUri: { scheme: 'file', fsPath: '/nonexistent/doc.md' },
  });
  const m = out.match(/src="([^"]+)"/);
  const inflated = zlib.inflateRawSync(decode64(m[1].split('/').pop()));
  assert.ok(inflated.toString('utf8').includes('!include ./does-not-exist.puml'), 'include line should stay verbatim');
});

section('multiple puml fences in one fragment');
run('all replaced', () => {
  const html = fenceHtml('puml', '@startuml\nA -> B\n@enduml') + '\n<h1>mid</h1>\n' + fenceHtml('puml', '@startuml\nC -> D\n@enduml');
  const out = rewritePumlFences(html, { server: SERVER, includePaths: [] });
  const imgs = [...out.matchAll(/<img/g)];
  assert.strictEqual(imgs.length, 2, 'expected 2 imgs');
  assert.ok(out.includes('<h1>mid</h1>'), 'non-fence content lost');
});

console.log('\nplantuml_check: all checks passed');
