/**
 * Scans a markdown document for PlantUML `SALT(...)` activity invocations —
 * the pure half of click-to-source / cursor-highlight for procedure-rendered
 * salt mockups.
 *
 * The salt-capable server only embeds `data-source-code` ranges for salt
 * blocks it can trace to a source line (note-on-link `{{salt ... }}` blocks).
 * Mockups rendered through `SALT(x)` (an `{{salt ... }}` activity label)
 * carry no range. Empirically (v1.2026.7beta11 jar, activity diagrams):
 * PlantUML renders **one mockup per distinct alias** — repeated invocations
 * of the same target (`sample_recording` twice, …) reuse the same activity
 * node, so the SVG contains exactly one image per distinct `SALT(x)` target,
 * in the order of first invocation. This module yields those first-invocation
 * lines (0-based, absolute document lines), which the host embeds on the
 * inlined `<svg>` root (`data-hmk-salts`) and the webview zips onto the
 * rangeless mockup groups in SVG order (mirroring the mermaid span zip).
 *
 * Pure module (no `vscode` import) so the real shipped code is unit-testable
 * in plain Node (`tests/plantuml_check.cjs`).
 */

/** A `SALT(x)` invocation line, `SALT($x)` inside the macro definition excluded. */
const SALT_INVOCATION_REG = /\bSALT\s*\(([^)]*)\)/;

/**
 * Returns a map of fence opening line (0-based) -> the first-occurrence lines
 * (0-based, absolute) of every distinct `SALT(x)` invocation inside that
 * fence, in invocation order.
 */
export function saltInvocationLines(text: string): Map<number, number[]> {
	const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
	const out = new Map<number, number[]>();
	let fence: { start: number; seen: Set<string> } | undefined;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const trimmed = raw.trim();

		if (fence) {
			if (/^(`{3,}|~{3,})\s*$/.test(trimmed)) {
				fence = undefined;
				continue;
			}
			// Definitions and comments never invoke: `!unquoted procedure
			// SALT($x)` would otherwise match, and commented-out transitions
			// must not claim a mockup.
			if (trimmed.startsWith('!') || trimmed.startsWith("'")) {
				continue;
			}
			const match = SALT_INVOCATION_REG.exec(trimmed);
			if (match) {
				const target = match[1]!.trim();
				if (target && !fence.seen.has(target)) {
					fence.seen.add(target);
					out.get(fence.start)!.push(i);
				}
			}
			continue;
		}

		const open = /^(\s*)(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)(\s.*)?$/.exec(raw);
		if (open) {
			const lang = open[3]!.toLowerCase();
			if (lang === 'plantuml' || lang === 'puml' || lang === 'uml') {
				fence = { start: i, seen: new Set() };
				out.set(i, []);
			}
		}
	}
	return out;
}