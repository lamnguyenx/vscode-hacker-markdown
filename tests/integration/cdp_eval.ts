// CDP helper: attach to a target (by type+url prefix) and evaluate JS.
//
// Usage: bun tests/integration/cdp_eval.ts [port] [typeFilter] [urlPrefix] [expression]
import { getTargets, openCdpSession } from './cdp';

async function main(): Promise<void> {
	const port = process.env.CDP_PORT || process.argv[2] || '9024';
	const typeFilter = process.argv[3]; // e.g. 'iframe'
	const urlPrefix = process.argv[4] || '';
	const expr = process.argv[5] ?? '';
	const targets = await getTargets(port);
	const target = targets.find(
		(t) => (!typeFilter || t.type === typeFilter) && (t.url || '').startsWith(urlPrefix)
	);
	if (!target) {
		console.error('TARGET_NOT_FOUND', JSON.stringify(targets.map((t) => ({ type: t.type, url: (t.url || '').slice(0, 80) }))));
		process.exit(2);
	}
	const session = await openCdpSession(target.webSocketDebuggerUrl);
	const result = { value: undefined as unknown, exception: undefined as string | undefined };
	try {
		const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true });
		result.value = r.result.value;
	} catch (e: any) {
		result.exception = String(e.message ?? e).slice(0, 500);
	}
	session.close();
	if (result.exception) {
		console.error('EXCEPTION:', result.exception);
		process.exit(3);
	}
	console.log(JSON.stringify(result.value, null, 1));
}

main().catch((e: Error) => {
	console.error('ERR', e.message);
	process.exit(1);
});