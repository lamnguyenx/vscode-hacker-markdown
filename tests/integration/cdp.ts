/**
 * Shared CDP helpers for integration tests.
 *
 * **Dual topology.** Under a VS Code dev host (Option B), each webview is an
 * out-of-process iframe (OOPIF) that appears as a separate CDP target of type
 * `iframe` with a `vscode-webview://` URL — you attach a dedicated CDP session
 * to it and evaluate directly. Under code-server (Option A) there are **no**
 * OOPIF targets: the preview is nested in same-origin iframes *inside the
 * workbench page*, so everything goes through the page target's single CDP
 * session, diving through two iframe levels.
 *
 *   dev host:     page → OOPIF (vscode-webview://)   → preview document
 *   code-server:  page → ext frame (extensionId=…)    → inner iframe → preview document
 *
 * `connectPreview()` detects which topology is active and returns a
 * {@link PreviewHandle} whose `pEval` / `pClick` work identically in both:
 *   - `pEval(expr)` evaluates `expr` with `d` = the preview document.
 *   - `pClick(x, y)` dispatches a full press+release at preview-space coords
 *     (code-server adds the accumulated iframe offset automatically).
 *   - `page` exposes the workbench page session for keyboard input (Ctrl+G,
 *     palette, tab clicks, …).
 */
import * as http from 'node:http';

export interface CdpTarget {
	type: string;
	url?: string;
	webSocketDebuggerUrl: string;
}

export interface CdpSession {
	send: (method: string, params?: Record<string, unknown>) => Promise<any>;
	eval: (expression: string) => Promise<any>;
	close: () => void;
}

export function getTargets(port: string | number): Promise<CdpTarget[]> {
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
			let data = '';
			res.on('data', (c) => (data += c));
			res.on('end', () => resolve(JSON.parse(data) as CdpTarget[]));
		}).on('error', reject);
	});
}

export async function openCdpSession(wsUrl: string): Promise<CdpSession> {
	const ws = new WebSocket(wsUrl);
	let id = 0;
	const pending = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
	const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
		new Promise((resolve, reject) => {
			const msgId = ++id;
			pending.set(msgId, { resolve, reject });
			ws.send(JSON.stringify({ id: msgId, method, params }));
		});
	ws.onmessage = (ev) => {
		const msg = JSON.parse(String(ev.data));
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id)!;
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		}
	};
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	await send('Runtime.enable');
	return {
		send,
		eval: async (expression: string) => {
			const r = await send('Runtime.evaluate', { expression, returnByValue: true });
			if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 600));
			return r.result.value;
		},
		close: () => ws.close(),
	};
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Preview connection
// ---------------------------------------------------------------------------

export const EXT_FRAME_SEL = 'iframe[src*="extensionId=lamnguyenx.hacker-markdown"]';

export interface PreviewHandle {
	/** Workbench page session — for keyboard input, palette, editor, tabs. */
	readonly page: CdpSession;
	/** Evaluate `expr` inside the preview document. `d` = preview document. */
	readonly pEval: (expr: string) => Promise<any>;
	/** Full click (press + release) at preview-space coordinates. */
	readonly pClick: (x: number, y: number) => Promise<void>;
	/** Preview origin offset in page viewport (0,0 for dev host OOPIF). */
	readonly offset: { x: number; y: number };
	/** Close all underlying sessions. */
	readonly close: () => void;
}

/**
 * Finds the Hacker Markdown preview and returns a topology-agnostic handle.
 * Returns `null` if no preview is found (the webview is not open).
 */
export async function connectPreview(port: string | number): Promise<PreviewHandle | null> {
	const targets = await getTargets(port);
	const page = targets.find((t) => t.type === 'page');
	if (!page) return null;
	const pageSession = await openCdpSession(page.webSocketDebuggerUrl);

	// --- OOPIF topology (dev host) -----------------------------------------
	const oopifs = targets.filter((t) => t.type === 'iframe' && (t.url || '').startsWith('vscode-webview://'));
	for (const o of oopifs) {
		const ws = await openCdpSession(o.webSocketDebuggerUrl);
		const probe = await ws.eval(`(() => { const d = document.querySelector('iframe')?.contentDocument; return !!(d && d.querySelector('.toolbar .doc-name')); })()`);
		if (probe) {
			return makeOopifHandle(pageSession, ws);
		}
		ws.close();
	}

	// --- code-server topology (nested same-origin iframes) ------------------
	const offset = await pageSession.eval(`(() => {
		const ext = document.querySelector('${EXT_FRAME_SEL}');
		if (!ext || !ext.contentDocument) return null;
		const inner = ext.contentDocument.querySelector('iframe');
		if (!inner || !inner.contentDocument) return null;
		if (!inner.contentDocument.querySelector('.toolbar .doc-name')) return null;
		const extRect = ext.getBoundingClientRect();
		const innerRect = inner.getBoundingClientRect();
		return { x: Math.round(extRect.left + innerRect.left), y: Math.round(extRect.top + innerRect.top) };
	})()`);
	if (!offset) {
		pageSession.close();
		return null;
	}
	return makeCodeServerHandle(pageSession, offset);
}

function makeOopifHandle(page: CdpSession, ws: CdpSession): PreviewHandle {
	return {
		page,
		pEval: (expr) => ws.eval(`(() => { const d = document.querySelector('iframe').contentDocument; return (${expr}); })()`),
		pClick: async (x, y) => {
			await ws.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
			await ws.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
		},
		offset: { x: 0, y: 0 },
		close: () => { ws.close(); page.close(); },
	};
}

function makeCodeServerHandle(page: CdpSession, _offset: { x: number; y: number }): PreviewHandle {
	return {
		page,
		pEval: (expr) => page.eval(`(() => { const ext = document.querySelector('${EXT_FRAME_SEL}'); const d = ext.contentDocument.querySelector('iframe').contentDocument; return (${expr}); })()`),
		pClick: async (x, y) => {
			const curOffset = await page.eval(`(() => {
				const ext = document.querySelector('${EXT_FRAME_SEL}');
				const extRect = ext.getBoundingClientRect();
				const inner = ext.contentDocument.querySelector('iframe');
				const innerRect = inner.getBoundingClientRect();
				return { x: Math.round(extRect.left + innerRect.left), y: Math.round(extRect.top + innerRect.top) };
			})()`);
			await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x + curOffset.x, y: y + curOffset.y, button: 'left', clickCount: 1 });
			await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + curOffset.x, y: y + curOffset.y, button: 'left', clickCount: 1 });
		},
		offset: _offset,
		close: () => { page.close(); },
	};
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/** Poll `pEval(expr)` until truthy or `timeoutMs` elapses. */
export async function evalUntil(handle: PreviewHandle, expr: string, timeoutMs = 15000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any;
	while (Date.now() < deadline) {
		last = await handle.pEval(expr);
		if (last) return last;
		await sleep(300);
	}
	return last;
}

/**
 * Runs a command through the workbench command palette: opens it with
 * trusted CDP key input (`F1` — works in both dev host and code-server,
 * unlike `Ctrl+Shift+P` which the browser intercepts), types `text`, then
 * clicks the exact matching row.
 */
export async function runPaletteCommand(pageSession: CdpSession, text: string): Promise<void> {
	// Open command palette via F1 (works in Electron and browser, no
	// browser default keybinding conflict).
	await pageSession.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F1', code: 'F1', modifiers: 0 });
	await pageSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F1', code: 'F1', modifiers: 0 });
	await sleep(800);
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
