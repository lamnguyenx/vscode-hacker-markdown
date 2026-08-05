/**
 * Fence detection for PlantUML code completion.
 *
 * VS Code has no scope-based completion for embedded grammar regions
 * (microsoft/vscode#208862), so the completion provider is registered on the
 * `markdown` language and self-filters: `fenceAt` decides whether a given
 * line lies inside a `plantuml`/`puml`/`uml` fenced code block.
 *
 * Pure module (no `vscode` import) so the real shipped code is unit-testable
 * in plain Node (`tests/plantuml_completion_check.cjs`).
 */

/**
 * The `plantuml`/`puml`/`uml` fence languages we complete in. Matches
 * `syntaxes/codeblock.json` (case-insensitive).
 */
export const PLANTUML_FENCE_LANGS = new Set(['plantuml', 'puml', 'uml']);

export interface FenceAt {
	/** The fence info-string language (`plantuml`, `puml` or `uml`), normalized. */
	readonly lang: string;
	/** 0-based line of the opening fence. */
	readonly startLine: number;
	/** 0-based line of the closing fence, or undefined while the fence is open. */
	readonly endLine: number | undefined;
}

/**
 * A potential markdown fence line: leading whitespace, a `` ``` `` / `~~~`
 * run, an optional info string and optional trailing attributes.
 */
const FENCE_LINE_REG = /^(\s*)(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)(\s.*)?$/;

interface FenceState {
	openLine: number;
	char: string;
	run: number;
	lang: string | undefined;
}

function isFenceCloser(trimmed: string, char: string, minRun: number): boolean {
	return trimmed.length >= minRun && trimmed[0] === char && /^[`~]+$/.test(trimmed);
}

function normalizeLang(info: string | undefined): string | undefined {
	const lang = (info ?? '').toLowerCase();
	return PLANTUML_FENCE_LANGS.has(lang) ? lang : undefined;
}

/**
 * Returns fence info when `line` (0-based) is a content line strictly inside
 * a `plantuml`/`puml`/`uml` fence in `text`; undefined on the opening or
 * closing line, outside any fence, or inside a non-puml fence.
 *
 * Any fence (regardless of info string) is tracked as open/closed so a puml
 * fence never escapes its boundaries. Markdown fences don't nest.
 */
export function fenceAt(text: string, line: number): FenceAt | undefined {
	if (line < 0) {
		return undefined;
	}
	const lines = text.replace(/\r\n|\r/g, '\n').split('\n');

	let state: FenceState | undefined;
	for (let i = 0; i <= line && i < lines.length; i++) {
		const raw = lines[i]!;
		const trimmed = raw.trim();

		if (state) {
			if (isFenceCloser(trimmed, state.char, state.run)) {
				if (i === line) {
					return undefined; // cursor on the closing fence
				}
				state = undefined;
			}
			continue;
		}

		const open = raw.match(FENCE_LINE_REG);
		if (open) {
			if (i === line) {
				return undefined; // cursor on the opening fence
			}
			state = {
				openLine: i,
				char: open[2]![0]!,
				run: open[2]!.length,
				lang: normalizeLang(open[3])
			};
		}
	}

	if (!state || line <= state.openLine || !state.lang) {
		return undefined;
	}

	let endLine: number | undefined;
	for (let i = line + 1; i < lines.length; i++) {
		if (isFenceCloser(lines[i]!.trim(), state.char, state.run)) {
			endLine = i;
			break;
		}
	}
	return { lang: state.lang, startLine: state.openLine, endLine };
}
