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
 * Prepares the dev host for testing the Hacker Markdown extension:
 *   1. dismisses the one-time "Welcome / Continue with GitHub" onboarding
 *      overlay if present (it eats all CDP input),
 *   2. toggles the panel so its container switcher materializes,
 *   3. clicks the "Hacker Markdown" panel tab,
 *   4. waits for the webview OOPIF target to appear in /json/list.
 */
async function main() {
  const port = process.argv[2];
  const page = (await getTargets(port)).find((t) => t.type === 'page');
  if (!page) { console.error('NO_PAGE_TARGET'); process.exit(2); }
  const session = await openCdpSession(page.webSocketDebuggerUrl);

  // 1) Dismiss the onboarding overlay (fresh profiles show it once).
  for (let i = 0; i < 20; i++) {
    const dismissed = await session.eval(`(() => {
      const b = document.querySelector('.onboarding-a-close-btn');
      if (b) { b.click(); return 'dismissed'; }
      return document.querySelector('.onboarding-a-signin') ? 'present' : 'none';
    })()`);
    if (dismissed === 'none') break;
    await sleep(500);
  }

  // 2) Toggle the panel until its container switcher shows our tab.
  //    Cmd+J on macOS, Ctrl+J everywhere else.
  const panelMod = process.platform === 'darwin' ? 4 : 2;
  for (let i = 0; i < 6; i++) {
    const tabs = await session.eval(`(() => [...document.querySelectorAll('.part.panel .composite-bar .action-item a')].map(a => a.getAttribute('aria-label')))()`);
    if (tabs.includes('Hacker Markdown')) break;
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'j', code: 'KeyJ', modifiers: panelMod });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', modifiers: panelMod });
    await sleep(1500);
  }

  // 3) Click the "Hacker Markdown" tab.
  let clicked = false;
  for (let i = 0; i < 6 && !clicked; i++) {
    const rect = await session.eval(`(() => {
      const a = [...document.querySelectorAll('.part.panel .composite-bar a')].find(x => x.getAttribute('aria-label') === 'Hacker Markdown');
      if (!a) return null;
      const b = a.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    })()`);
    if (rect) {
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      clicked = true;
    } else {
      await sleep(1500);
    }
  }
  if (!clicked) { console.error('HACKER_MARKDOWN_TAB_NOT_FOUND'); process.exit(2); }

  // 4) Wait for the preview webview OOPIF target. Cold starts (fresh
  // profile, built-ins activating) can take a while before the target shows.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const targets = await getTargets(port);
    const found = targets.find((t) => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview://'));
    if (found) {
      console.log('view open; webview target:', found.webSocketDebuggerUrl);
      session.close();
      process.exit(0);
    }
    await sleep(1000);
  }
  console.error('WEBVIEW_TARGET_TIMEOUT');
  process.exit(2);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
