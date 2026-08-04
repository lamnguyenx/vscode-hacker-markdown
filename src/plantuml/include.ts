import * as path from 'path';
import * as fs from 'fs';
import { Diagram, DiagramUri } from './diagram';

// http://plantuml.com/en/preprocessing
const INCLUDE_REG = /^\s*!(include(?:sub)?)\s+(.+?)(?:!(\w+))?$/i;
const STARTSUB_TEST_REG = /^\s*!startsub\s+(\w+)/i;
const ENDSUB_TEST_REG = /^\s*!endsub\b/i;

const START_DIAGRAM_REG = /(^|\r?\n)\s*@start.*\r?\n/i;
const END_DIAGRAM_REG = /\r?\n\s*@end.*(\r?\n|$)(?!.*\r?\n\s*@end.*(\r?\n|$))/i;

interface FileSubBlocks {
	[key: string]: string[];
}

/**
 * Expands `!include` / `!includesub` directives in a diagram's source. Search
 * order: the Markdown file's own folder, then the configured `includepaths`.
 * State (already-included files, include route) lives per resolution so
 * successive renders never leak into each other.
 */
export function getContentWithInclude(diagram: Diagram, includePaths: string[]): string {
	return new IncludeResolver(includePaths).resolve(diagram);
}

class IncludeResolver {
	private included: { [key: string]: boolean } = {};
	private route: string[] = [];

	constructor(private readonly _includePaths: string[]) { }

	public resolve(diagram: Diagram): string {
		this.included = {};
		this.route = diagram.parentUri ? [diagram.parentUri.fsPath] : [];
		const searchPaths = getSearchPaths(diagram.parentUri, this._includePaths);
		return this.resolveLines(diagram.lines, searchPaths);
	}

	private resolveLines(content: string | string[], searchPaths: string[]): string {
		const lines = content instanceof Array
			? content
			: content.replace(/\r\n|\r/g, '\n').split('\n');
		const processedLines = lines.map((line) => line.replace(
			INCLUDE_REG,
			(match: string, ...args: string[]) => {
				const Action = args[0].toLowerCase();
				const target = args[1].trim();
				const sub = args[2];
				const file = path.isAbsolute(target) ? target : findFile(target, searchPaths);
				let result: string | undefined;
				if (Action === 'include') {
					result = this.getIncludeContent(file, searchPaths);
				} else {
					result = this.getIncludesubContent(file, sub, searchPaths);
				}
				return result === undefined ? match : result;
			}
		));
		return processedLines.join('\n');
	}

	private getIncludeContent(file: string | undefined, searchPaths: string[]): string | undefined {
		if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return undefined;
		if (this.included[file]) {
			return '';
		}
		this.route.push(file);
		const content = fs.readFileSync(file).toString();
		this.included[file] = true;
		let result = this.resolveLines(content, getSearchPaths({ scheme: 'file', fsPath: file }, this._includePaths));
		this.route.pop();

		result = result.replace(START_DIAGRAM_REG, '$1');
		result = result.replace(END_DIAGRAM_REG, '$1');

		return result;
	}

	private getIncludesubContent(file: string | undefined, sub: string | undefined, searchPaths: string[]): string | undefined {
		if (!file || !sub) return undefined;
		const identifier = `${file}!${sub}`;
		const find = this.route.indexOf(identifier);
		if (find >= 0) {
			throw 'Include loop detected!' + '\n\n' + makeLoopInfo(this.route, find);
		}
		this.route.push(identifier);
		let result: string | undefined;
		const blocks = getSubBlocks(file);
		if (blocks) {
			result = this.resolveLines(blocks[sub], getSearchPaths({ scheme: 'file', fsPath: file }, this._includePaths));
		}
		this.route.pop();
		return result;
	}
}

function getSearchPaths(uri: DiagramUri | undefined, includePaths: string[]): string[] {
	const searchPaths: string[] = [];
	if (uri && uri.scheme === 'file') {
		searchPaths.push(path.dirname(uri.fsPath));
	}
	for (const includePath of includePaths) {
		searchPaths.push(includePath);
	}
	return Array.from(new Set(searchPaths));
}

function findFile(file: string, searchPaths: string[]): string | undefined {
	for (const dir of searchPaths) {
		const found = path.join(dir, file);
		if (fs.existsSync(found)) return found;
	}
	return undefined;
}

function getSubBlocks(file: string): FileSubBlocks {
	if (!file) return {};
	const blocks: FileSubBlocks = {};
	const lines = fs.readFileSync(file).toString().split('\n');
	let subName = '';
	let match: RegExpMatchArray | null;
	for (const line of lines) {
		match = STARTSUB_TEST_REG.exec(line);
		if (match) {
			subName = match[1];
			continue;
		} else if (ENDSUB_TEST_REG.test(line)) {
			subName = '';
			continue;
		} else {
			if (subName) {
				if (!blocks[subName]) blocks[subName] = [];
				blocks[subName].push(line);
			}
		}
	}
	return blocks;
}

function makeLoopInfo(route: string[], loopID: number): string {
	const lines: string[] = [];
	for (let i = 0; i < loopID; i++) {
		lines.push(route[i]);
	}
	lines.push('|-> ' + route[loopID]);
	for (let i = loopID + 1; i < route.length - 1; i++) {
		lines.push('|   ' + route[loopID]);
	}
	lines.push('|<- ' + route[route.length - 1]);
	return lines.join('\n');
}
