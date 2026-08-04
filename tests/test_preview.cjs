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

async function openCdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send('Runtime.enable');
  return {
    send,
    eval: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 600));
      return r.result.value;
    },
    close: () => ws.close()
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a command through the workbench command palette: opens it with
 * trusted CDP key input, types `text`, then clicks the *exact* matching row
 * (fuzzy matching can rank a different item first, e.g.
 * "File: Compare New Untitled Text Files" before "File: New Untitled Text
 * File"). A real CDP mouse click on the row is deterministic.
 */
async function runPaletteCommand(pageSession, text) {
  const metaDown = async () => {
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 12 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', modifiers: 12 });
  };
  const metaUp = async () => {
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', modifiers: 12 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 12 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
  };
  await metaDown();
  await sleep(800);
  await metaUp();
  await pageSession.send('Input.insertText', { text });
  await sleep(600);
  const rect = await pageSession.eval(`(() => {
    const rows = [...document.querySelectorAll('.quick-input-list .monaco-list-row')];
    const row = rows.find(r => r.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  if (!rect) {
    throw new Error(`palette row not found for: ${text}`);
  }
  await pageSession.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await pageSession.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(400);
}

async function main() {
  const port = process.argv[2];
  const targets = await getTargets(port);

  // The webview OOPIFs: vscode-webview:// targets whose child frame has our UI.
  const candidates = targets.filter((t) => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview://'));
  if (candidates.length === 0) { console.error('NO_WEBVIEW_TARGET'); process.exit(2); }

  const webviews = [];
  for (const c of candidates) {
    const session = await openCdpSession(c.webSocketDebuggerUrl);
    const probe = await session.eval(`(() => { const d = document.querySelector('iframe'); const c = d && d.contentDocument; return !!(c && c.querySelector('.toolbar .doc-name')); })()`);
    if (probe) { webviews.push({ target: c, session }); }
  }
  if (webviews.length === 0) { console.error('NO_PREVIEW_WEBVIEW_TARGET (open the Hacker Markdown view first)'); process.exit(2); }
  console.log(`found ${webviews.length} preview webview(s)`);

  const ui = (session) => (expr) => session.eval(`(() => { const d = document.querySelector('iframe').contentDocument; return (${expr}); })()`);

  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  };

  const first = webviews[0];
  const run = ui(first.session);
  const evalUntil = async (session, expr, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await ui(session)(expr);
      if (last) return last;
      await sleep(300);
    }
    return last;
  };

  // 1) Initial render: test.md is the active editor on launch.
  const docName = await evalUntil(first.session, `d.querySelector('.toolbar .doc-name').textContent`);
  check('initial render: doc-name follows active editor', docName === 'test.md', `name=${docName}`);

  const state = await run(`({
    hasH1: !!d.querySelector('#preview h1'),
    hasH2: !!d.querySelector('#preview h2'),
    hasCode: !!d.querySelector('#preview pre code span.hljs-keyword'),
    hasTable: !!d.querySelector('#preview table'),
    emptyHidden: d.querySelector('#empty').hidden,
    previewVisible: !d.querySelector('#preview').hidden,
    hasDataLine: d.querySelectorAll('#preview [data-line]').length > 0
  })`);
  check('renders headings', state.hasH1 && state.hasH2);
  check('renders highlighted code block', state.hasCode);
  check('renders table', state.hasTable);
  check('empty state hidden, preview visible', state.emptyHidden && state.previewVisible);
  check('source-line markers (data-line) present', state.hasDataLine);

  // 6b) Mermaid diagram rendered by the contributed preview script.
  const mermaidSvg = await evalUntil(first.session, `(() => { const s = d.querySelector('#preview .mermaid svg'); return !!s && s.children.length > 0; })()`, 20000);
  check('mermaid diagram rendered', mermaidSvg === true);

  // 6c) Generic pan/zoom frame: block-level images get framed, mermaid does
  // not (it self-frames via the contributed extension).
  const frameInfo = await evalUntil(first.session, `(() => {
    const f = d.querySelector('#preview .hmk-frame .hmk-frame-content img');
    if (!f) return null;
    const w = d.querySelector('#preview .mermaid-wrapper');
    return { framed: true, notDouble: !!w && d.querySelectorAll('#preview .mermaid-wrapper .hmk-frame').length === 0 };
  })()`);
  check('frame: image wrapped in pan/zoom frame', frameInfo?.framed === true, frameInfo ? '' : 'no frame');
  check('frame: mermaid not double-framed', frameInfo?.notDouble === true);

  // 6d) Frame interactions: zoom-in button, Alt+drag pan, reset. Synthetic
  // events are fine here (they drive our own webview handlers, not VS Code).
  const frameIx = await run(`(() => {
    const frame = d.querySelector('#preview .hmk-frame');
    const content = frame.querySelector('.hmk-frame-content');
    frame.querySelector('.hmk-zoom-in-btn').click();
    const afterZoom = content.style.transform;
    const r = frame.getBoundingClientRect();
    frame.dispatchEvent(new MouseEvent('mousedown', { button: 0, altKey: true, bubbles: true, clientX: r.left + 40, clientY: r.top + 40 }));
    d.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: r.left + 80, clientY: r.top + 60 }));
    d.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    const afterPan = content.style.transform;
    const parse = (t) => {
      const m = t.match(/translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\) scale\\((\\d+(?:\\.\\d+)?)\\)/);
      return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : null;
    };
    const z = parse(afterZoom);
    const p = parse(afterPan);
    frame.querySelector('.hmk-zoom-reset-btn').click();
    return {
      zoomed: !!z && Math.abs(z[2] - 1.25) < 0.001,
      panned: !!z && !!p && Math.abs(p[0] - (z[0] + 40)) < 0.5 && Math.abs(p[1] - (z[1] + 20)) < 0.5,
      reset: content.style.transform === 'translate(0px, 0px) scale(1)'
    };
  })()`);
  check('frame: zoom-in / alt-drag pan / reset work', frameIx.zoomed && frameIx.panned && frameIx.reset);

  // 2) Follow active editor via link click: ./sub.md opens in the editor.
  await run(`(() => { const a = [...d.querySelectorAll('#preview a')].find(x => x.getAttribute('data-href') === './sub.md'); a.scrollIntoView({block:'center'}); return true; })()`);
  await sleep(400);
  const linkRect = await run(`(() => { const a = [...d.querySelectorAll('#preview a')].find(x => x.getAttribute('data-href') === './sub.md'); const r = a.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
  await first.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: linkRect.x, y: linkRect.y, button: 'left', clickCount: 1 });
  await first.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: linkRect.x, y: linkRect.y, button: 'left', clickCount: 1 });
  await sleep(1200);
  const name2 = await evalUntil(first.session, `d.querySelector('.toolbar .doc-name').textContent`);
  check('link click opens sub.md and preview follows', name2 === 'sub.md', `name=${name2}`);
  const subH1 = await run(`d.querySelector('#preview h1').textContent`);
  check('sub.md content rendered', subH1 === 'Sub', `h1=${subH1}`);

  // 3) Live update: after the link click, showTextDocument has focused the
  // sub.md editor, so trusted CDP input lands there directly. The extension
  // renders on save by default (hackerMarkdown.renderOnSave), so the edit
  // must be saved (Cmd+S) for the preview to re-render. A timestamp token
  // keeps the check meaningful even when re-run against a dirty fixture.
  const page = targets.find((t) => t.type === 'page');
  if (page) {
    const pageSession = await openCdpSession(page.webSocketDebuggerUrl);
    await sleep(800);
    const token = `Typed live. ${Date.now()}`;
    await pageSession.send('Input.insertText', { text: `\n\n${token}` });
    await sleep(400);
    const saved = await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', modifiers: 4 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 4 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
    const live = await evalUntil(first.session, `d.querySelector('#preview').textContent.includes(${JSON.stringify(token)})`, 10000);
    check('re-render after save shows typed text', live === true);
    const mermaidSub = await evalUntil(first.session, `(() => { const s = d.querySelector('#preview .mermaid svg'); return !!s && s.children.length > 0; })()`, 20000);
    check('mermaid re-renders after saved edit', mermaidSub === true);
    pageSession.close();
  } else {
    check('re-render after save shows typed text', false, 'no page target');
    check('mermaid re-renders after saved edit', false, 'no page target');
  }

  // 4) Preview -> editor scroll sync (exercise the path; no DOM assert).
  await run(`(() => { d.scrollingElement.scrollTop = 400; d.scrollingElement.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(600);

  // 5) Open a second preview in the Editor area via the command palette.
  const page2 = await openCdpSession((targets.find((t) => t.type === 'page')).webSocketDebuggerUrl);
  await runPaletteCommand(page2, 'Hacker Markdown: Open Preview in Editor');
  await sleep(2000);

  // Find the second preview webview (editor panel).
  const targets2 = await getTargets(port);
  const panelCandidates = targets2.filter((t) => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview://'));
  let panelSession = null;
  for (const c of panelCandidates) {
    const s = await openCdpSession(c.webSocketDebuggerUrl);
    const probe = await s.eval(`(() => { const d = document.querySelector('iframe'); const c = d && d.contentDocument; return !!(c && c.querySelector('.toolbar .doc-name')); })()`);
    if (probe && c.webSocketDebuggerUrl !== first.target.webSocketDebuggerUrl) { panelSession = s; break; }
    s.close();
  }
  check('open in editor creates a second preview webview', !!panelSession);
  if (panelSession) {
    const pname = await evalUntil(panelSession, `d.querySelector('.toolbar .doc-name').textContent`, 8000);
    check('editor panel follows the same document', pname === 'sub.md', `name=${pname}`);
    const ptype = await ui(panelSession)(`d.querySelector('.toolbar [data-command="openInEditor"]') === null`);
    check('editor panel hides Open-in-Editor button', ptype === true);
    panelSession.close();
  }
  page2.close();

  // 6) Empty state when a non-markdown file is active. The untitled file
  // opens in a NEW editor group, so click its tab to make it the active
  // editor (the preview follows the active editor).
  const page3 = await openCdpSession((targets.find((t) => t.type === 'page')).webSocketDebuggerUrl);
  await runPaletteCommand(page3, 'File: New Untitled Text File');
  await sleep(1000);
  const untitledRect = await page3.eval(`(() => { const t = [...document.querySelectorAll('.tab')].find(e => (e.textContent || '').trim().startsWith('Untitled')); if (!t) return null; const b = t.getBoundingClientRect(); return {x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2)}; })()`);
  if (untitledRect) {
    await page3.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: untitledRect.x, y: untitledRect.y, button: 'left', clickCount: 1 });
    await page3.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: untitledRect.x, y: untitledRect.y, button: 'left', clickCount: 1 });
  }
  await sleep(1200);
  const emptyState = await evalUntil(first.session, `d.querySelector('#empty').hidden === false && d.querySelector('#preview').hidden === true`);
  check('empty state for non-markdown active editor', emptyState === true);
  page3.close();

  for (const w of webviews) w.session.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
