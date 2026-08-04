'use strict';
/**
 * Builds the PlantUML TextMate grammar: converts the YAML source grammar
 * (syntaxes/plantuml.yaml-tmLanguage, vendored from jebbs/plantuml under MIT)
 * into the JSON format vscode-textmate reads.
 *
 * The YAML top-level keys (scopeName, patterns, repository, fileTypes, ...)
 * map 1:1 to the JSON grammar keys, so the conversion is a plain YAML->JSON
 * dump. The output MUST keep the `.json` suffix: vscode-textmate picks the
 * parser by file extension — `.tmLanguage` (plist) vs `.tmLanguage.json`
 * (JSON) — so a `.tmLanguage` file of JSON content fails to load.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const input = path.join(root, 'syntaxes', 'plantuml.yaml-tmLanguage');
const output = path.join(root, 'syntaxes', 'plantuml.tmLanguage.json');

const source = fs.readFileSync(input, 'utf8');
const data = yaml.load(source);

// `author`/`comment` are metadata, not grammar keys — drop them so the
// shipped grammar stays minimal.
delete data.author;
delete data.comment;

fs.writeFileSync(output, JSON.stringify(data, null, 4) + '\n');
console.log(`built ${path.relative(root, output)} (${data.patterns.length} top-level patterns)`);
