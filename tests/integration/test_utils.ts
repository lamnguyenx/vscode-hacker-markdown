/**
 * Shared test utilities for integration tests.
 *
 * `createSuite()` returns a `check()` function and a `finish()` that prints the
 * summary and `process.exit`s with the right code — replaces the duplicated
 * boilerplate that was at the top of every test file.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Absolute path to this extension's checkout **as seen by the extension host**.
 *
 * The REST helpers run commands inside the extension host, so fixture paths
 * passed to `restOpenFile()` must be valid there — which is not necessarily the
 * same filesystem the test process runs on (code-server runs in a container; a
 * dev host may run natively on a different machine). Resolution order:
 *
 *   1. `HMK_EXT_ROOT` env override (for split runner/host setups where the host
 *      path cannot be probed from the runner);
 *   2. the canonical code-server mount `/home/lamnt45/git/vscode-hacker-markdown`
 *      if it exists locally (Option A);
 *   3. this repo, derived from the test file location — `tests/integration` →
 *      repo root (Option B dev host, or a plain checkout such as `_submodules/`).
 */
export const EXT_ROOT: string = (() => {
	const override = process.env.HMK_EXT_ROOT;
	if (override) return override;
	const canonical = '/home/lamnt45/git/vscode-hacker-markdown';
	if (existsSync(join(canonical, 'tests', 'samples'))) return canonical;
	return join(import.meta.dirname, '..', '..');
})();

/** Absolute `tests/samples` directory (extension-host view). */
export const SAMPLES: string = join(EXT_ROOT, 'tests', 'samples');

/** Absolute `tests/samples/workspace` directory (extension-host view). */
export const WORKSPACE: string = join(SAMPLES, 'workspace');

export interface CheckResult {
	name: string;
	ok: boolean;
	skip: boolean;
	extra: string;
}

export interface TestSuite {
	check: (name: string, ok: boolean, extra?: string, skip?: boolean) => void;
	results: CheckResult[];
	/**
	 * Print summary, run best-effort REST cleanup (revert + close every editor,
	 * delete temp fixtures — see {@link restCleanup}), then `process.exit(1)`
	 * if any non-skipped check failed. Await it from `main()`.
	 */
	finish: () => Promise<void>;
}

export function createSuite(): TestSuite {
	const results: CheckResult[] = [];
	const check = (name: string, ok: boolean, extra = '', skip = false): void => {
		results.push({ name, ok, skip, extra });
		const tag = skip ? 'SKIP' : ok ? 'PASS' : 'FAIL';
		console.log(`${tag}  ${name}${extra ? '  ' + extra : ''}`);
	};
	const finish = async (): Promise<void> => {
		const failed = results.filter((r) => !r.ok && !r.skip);
		const skipped = results.filter((r) => r.skip);
		const passedC = results.length - failed.length - skipped.length;
		console.log(`\n${passedC}/${results.length} checks passed${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
		try {
			const { restCleanup } = await import('./rest');
			await restCleanup();
		} catch (e) {
			console.warn(`WARN: cleanup failed: ${(e as Error).message}`);
		}
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
