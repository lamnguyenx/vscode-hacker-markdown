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

/**
 * Returns a map of alias → definition line (0-based, absolute) for every
 * `!procedure _<name>()` block in the puml fence that opens at
 * `fenceStartLine`. The alias is the underscore-stripped name
 * (`_form_empty` → `form_empty`). If an alias is defined twice in the
 * same fence, the first declaration wins.
 */
export function aliasDefinitions(text: string, fenceStartLine: number): Map<string, number> {
	const { procRanges } = saltInvocationLines(text);
	const ranges = procRanges.get(fenceStartLine);
	if (!ranges || !ranges.length) {
		return new Map();
	}
	const out = new Map<string, number>();
	for (const r of ranges) {
		if (!out.has(r.alias)) {
			out.set(r.alias, r.from);
		}
	}
	return out;
}

export interface AliasOccurrence {
	/** 0-based absolute document line. */
	readonly line: number;
	/** 0-based column of the alias word start (after `_` for definitions). */
	readonly startCol: number;
	/** 0-based column after the alias word end. */
	readonly endCol: number;
	/** `definition` if this is `!procedure _<alias>()`; `invocation` if `SALT(<alias>)`. */
	readonly kind: 'definition' | 'invocation';
}

export interface ProcFoldRange {
	/** 0-based, inclusive start line (`!procedure`). */
	readonly startLine: number;
	/** 0-based, inclusive end line (`!endprocedure`). */
	readonly endLine: number;
}

/**
 * Returns every semantically meaningful occurrence of `alias` inside the fence
 * spanning lines `[fenceStart, fenceEnd)` — the `!procedure _<alias>()`
 * definition line and every `SALT(<alias>)` invocation line.
 */
export function aliasOccurrences(text: string, fenceStart: number, fenceEnd: number | undefined, alias: string): AliasOccurrence[] {
	const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
	const out: AliasOccurrence[] = [];
	const end = fenceEnd ?? lines.length - 1;

	for (let i = fenceStart + 1; i < end; i++) {
		const lineText = lines[i]!;
		const trimmed = lineText.trim();

		// Definition line: !procedure _<alias>()
		const procMatch = /^\s*!procedure\s+_([a-zA-Z0-9_]+)\s*\(/.exec(trimmed);
		if (procMatch && procMatch[1] === alias) {
			const undIdx = lineText.indexOf(`_${alias}`);
			if (undIdx >= 0) {
				out.push({ line: i, startCol: undIdx, endCol: undIdx + 1 + alias.length, kind: 'definition' });
			}
			continue;
		}

		if (trimmed.startsWith("'") || trimmed.startsWith('!')) {
			continue;
		}

		// Invocation: SALT(<alias>)
		const saltStr = `SALT(${alias})`;
		let idx = lineText.indexOf(saltStr);
		while (idx >= 0) {
			const beforeOk = idx === 0 || !/\w/.test(lineText[idx - 1]!);
			if (beforeOk) {
				out.push({ line: i, startCol: idx + 5, endCol: idx + 5 + alias.length, kind: 'invocation' });
			}
			idx = lineText.indexOf(saltStr, idx + 1);
		}
	}
	return out;
}

/**
 * Finds every `SALT(<alias>)` invocation inside the fence spanning lines
 * `[fenceStart, fenceEnd)` — the `SALT(...)` calls that reference a procedure.
 * Unlike `saltInvocationLines` (which deduplicates by alias), this returns
 * **all** occurrences, including repeats of the same alias. Lines are 0-based,
 * absolute document lines.
 */
export function invocationReferences(text: string, fenceStart: number, fenceEnd: number | undefined, alias: string): number[] {
	return aliasOccurrences(text, fenceStart, fenceEnd, alias)
		.filter((o) => o.kind === 'invocation')
		.map((o) => o.line);
}

/**
 * Returns every `!procedure` … `!endprocedure` range inside puml fences in
 * `text`, as 0-based inclusive line pairs. Reuses the existing
 * `saltInvocationLines` scanner.
 */
export function procedureFoldRanges(text: string): ProcFoldRange[] {
	const { procRanges } = saltInvocationLines(text);
	const out: ProcFoldRange[] = [];
	for (const ranges of procRanges.values()) {
		for (const r of ranges) {
			out.push({ startLine: r.from, endLine: r.to });
		}
	}
	return out;
}

/**
 * Matches both `!procedure _name()` and `!unquoted procedure SALT()`
 * patterns. Captures the full procedure name including leading `_`.
 */
const PROC_NAME_REG = /^\s*!(?:unquoted\s+)?procedure\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i;

/**
 * Returns every procedure name defined in the puml fence that opens at
 * `fenceStartLine`, including both `_`-prefixed (e.g. `_form_empty`) and
 * bare (e.g. `SALT`) names. Names preserve their original casing.
 */
export function procedureNames(text: string, fenceStartLine: number): string[] {
	const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
	const names: string[] = [];
	let i = fenceStartLine + 1;
	while (i < lines.length) {
		const trimmed = lines[i]!.trim();
		if (/^(`{3,}|~{3,})\s*$/.test(trimmed)) {
			break;
		}
		const match = PROC_NAME_REG.exec(trimmed);
		if (match) {
			names.push(match[1]!);
		}
		i++;
	}
	return names;
}