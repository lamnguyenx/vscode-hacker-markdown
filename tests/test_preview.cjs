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
  const primary = process.platform === 'darwin' ? 'Meta' : 'Control';
  const primaryCode = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
  const primaryMod = process.platform === 'darwin' ? 4 : 2;
  const comboMod = primaryMod | 8;
  const metaDown = async () => {
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: primary, code: primaryCode, modifiers: primaryMod });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: comboMod });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', modifiers: comboMod });
  };
  const metaUp = async () => {
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', modifiers: comboMod });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: comboMod });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: primary, code: primaryCode, modifiers: primaryMod });
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

  // 1) Initial render: test.md is the active editor on launch. Cold starts
  // (fresh profile, many extensions activating) can take a while before the
  // first fragment lands, so poll generously.
  const docName = await evalUntil(first.session, `d.querySelector('.toolbar .doc-name').textContent`, 60000);
  check('initial render: doc-name follows active editor', docName === 'test.md', `name=${docName}`);

  await evalUntil(first.session, `!!d.querySelector('#preview h1')`, 60000);
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

  // 6e) Cursor sync: the blue highlight (.hmk-cursor) follows the editor
  // cursor. Drive the editor with trusted input: Ctrl+G (Go to Line) + the
  // 1-based line number, then assert the highlighted preview element.
  //   7 (0-based 6) -> exact match: the "### Level three heading" h3;
  //   2 (0-based 1) -> blank line fallback: the h1 above it;
  //   13 (0-based 12) -> inside the python fence: the pre[data-line=10].
  const pageCursor = await openCdpSession((targets.find((t) => t.type === 'page')).webSocketDebuggerUrl);
  const clickEditor = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const rect = await pageCursor.eval(`(() => { const e = document.querySelector('.monaco-editor'); if (!e) return null; const r = e.getBoundingClientRect(); if (r.width < 20 || r.height < 10) return null; return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
      if (rect) {
        await pageCursor.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await pageCursor.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await sleep(300);
        return true;
      }
      await sleep(1000);
    }
    return false;
  };
  const gotoLine = async (line) => {
    await pageCursor.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 });
    await pageCursor.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'g', code: 'KeyG', modifiers: 2 });
    await pageCursor.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g', code: 'KeyG', modifiers: 2 });
    await pageCursor.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 2 });
    await sleep(500);
    await pageCursor.send('Input.insertText', { text: String(line) });
    await sleep(300);
    await pageCursor.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
    await pageCursor.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
    await sleep(600);
  };
  if (await clickEditor()) {
    await gotoLine(7);
    const tExact = await evalUntil(first.session, `(() => { const el = d.querySelector('#preview .hmk-cursor'); return el && el.tagName === 'H3' && el.getAttribute('data-line') === '6' ? 'h3' : null; })()`, 8000);
    check('cursor sync: exact line highlighted', tExact === 'h3', tExact || 'no exact highlight');

    await gotoLine(2);
    const tFallback = await evalUntil(first.session, `(() => { const el = d.querySelector('#preview .hmk-cursor'); return el && el.tagName === 'H1' ? 'h1' : null; })()`, 8000);
    check('cursor sync: containing-block fallback (paragraph/blank line)', tFallback === 'h1', tFallback || 'no fallback');

    await gotoLine(13);
    const tFence = await evalUntil(first.session, `(() => { const el = d.querySelector('#preview .hmk-cursor'); if (!el || el.tagName !== 'PRE') return null; const code = el.querySelector('code'); return code && code.getAttribute('data-line') === '10' ? 'pre' : null; })()`, 8000);
    check('cursor sync: inside a code fence highlights the fence', tFence === 'pre', tFence || 'no fence fallback');

    // 7f) Click-to-source: clicking a rendered block in the preview moves the
    // editor cursor there. Drive with trusted CDP clicks (a synthetic
    // .click() would skip the coordinate resolution in sourceLineForClick).
    // The editor cursor is on the python fence (line 13) — clicking the
    // h3[data-line="6"] should move it there, and the echo cursor-sync brings
    // the box back to the h3 (the end-to-end proof of the whole chain: click
    // -> editorLine message -> editor selection -> echo highlight).
    await run(`(() => { const h = d.querySelector('#preview h3[data-line="6"]'); if (!h) return false; h.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(400);
    const h3Rect = await run(`(() => { const h = d.querySelector('#preview h3[data-line="6"]'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (h3Rect) {
      await first.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h3Rect.x, y: h3Rect.y, button: 'left', clickCount: 1 });
      await first.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h3Rect.x, y: h3Rect.y, button: 'left', clickCount: 1 });
      const tClick = await evalUntil(first.session, `(() => { const el = d.querySelector('#preview .hmk-cursor'); return el && el.tagName === 'H3' && el.getAttribute('data-line') === '6' ? 'h3' : null; })()`, 8000);
      check('click-to-source: preview click moves the editor cursor (echo highlight)', tClick === 'h3', tClick || 'no highlight move');

      // 7g) Click-to-source on a rendered mermaid diagram: the host attaches
      // data-hmk-from/to to the .mermaid block (the plugin drops the engine's
      // data-line), so clicking the visible diagram jumps to the fence. The
      // editor cursor is on the h3 (line 6) here; clicking the diagram should
      // move it to the mermaid fence (line 57).
      await run(`(() => { const w = d.querySelector('#preview .mermaid-wrapper'); if (!w) return false; w.scrollIntoView({ block: 'center' }); return true; })()`);
      await sleep(400);
      const mermaidRect = await run(`(() => { const w = d.querySelector('#preview .mermaid-wrapper'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (mermaidRect) {
        await first.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mermaidRect.x, y: mermaidRect.y, button: 'left', clickCount: 1 });
        await first.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mermaidRect.x, y: mermaidRect.y, button: 'left', clickCount: 1 });
        const tMermaid = await evalUntil(first.session, `(() => { const el = d.querySelector('#preview .hmk-cursor'); if (!el) return null; const m = el.closest('.mermaid-wrapper'); return m && m.querySelector('[data-hmk-from="57"]') ? 'mermaid' : null; })()`, 8000);
        check('click-to-source: mermaid diagram click jumps to the fence', tMermaid === 'mermaid', tMermaid || 'no mermaid highlight');
      } else {
        check('click-to-source: mermaid diagram click jumps to the fence', false, 'mermaid-wrapper not found');
      }
    } else {
      check('click-to-source: preview click moves the editor cursor (echo highlight)', false, 'h3 not found');
    }
  } else {
    check('cursor sync: exact line highlighted', false, 'editor not focusable');
    check('cursor sync: containing-block fallback (paragraph/blank line)', false, 'editor not focusable');
    check('cursor sync: inside a code fence highlights the fence', false, 'editor not focusable');
    check('click-to-source: preview click moves the editor cursor (echo highlight)', false, 'editor not focusable');
    check('click-to-source: mermaid diagram click jumps to the fence', false, 'editor not focusable');
  }
  pageCursor.close();

  // 2) Follow active editor via link click: ./sub.md opens in the editor.
  await run(`(() => { const a = [...d.querySelectorAll('#preview a')].find(x => x.getAttribute('data-href') === './sub.md'); a.scrollIntoView({block:'center'}); return true; })()`);
  await sleep(400);
  const linkRect = await run(`(() => { const a = [...d.querySelectorAll('#preview a')].find(x => x.getAttribute('data-href') === './sub.md'); const r = a.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
  await first.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: linkRect.x, y: linkRect.y, button: 'left', clickCount: 1 });
  await first.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: linkRect.x, y: linkRect.y, button: 'left', clickCount: 1 });
  await sleep(1200);
  const name2 = await evalUntil(first.session, `d.querySelector('.toolbar .doc-name').textContent`);
  check('link click opens sub.md and preview follows', name2 === 'sub.md', `name=${name2}`);
  const subH1 = await evalUntil(first.session, `(() => { const h = d.querySelector('#preview h1'); return h ? h.textContent : null; })()`, 30000);
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
    const saved = await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: process.platform === 'darwin' ? 'Meta' : 'Control', code: process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft', modifiers: process.platform === 'darwin' ? 4 : 2 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', modifiers: process.platform === 'darwin' ? 4 : 2 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: process.platform === 'darwin' ? 4 : 2 });
    await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: process.platform === 'darwin' ? 'Meta' : 'Control', code: process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft', modifiers: process.platform === 'darwin' ? 4 : 2 });
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
    // Opening the panel makes the WebviewPanel the active tab and
    // `activeTextEditor` undefined, which empties every host (the documented
    // panel race). Click back to a markdown tab first so the shared document
    // state re-broadcasts to the new panel, then assert.
    const tabPage = await openCdpSession((targets.find((t) => t.type === 'page')).webSocketDebuggerUrl);
    const subTabRect = await tabPage.eval(`(() => { const t = [...document.querySelectorAll('.tab')].find(e => (e.textContent || '').trim().startsWith('sub.md')); if (!t) return null; const b = t.getBoundingClientRect(); return {x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2)}; })()`);
    if (subTabRect) {
      await tabPage.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: subTabRect.x, y: subTabRect.y, button: 'left', clickCount: 1 });
      await tabPage.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: subTabRect.x, y: subTabRect.y, button: 'left', clickCount: 1 });
      await sleep(1000);
    }
    tabPage.close();
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
