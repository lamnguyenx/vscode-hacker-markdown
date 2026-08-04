import * as zlib from 'zlib';
import { Diagram } from './diagram';

/**
 * Build a PlantUML server URL for one page of a diagram.
 * @param server  PlantUML server base URL (trailing slashes already trimmed)
 * @param format  render format: 'svg' or 'png'
 * @param index   page index (0 = first page; 0 is omitted from the URL,
 *                compatible with kroki-style servers)
 */
export function makePlantumlURL(server: string, diagram: Diagram, format: string, index: number): string {
	const components = [server.replace(/^\/|\/$/g, ''), format];
	// Omit index in URL if possible; partially compatible with kroki server (#302)
	if (index !== 0) {
		components.push(index.toString());
	}
	components.push(getDiagramURIComponent(diagram.contentWithInclude));
	return components.join('/');
}

export function getDiagramURIComponent(s: string): string {
	const opt: zlib.ZlibOptions = { level: 9 };
	const d = zlib.deflateRawSync(Buffer.from(s), opt) as Buffer;
	// 'binary' is latin1: byte value -> char code per character, identical to
	// String.fromCharCode(...bytes) but without the argument-count limit
	// that throws on very large diagrams.
	const b = encode64(d.toString('binary'));
	return b;
}

// from synchro.js — PlantUML's standard base64-ish encoding
/* Copyright (C) 1999 Masanao Izumo <iz@onicos.co.jp>
 * Version: 1.0.1
 * LastModified: Dec 25 1999
 */
function encode64(data: string): string {
	let r = '';
	for (let i = 0; i < data.length; i += 3) {
		if (i + 2 === data.length) {
			r += append3bytes(data.charCodeAt(i), data.charCodeAt(i + 1), 0);
		} else if (i + 1 === data.length) {
			r += append3bytes(data.charCodeAt(i), 0, 0);
		} else {
			r += append3bytes(data.charCodeAt(i), data.charCodeAt(i + 1), data.charCodeAt(i + 2));
		}
	}
	return r;
}

function append3bytes(b1: number, b2: number, b3: number): string {
	const c1 = b1 >> 2;
	const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
	const c3 = ((b2 & 0xF) << 2) | (b3 >> 6);
	const c4 = b3 & 0x3F;
	let r = '';
	r += encode6bit(c1 & 0x3F);
	r += encode6bit(c2 & 0x3F);
	r += encode6bit(c3 & 0x3F);
	r += encode6bit(c4 & 0x3F);
	return r;
}

function encode6bit(b: number): string {
	if (b < 10) {
		return String.fromCharCode(48 + b);
	}
	b -= 10;
	if (b < 26) {
		return String.fromCharCode(65 + b);
	}
	b -= 26;
	if (b < 26) {
		return String.fromCharCode(97 + b);
	}
	b -= 26;
	if (b === 0) {
		return '-';
	}
	if (b === 1) {
		return '_';
	}
	return '?';
}
