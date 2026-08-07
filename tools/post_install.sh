#!/usr/bin/env bash
# Post-install verification hook for vscode-hacker-markdown. Invoked by
# tools/install.sh as `post_install.sh <installed-extension-dir>` after each
# successful CLI install; fails if the package's runtime grammar files did not
# land. A missing syntaxes/ folder is how a "works in the dev host, not after
# install" regression first slipped in.
#
# To use with a different extension, replace the file list below.
# Usage: post_install.sh <installed-extension-dir>
set -euo pipefail

EXT_DIR="${1:?usage: post_install.sh <installed-extension-dir>}"

for f in \
	syntaxes/codeblock.json \
	syntaxes/plantuml.tmLanguage.json \
	syntaxes/language-configuration.json; do
	if [ ! -f "$EXT_DIR/$f" ]; then
		echo "ERROR: missing $EXT_DIR/$f" >&2
		exit 1
	fi
done

echo "syntaxes installed: codeblock.json, plantuml.tmLanguage.json, language-configuration.json"
