// Regression test for the "Re-rendering…" badge stuck on mermaid diagrams.
//
// The bug: `snapshotStaleBlocks()` in `src/webview/stale.ts` captured the
// rendered `.mermaid-wrapper` (which loses its `data-line` during mermaid's
// render) as an anonymous gap block. But the new fragment's `<pre
// class="mermaid">` keeps `data-line` (engine source map), so it is NOT a gap
// block — the positional keying then paired the old wrapper with a sibling
// SPAN at the same gap slot, wrapped it in a `.hmk-stale-holder`, and waited
// 8 s for an SVG that never lands inside it. Result: a persistent
// "Re-rendering…" badge + blank space around the wrong element for 8 seconds
// on every refresh, even though the actual render was ~40 ms.
//
// The fix (`src/webview/stale.ts`): exclude `.mermaid-wrapper` from the stale
// snapshot — mermaid's own library handles its re-render lifecycle, and the
// anchor guard (`anchor.ts`) covers the scroll position. The stale keeper
// only adds value for PlantUML `<img>`s.
//
// This script drives the webview over CDP: it polls the preview DOM for
// `.hmk-stale-holder` / `.hmk-stale` during a refresh of a mermaid document
// and asserts neither ever appears.
//
// Usage:
//   npm run compile
//   vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/mermaid-fail.md"
//   node tests/mermaid_stale_check.cjs 9032

const http = require('http');

function getTargets(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function run(port) {
  const targets = await getTargets(port);
  // The webview OOPIF is an 'iframe' target with a vscode-webview:// URL.
  const target = targets.find((t) => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview'));
  if (!target) {
    console.error('No webview OOPIF target found. Visible targets:');
    for (const t of targets) console.error('  ' + t.type + ' ' + (t.url || '').slice(0, 80));
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await send('Runtime.enable');

  // 1. Reach the preview document through the nested iframe and verify a
  //    mermaid diagram is present.
  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression:
      '(() => {' +
      '  const iframe = document.querySelector("iframe");' +
      '  if (!iframe || !iframe.contentDocument) return { error: "no inner iframe" };' +
      '  const d = iframe.contentDocument;' +
      '  const preview = d.getElementById("preview");' +
      '  if (!preview) return { error: "no #preview" };' +
      '  const wrapper = preview.querySelector(".mermaid-wrapper");' +
      '  const mermaidPre = preview.querySelector("pre.mermaid, .mermaid");' +
      '  const refreshBtn = d.querySelector(\'.toolbar-button[data-command="refresh"]\');' +
      '  return {' +
      '    docName: (d.querySelector(".doc-name") || {}).textContent || "",' +
      '    hasMermaid: !!(wrapper || mermaidPre),' +
      '    hasWrapper: !!wrapper,' +
      '    hasRefresh: !!refreshBtn,' +
      '    childTags: Array.from(preview.children).map(c => c.tagName + (c.className ? "." + String(c.className).split(" ")[0] : ""))' +
      '  };' +
      '})()',
  });
  const info = probe.result.value;
  if (!info || info.error) {
    ws.close();
    throw new Error('cannot reach preview: ' + (info ? info.error : 'eval failed'));
  }
  console.log('Port ' + port + ': preview "' + info.docName + '"');
  console.log('  has .mermaid-wrapper: ' + info.hasWrapper);
  console.log('  has refresh button:   ' + info.hasRefresh);
  console.log('  preview children:     ' + info.childTags.join(', '));

  if (!info.hasMermaid) {
    ws.close();
    console.error('\nFAIL: no mermaid diagram in the preview — open a .md file with a ```mermaid fence.');
    console.error('      e.g. vscode_cdp --profile "$PWD/exp/devhost" --file "$PWD/tests/samples/mermaid-fail.md"');
    process.exit(1);
  }
  if (!info.hasRefresh) {
    ws.close();
    console.error('\nFAIL: no refresh button in the toolbar.');
    process.exit(1);
  }

  // 2. Install a high-frequency poller that records every sample where a
  //    `.hmk-stale-holder` or `.hmk-stale` is present, then trigger refresh.
  //    The poll runs for 3 s after the click — long enough to cover the
  //    150 ms render + mermaid's async SVG render, short enough to be snappy.
  const pollExpr =
    '(() => {' +
    '  const iframe = document.querySelector("iframe");' +
    '  const d = iframe.contentDocument;' +
    '  const w = iframe.contentWindow;' +
    '  const preview = d.getElementById("preview");' +
    '  const samples = [];' +
    '  const t0 = performance.now();' +
    '  const poll = () => {' +
    '    const holder = preview.querySelector(".hmk-stale-holder, .hmk-stale");' +
    '    const svg = preview.querySelector(".mermaid-wrapper svg, .mermaid svg");' +
    '    samples.push({ t: Math.round(performance.now() - t0), h: holder ? 1 : 0, svg: svg ? 1 : 0 });' +
    '    if (performance.now() - t0 < 3000) { setTimeout(poll, 10); }' +
    '    else { w.__staleResults = samples; }' +
    '  };' +
    '  w.__staleResults = null;' +
    '  setTimeout(() => {' +
    '    const btn = d.querySelector(\'.toolbar-button[data-command="refresh"]\');' +
    '    if (btn) btn.click();' +
    '    poll();' +
    '  }, 50);' +
    '  return "polling started";' +
    '})()';
  await send('Runtime.evaluate', { returnByValue: true, expression: pollExpr });

  // 3. Wait for the 3 s poll window to finish, then collect results.
  await new Promise((r) => setTimeout(r, 3500));
  const collect = await send('Runtime.evaluate', {
    returnByValue: true,
    expression:
      '(() => {' +
      '  const iframe = document.querySelector("iframe");' +
      '  const w = iframe.contentWindow;' +
      '  const s = w.__staleResults || [];' +
      '  const holderSeen = s.filter(e => e.h === 1);' +
      '  const svgEver = s.filter(e => e.svg === 1);' +
      '  return {' +
      '    total: s.length,' +
      '    holderSeenCount: holderSeen.length,' +
      '    htmlLen: (iframe.contentDocument.getElementById("preview").innerHTML || "").length,' +
      '    firstSample: s[0] || null,' +
      '    lastSample: s[s.length - 1] || null,' +
      '  };' +
      '})()',
  });
  ws.close();

  const result = collect.result.value;
  console.log('\n  samples collected:    ' + result.total);
  console.log('  stale-holder samples: ' + result.holderSeenCount);
  console.log('  range:                ' + (result.firstSample ? result.firstSample.t : '?') + 'ms – ' + (result.lastSample ? result.lastSample.t : '?') + 'ms');

  if (result.holderSeenCount > 0) {
    console.error('\nFAIL: .hmk-stale-holder appeared ' + result.holderSeenCount + ' time(s) during a mermaid refresh.');
    console.error('      The stale-diagram keeper should never fire for mermaid diagrams');
    console.error('      (their re-render is handled by the mermaid library + anchor guard).');
    console.error('      See: src/webview/stale.ts snapshotStaleBlocks() — .mermaid-wrapper exclusion.');
    process.exit(1);
  }

  console.log('\nPASS: no .hmk-stale-holder appeared during mermaid refresh.');
}

const port = parseInt(process.argv[2] || '9032', 10);
run(port).catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
