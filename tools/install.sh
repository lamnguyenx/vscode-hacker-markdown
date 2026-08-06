#!/usr/bin/env bash
# Installs the built extension (out/ build/ syntaxes/ package.json README.md)
# into every supported extension directory that exists on this machine:
#   $HOME/.vscode/extensions                        (native VS Code)
#   ${XDG_DATA_HOME:-$HOME/.local/share}/code-server/extensions  (code-server)
#   $HOME/.vscode-server/extensions                 (Remote-SSH server — set
#   when running on the remote host, e.g. `make install` in the integrated
#   terminal of a Remote-SSH window)
# Absent roots are skipped; the script fails if none is found.
set -euo pipefail

EXT_ID="${1:?usage: install.sh <publisher.name-version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

NATIVE_DEST="$HOME/.vscode/extensions"
CODESERVER_DEST="${XDG_DATA_HOME:-$HOME/.local/share}/code-server/extensions"
SERVER_DEST="$HOME/.vscode-server/extensions"

installed=0
for dest in "$NATIVE_DEST" "$CODESERVER_DEST" "$SERVER_DEST"; do
	[ -d "$dest" ] || continue
	target="$dest/$EXT_ID"
	rm -rf "$target"
	mkdir -p "$target"
	cp -R "$ROOT/out" "$ROOT/build" "$ROOT/syntaxes" "$target"/
	cp "$ROOT/package.json" "$ROOT/README.md" "$target"/
	if [ -f "$target/syntaxes/codeblock.json" ] \
		&& [ -f "$target/syntaxes/plantuml.tmLanguage.json" ] \
		&& [ -f "$target/syntaxes/language-configuration.json" ]; then
		echo "syntaxes installed: codeblock.json, plantuml.tmLanguage.json, language-configuration.json"
	else
		echo "ERROR: syntaxes/ files missing in $target" >&2
		exit 1
	fi
	echo "Installed to $target. Reload the window (Cmd+Shift+P > Developer: Reload Window) to activate."
	installed=1
done

if [ "$installed" -eq 0 ]; then
	echo "No extension directory found: $NATIVE_DEST, $CODESERVER_DEST and $SERVER_DEST are all missing." >&2
	exit 1
fi
