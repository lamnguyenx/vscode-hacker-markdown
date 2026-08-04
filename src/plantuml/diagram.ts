import { getContentWithInclude } from './include';
import { DiagramType, getType } from './type';

/**
 * The minimal shape of the markdown document we resolve includes against.
 * `vscode.Uri` satisfies it structurally, but keeping it as an interface lets
 * the pure rendering modules run outside the extension host (unit tests).
 */
export interface DiagramUri {
	readonly scheme: string;
	readonly fsPath: string;
}

export const diagramStartReg = /@start(\w+)/i;
export const diagramEndReg = /@end(\w+)/i;

/**
 * A single PlantUML diagram extracted from a `puml`/`plantuml`/`uml` fence.
 * Only the pieces the markdown-preview rendering needs: the type (to pick
 * svg vs png), the page count (`newpage`), and the include-expanded source
 * (what actually gets encoded into the server URL).
 */
export class Diagram {
	public parentUri?: DiagramUri;
	public content: string;
	private _lines: string[] | undefined = undefined;
	private _type: DiagramType | undefined = undefined;
	private _pageCount: number | undefined = undefined;
	private _contentWithInclude: string | undefined = undefined;

	constructor(content: string, parentUri?: DiagramUri, private readonly _includePaths: string[] = []) {
		this.content = content;
		this.parentUri = parentUri;
	}

	public get type(): DiagramType {
		return this._type || (this._type = getType(this));
	}

	public get lines(): string[] {
		return this._lines || (this._lines = this.content.replace(/\r\n|\r/g, '\n').split('\n'));
	}

	public get pageCount(): number {
		if (this._pageCount !== undefined) {
			return this._pageCount;
		}
		this._pageCount = 1;
		const regNewPage = /^\s*newpage\b/i;
		for (const text of this.lines) {
			if (regNewPage.test(text)) {
				this._pageCount++;
			}
		}
		return this._pageCount;
	}

	public get contentWithInclude(): string {
		return this._contentWithInclude || (this._contentWithInclude = getContentWithInclude(this, this._includePaths));
	}
}
