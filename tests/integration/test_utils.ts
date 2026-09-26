/**
 * Shared test utilities for integration tests.
 *
 * `createSuite()` returns a `check()` function and a `finish()` that prints the
 * summary and `process.exit`s with the right code — replaces the duplicated
 * boilerplate that was at the top of every test file.
 */

export interface CheckResult {
	name: string;
	ok: boolean;
	skip: boolean;
	extra: string;
}

export interface TestSuite {
	check: (name: string, ok: boolean, extra?: string, skip?: boolean) => void;
	results: CheckResult[];
	/** Print summary, `process.exit(1)` if any non-skipped check failed. */
	finish: () => void;
}

export function createSuite(): TestSuite {
	const results: CheckResult[] = [];
	const check = (name: string, ok: boolean, extra = '', skip = false): void => {
		results.push({ name, ok, skip, extra });
		const tag = skip ? 'SKIP' : ok ? 'PASS' : 'FAIL';
		console.log(`${tag}  ${name}${extra ? '  ' + extra : ''}`);
	};
	const finish = (): void => {
		const failed = results.filter((r) => !r.ok && !r.skip);
		const skipped = results.filter((r) => r.skip);
		const passedC = results.length - failed.length - skipped.length;
		console.log(`\n${passedC}/${results.length} checks passed${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
		process.exit(failed.length ? 1 : 0);
	};
	return { check, results, finish };
}

/**
 * Connect to the preview AND ensure the REST control endpoint is reachable.
 * If REST is not available, logs a warning (tests can still run using CDP
 * keyboard automation, but save/palette/etc. checks may be limited).
 */
export async function ensureRestAvailable(): Promise<boolean> {
	const { isRestAvailable } = await import('./rest');
	const ok = await isRestAvailable();
	if (!ok) {
		console.warn('WARN: vscode-hacker-rest-control not reachable — falling back to CDP-only mode');
	}
	return ok;
}
