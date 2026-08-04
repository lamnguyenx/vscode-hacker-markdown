'use strict';
/**
 * Copies the webview static assets (css, icon) from src/media/ into build/.
 *
 * `src/**` is excluded from the shipped extension (.vscodeignore), so the
 * static assets the webview loads must be copied into build/ — the same
 * directory the esbuild bundle lands in — for the packaged extension to
 * serve them.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'media');
const dest = path.join(root, 'build');

fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
	fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
console.log(`copied ${fs.readdirSync(src).length} webview assets to build/`);
