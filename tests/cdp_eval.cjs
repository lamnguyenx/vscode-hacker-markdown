// CDP helper: attach to a target (by type+url prefix) and evaluate JS.
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

async function evalOnTarget(wsUrl, expression, opts = {}) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const result = { value: undefined, exception: undefined };
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
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: !!opts.awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    result.exception = (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500);
  } else {
    result.value = r.result.value;
  }
  ws.close();
  return result;
}

async function main() {
  const port = process.argv[2];
  const typeFilter = process.argv[3]; // e.g. 'iframe'
  const urlPrefix = process.argv[4] || '';
  const expr = process.argv[5];
  const targets = await getTargets(port);
  const target = targets.find(
    (t) => (!typeFilter || t.type === typeFilter) && (t.url || '').startsWith(urlPrefix)
  );
  if (!target) {
    console.error('TARGET_NOT_FOUND', JSON.stringify(targets.map((t) => ({ type: t.type, url: (t.url || '').slice(0, 80) }))));
    process.exit(2);
  }
  const r = await evalOnTarget(target.webSocketDebuggerUrl, expr);
  if (r.exception) {
    console.error('EXCEPTION:', r.exception);
    process.exit(3);
  }
  console.log(JSON.stringify(r.value, null, 1));
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
