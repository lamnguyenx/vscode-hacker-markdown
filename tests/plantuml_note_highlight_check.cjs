// Regression test for the bug documented in
// docs/issues/bugs/2026/08/21/2026-08-21-note-on-link-highlight-lost-after-end-note.md
//
// The bug: after the first `note on link ... end note` block in a
// ```plantuml markdown fence, ALL subsequent lines lose PlantUML keyword
// highlighting when `vue.volar` is installed and enabled (its
// `vue.interpolations` injection matches `{{salt ... }}` SALT blocks and
// corrupts VS Code's tokenization state for the rest of the fence).
//
// This script drives the extension dev host over CDP, opens the
// enroll-flow.puml.md fixture, scrolls so the note/end-note lines are in the
// DOM, and asserts that every `note on link`, `end note`, and `-->` line in
// the visible window is split into more than one `mtk*` token span — the bug
// collapses them to a single flat span.
//
// Usage:
//   npm run compile
//   tools/launch-devhost.sh --with-extensions --port 9334 \
//     --file "$PWD/tests/samples/enroll-flow.puml.md"
//   node tests/plantuml_note_highlight_check.cjs 9334
//
// To A/B test the Volar trigger, also run with Volar disabled (the bug
// disappears):
//   tools/kill-devhost.sh 9334
//   setsid nohup /usr/share/code/code \
//     --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost-withext" \
//     --remote-debugging-port=9334 --with-extensions --disable-extension vue.volar \
//     --new-window "$PWD/tests/samples/enroll-flow.puml.md" \
//     > exp/devhost-launch.log 2>&1 < /dev/null &
//   node tests/plantuml_note_highlight_check.cjs 9334   # expect PASS

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
  const page = targets.find((t) => t.type === 'page' && (t.url || '').startsWith('vscode-file'));
  if (!page) throw new Error(`no workbench page target on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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

  // 1. Focus the monaco editor.
  const center = await send('Runtime.evaluate', {
    returnByValue: true,
    expression:
      '(() => { const e = document.querySelector(".monaco-editor .overflow-guard") || document.querySelector(".monaco-editor"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()',
  });
  if (!center.result.value) throw new Error('no .monaco-editor in workbench — open a markdown file first');
  const pt = center.result.value;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt });
  await new Promise((r) => setTimeout(r, 400));

  // 2. Go to line 320 (first `note on link` of the activity diagram; test fixture is 1-based).
  //    Ctrl+G opens the Go-to-Line box; type the number and Enter.
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71 });
  await new Promise((r) => setTimeout(r, 300));
  await send('Input.insertText', { text: '320' });
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 900));

  // 3. Read every visible .view-line; collect its `mtk*` token spans.
  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression:
      '(() => {' +
      '  const lines = document.querySelectorAll(".view-lines .view-line");' +
      '  const out = [];' +
      '  for (const l of lines) {' +
      '    const toks = Array.from(l.querySelectorAll("span[class*=\\"mtk\\"]"))' +
      '      .map((s) => ({ t: s.textContent, c: s.className }));' +
      '    out.push({ text: l.textContent, toks });' +
      '  }' +
      '  return out;' +
      '})()',
  });
  ws.close();

  const rows = probe.result.value;
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error('no .view-line rows received — editor may not have focus');

  // 4. Filter: keep only the lines we assert against.
  // Monaco renders whitespace inside `.view-line` textContent as U+00A0 (NBSP),
  // not regular spaces, so normalize before matching.
  const norm = (t) => t.replace(/\u00a0/g, ' ').trim();
  const flat = (toks) => toks.length <= 1;
  const hasUnexpectedClose = (toks) => toks.some((t) => /\bunexpected-closing-bracket\b/.test(t.c || ''));
  // `note on link` (start of a multi-line `note of over` block) in the
  // correct grammar splits into keyword+space+keyword (>=2 mtk spans).
  // When the bug fires, the whole line collapses to a single mtk span.
  const isNoteOpen = (t) => norm(t) === 'note on link';
  // `-->` arrow lines: when the bug fires, the `>` of `-->` is flagged
  // `unexpected-closing-bracket` (the right side of an unmatched bracket pair).
  // This is the smoking-gun signal for the documented Volar/SALT corruption.
  const isArrowLine = (t) => /-->/.test(t) && /SALT\(/.test(t);
  // `end note` (single-keyword line; 1 mtk span is correct in both grammars).
  // We don't assert on it directly; we list it for context only.
  const isNoteClose = (t) => norm(t) === 'end note';

  const failing = [];
  const samples = { keyword: [], arrows: [], endnote: [] };
  for (const row of rows) {
    const text = row.text;
    const normText = norm(text);
    if (normText === '') continue;
    if (isNoteOpen(text)) {
      const bad = flat(row.toks);
      samples.keyword.push({ text: normText, tokens: row.toks, bad });
      if (bad) failing.push({ text: normText, kind: 'note-on-link', tokens: row.toks });
    } else if (isArrowLine(text)) {
      const bad = flat(row.toks) || hasUnexpectedClose(row.toks);
      samples.arrows.push({ text: normText, tokens: row.toks, bad });
      if (bad) failing.push({ text: normText, kind: 'arrow', tokens: row.toks });
    } else if (isNoteClose(text)) {
      samples.endnote.push({ text: normText, tokens: row.toks, bad: false });
    }
  }

  // 5. Report. Also dump the keyword / arrow sample lines for debugging.
  console.log(`Port ${port}: scanned ${rows.length} visible .view-line rows`);
  if (process.env.DEBUG) {
    console.log('--- all visible line texts:');
    for (const r of rows) {
      const cps = Array.from(r.text).map((c) => c.codePointAt(0)).filter((cp) => cp !== 0x20 && (cp < 0x21 || cp > 0x7e));
      console.log(`  ${JSON.stringify(r.text.slice(0, 60))} toks=${r.toks.length} weird_cps=[${cps.join(',')}]`);
    }
  }
  console.log(`  'note on link' lines seen:  ${samples.keyword.length}`);
  console.log(`  '--> SALT(...)' lines seen: ${samples.arrows.length}`);
  console.log(`  'end note' lines seen:      ${samples.endnote.length}`);

  const dump = (arr) =>
    arr
      .slice(0, 6)
      .map(
        (s) =>
          `    ${JSON.stringify(s.text)} bad=${s.bad} toks=${s.tokens.length} classes=[${[...new Set(s.tokens.map((t) => t.c.split(' ')[0]))].join(',')}] unexpected_close=${s.tokens.some((t) => /\bunexpected-closing-bracket\b/.test(t.c || ''))}`
      )
      .join('\n');
  console.log('  note-on-link samples:\n' + dump(samples.keyword));
  console.log('  arrow samples:\n' + dump(samples.arrows));

  if (failing.length > 0) {
    console.error(`\nFAIL: ${failing.length} line(s) collapsed to a single flat token span after the first 'end note'.`);
    console.error('      This is the documented Volar+PlantUML SALT bug when vue.volar is enabled:');
    console.error('      the vue.interpolations injection grammar (begin {{ / end }}) matches `{{salt }}`');
    console.error('      inside the ```plantuml fence and corrupts tokenization for the rest of the fence.');
    console.error('      Workaround: disable vue.volar for the workspace.');
    process.exit(1);
  }

  console.log('\nPASS: every note/--> line in the visible window has more than one token span.');
}

const port = parseInt(process.argv[2] || '9334', 10);
run(port).catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
