/**
 * Scans a markdown document for PlantUML `SALT(...)` activity invocations and
 * `!procedure` / `!endprocedure` definitions — the pure half of click-to-source
 * and cursor-highlight for procedure-rendered salt mockups.
 *
 * The salt-capable server only embeds `data-source-code` ranges for salt
 * blocks it can trace to a source line (note-on-link `{{salt ... }}` blocks).
 * Mockups rendered through `SALT(x)` (an `{{salt ... }}` activity label)
 * carry no range. Empirically (v1.2026.7beta11 jar, activity diagrams):
 * PlantUML renders **one mockup per distinct alias** — repeated invocations
 * of the same target (`sample_recording` twice, …) reuse the same activity
 * node, so the SVG contains exactly one image per distinct `SALT(x)` target,
 * in the order of first invocation. This module yields those first-invocation
 * lines (0-based, absolute document lines) and the procedure-body line ranges.
 *
 * Pure module (no `vscode` import) so the real shipped code is unit-testable
 * in plain Node (`tests/plantuml_check.cjs`).
 */

/** A `SALT(x)` invocation line, `SALT($x)` inside the macro definition excluded. */
const SALT_INVOCATION_REG = /\bSALT\s*\(([^)]*)\)/;

/** `!procedure <name>()` opening (name starts with `_` — e.g. `_form_empty`). */
const PROC_OPEN_REG = /^\s*!procedure\s+(_[a-zA-Z0-9_]+)\s*\(/i;

/** `!endprocedure` closing. */
const PROC_CLOSE_REG = /^\s*!endprocedure\b/i;

export interface ProcRange {
	/** The alias target (e.g. `form_empty` derived from `_form_empty`). */
	readonly alias: string;
	/** 0-based, inclusive start line of the procedure body (`!procedure` line itself). */
	readonly from: number;
	/** 0-based, inclusive end line of the procedure body (`!endprocedure` line itself). */
	readonly to: number;
}

export interface SaltScanResult {
	/**
	 * Fence opening line (0-based) -> first-occurrence invocation lines
	 * (0-based, absolute), in invocation order. Each line carries both the
	 * line number and the alias name.
	 */
	readonly invocations: Map<number, { line: number; alias: string }[]>;
	/**
	 * Fence opening line (0-based) -> procedure body ranges within that fence.
	 */
	readonly procRanges: Map<number, ProcRange[]>;
}

/**
 * Extracts the alias from a `!procedure _<name>()` identifier.
 * `_form_empty` → `form_empty`.
 */
function aliasFromProc(name: string): string {
	return name.startsWith('_') ? name.slice(1) : name;
}

/**
 * Scans `text` for PlantUML `SALT(x)` invocations and `!procedure … / !endprocedure`
 * blocks. Returns per-fence invocation lines and procedure body ranges.
 */
export function saltInvocationLines(text: string): SaltScanResult {
	const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
	const invocations = new Map<number, { line: number; alias: string }[]>();
	const procRanges = new Map<number, ProcRange[]>();
	let fence: { start: number; seen: Set<string> } | undefined;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const trimmed = raw.trim();

		if (fence) {
			if (/^(`{3,}|~{3,})\s*$/.test(trimmed)) {
				fence = undefined;
				continue;
			}
			if (trimmed.startsWith('!') || trimmed.startsWith("'")) {
				continue;
			}
			const match = SALT_INVOCATION_REG.exec(trimmed);
			if (match) {
				const target = match[1]!.trim();
				if (target && !fence.seen.has(target)) {
					fence.seen.add(target);
					invocations.get(fence.start)!.push({ line: i, alias: target });
				}
			}
			continue;
		}

		const open = /^(\s*)(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)(\s.*)?$/.exec(raw);
		if (open) {
			const lang = open[3]!.toLowerCase();
			if (lang === 'plantuml' || lang === 'puml' || lang === 'uml') {
				fence = { start: i, seen: new Set() };
				invocations.set(i, []);
				procRanges.set(i, []);
			}
		}
	}

	// Second pass: scan for !procedure/!endprocedure inside each fence's range.
	// We already have the open/close lines from the first pass.
	let procFence: number | undefined;
	let procName: string | undefined;
	let procFrom: number | undefined;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();

		if (procFence !== undefined) {
			// Check for fence end
			if (/^(`{3,}|~{3,})\s*$/.test(trimmed)) {
				if (procName && procFrom !== undefined) {
					procRanges.get(procFence)!.push({
						alias: aliasFromProc(procName),
						from: procFrom,
						to: i - 1,
					});
				}
				procFence = undefined;
				procName = undefined;
				procFrom = undefined;
				continue;
			}

			// Inside a procedure: check for closing
			if (procName) {
				if (trimmed.startsWith('!endprocedure')) {
					if (procFrom !== undefined) {
						procRanges.get(procFence)!.push({
							alias: aliasFromProc(procName),
							from: procFrom,
							to: i,
						});
					}
					procName = undefined;
					procFrom = undefined;
				}
				continue;
			}

			// Inside a fence, not yet in a procedure: look for !procedure opening
			const procOpen = PROC_OPEN_REG.exec(trimmed);
			if (procOpen) {
				procName = procOpen[1]!;
				procFrom = i;
			}
			continue;
		}

		// Look for opening fence
		const fenceMatch = /^(\s*)(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)(\s.*)?$/.exec(trimmed);
		if (fenceMatch) {
			const lang = fenceMatch[3]!.toLowerCase();
			if (lang === 'plantuml' || lang === 'puml' || lang === 'uml') {
				procFence = i;
			}
			continue;
		}

		// Outside a fence: nothing to do
	}

	// Handle unclosed fence at EOF
	if (procFence !== undefined && procName && procFrom !== undefined) {
		procRanges.get(procFence)!.push({
			alias: aliasFromProc(procName),
			from: procFrom,
			to: lines.length - 1,
		});
	}

	return { invocations, procRanges };
}