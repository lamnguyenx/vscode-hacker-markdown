#!/usr/bin/env node
'use strict';
/**
 * Pure-logic check for the PlantUML SVG inlining (`src/plantuml/inlineSvg.ts`):
 * the extension host fetches each diagram's SVG and replaces the `<img>` with
 * the inline `<svg>`, copying the fence-level `data-hmk-from`/`data-hmk-to`
 * onto the root so the webview can read the server's `data-source-code` salt
 * ranges.
 *
 * Run after a compile:
 *   npm run compile && node tests/plantuml_inline_check.cjs
 *
 * No dev host, no PlantUML server, no vscode API needed: the inline module
 * never imports vscode and the network call is injected (a stub fetcher).
 */
const assert = require('assert');
const { inlinePlantumlSvgs } = require('../out/plantuml/inlineSvg.js');

/** A stub fetcher that maps url -> svg body (or 404s for unknown urls). */
function stubFetcher(map) {
  return async (url) => ({
    ok: Object.prototype.hasOwnProperty.call(map, url),
    async text() {
      return map[url];
    },
  });
}

const SVG = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="white"/><g data-source-code="/abs/file.puml:4:1-10:1"><image xlink:href="data:image/svg+xml;base64,QUJD"/></g></svg>';
const SVG_NO_XML = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>';

function run(label, fn) {
  return fn().then(() => console.log(`  ok - ${label}`));
}

let count = 0;
function section(name) {
  count++;
  console.log(`\n#${count} ${name}`);
}

async function main() {
  section('inlinePlantumlSvgs replaces puml imgs with the fetched svg');
  await run('img -> inline svg, data-hmk-from/to copied to the root', async () => {
    const html = '<img style="background-color:#FFF;" data-hmk-from="3" data-hmk-to="18" data-hmk-puml src="http://localhost:9274/svg/abc">';
    const out = await inlinePlantumlSvgs(html, stubFetcher({ 'http://localhost:9274/svg/abc': SVG }));
    assert.ok(!out.includes('<img'), 'img not replaced: ' + out);
    assert.ok(/<svg\b[^>]*data-hmk-from="3"/.test(out), 'from span not copied: ' + out);
    assert.ok(/<svg\b[^>]*data-hmk-to="18"/.test(out), 'to span not copied: ' + out);
    assert.ok(out.includes('data-source-code="/abs/file.puml:4:1-10:1"'), 'salt range dropped: ' + out);
    assert.ok(!out.includes('<?xml'), 'xml declaration kept: ' + out);
  });
  await run('works without data-hmk-from/to (no data-line on the fence)', async () => {
    const html = '<img style="background-color:#FFF;" data-hmk-puml src="http://localhost:9274/svg/abc">';
    const out = await inlinePlantumlSvgs(html, stubFetcher({ 'http://localhost:9274/svg/abc': SVG }));
    assert.ok(out.includes('<svg xmlns="http://www.w3.org/2000/svg"'), 'no svg: ' + out);
    assert.ok(!out.includes('data-hmk-from'), 'unexpected span: ' + out);
  });
  await run('svg without xml declaration', async () => {
    const html = '<img style="background-color:#FFF;" data-hmk-puml src="http://localhost:9274/svg/abc">';
    const out = await inlinePlantumlSvgs(html, stubFetcher({ 'http://localhost:9274/svg/abc': SVG_NO_XML }));
    assert.ok(out.includes('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>'), 'bad svg: ' + out);
  });

  section('graceful degradation');
  await run('server 404 keeps the img', async () => {
    const html = '<img style="background-color:#FFF;" data-hmk-from="3" data-hmk-to="18" data-hmk-puml src="http://localhost:9274/svg/missing">';
    const out = await inlinePlantumlSvgs(html, stubFetcher({}));
    assert.strictEqual(out, html);
  });
  await run('fetcher rejection keeps the img', async () => {
    const html = '<img style="background-color:#FFF;" data-hmk-puml src="http://localhost:9274/svg/boom">';
    const out = await inlinePlantumlSvgs(html, async () => { throw new Error('down'); });
    assert.strictEqual(out, html);
  });
  await run('non-puml img untouched', async () => {
    const html = '<img src="./photo.png">';
    assert.strictEqual(await inlinePlantumlSvgs(html, stubFetcher({})), html);
  });
  await run('non-html body (no svg) keeps the img', async () => {
    const html = '<img style="background-color:#FFF;" data-hmk-puml src="http://localhost:9274/svg/bad">';
    const out = await inlinePlantumlSvgs(html, stubFetcher({ 'http://localhost:9274/svg/bad': 'not svg' }));
    assert.strictEqual(out, html);
  });

  section('multiple diagrams');
  await run('all inlined, order preserved, non-puml between kept', async () => {
    const html =
      '<img style="background-color:#FFF;" data-hmk-from="3" data-hmk-to="18" data-hmk-puml src="http://localhost:9274/svg/a">' +
      '<h1>mid</h1>' +
      '<img style="background-color:#FFF;" data-hmk-from="20" data-hmk-to="35" data-hmk-puml src="http://localhost:9274/svg/b">' +
      '<img src="plain.png">';
    const fetcher = stubFetcher({
      'http://localhost:9274/svg/a': '<svg id="A"></svg>',
      'http://localhost:9274/svg/b': '<svg id="B"></svg>',
    });
    const out = await inlinePlantumlSvgs(html, fetcher);
    const svgHas = (id, from, to) =>
      new RegExp(`<svg\\b(?=[^>]*id="${id}")(?=[^>]*data-hmk-from="${from}")(?=[^>]*data-hmk-to="${to}")[^>]*>`).test(out);
    assert.ok(svgHas('A', '3', '18'), 'A not inlined: ' + out);
    assert.ok(svgHas('B', '20', '35'), 'B not inlined: ' + out);
    assert.ok(out.includes('<h1>mid</h1>'), 'middle content lost: ' + out);
    assert.ok(out.includes('<img src="plain.png">'), 'plain img lost: ' + out);
    assert.ok(!out.includes('data-hmk-puml'), 'marker leftover: ' + out);
  });
  await run('one failing fetch, one success', async () => {
    const html =
      '<img style="background-color:#FFF;" data-hmk-puml src="http://localhost:9274/svg/ok">' +
      '<img style="background-color:#FFF;" data-hmk-puml src="http://localhost:9274/svg/fail">';
    const fetcher = stubFetcher({ 'http://localhost:9274/svg/ok': '<svg id="OK"></svg>' });
    const out = await inlinePlantumlSvgs(html, fetcher);
    assert.ok(out.includes('<svg id="OK"'), 'ok diagram not inlined: ' + out);
    assert.ok(out.includes('src="http://localhost:9274/svg/fail"'), 'failing diagram should stay an img: ' + out);
  });
  await run('no puml imgs -> fragment returned unchanged (same reference)', async () => {
    const html = '<p>hello</p>';
    assert.strictEqual(await inlinePlantumlSvgs(html, stubFetcher({})), html);
  });

  console.log('\nplantuml_inline_check: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});