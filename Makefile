NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
EXT_ID  := $(PUB).$(NAME)-$(VERSION)
VSIX    := build/$(EXT_ID).vsix

# Inputs that decide whether the VSIX is stale: `$(VSIX)` depends on these,
# so make skips `vsce pack` while the VSIX is newer than all of them (same
# mtime rule as the meta repo's `make install-ssh`). Generated trees (out/,
# build/, node_modules/) are deliberately absent — the recipe rebuilds them.
SOURCES := $(shell find src syntaxes -type f 2>/dev/null) \
	package.json package-lock.json tsconfig.json tsconfig.webview.json

CDP_PORT ?= 9024

.PHONY: build install install-code install-code-server vsix test test-unit test-cdp test-e2e

build vsix: $(VSIX)

install: install-code install-code-server

install-code: build
	code --install-extension $(VSIX) --force

install-code-server: build
	code-server --install-extension $(VSIX) --force

$(VSIX): $(SOURCES)
	mkdir -p build
	npx --yes @vscode/vsce pack -o $@

## Pure-logic checks only (safe default — no host needed).
test: test-unit

## Pure-logic checks (no host, no server, no compile — bun runs the TS sources).
test-unit:
	bun tests/units/plantuml_check.ts
	bun tests/units/plantuml_inline_check.ts
	bun tests/units/plantuml_completion_check.ts
	bun tests/units/plantuml_definition_check.ts
	bun tests/units/mermaid_check.ts

## CDP integration checks (needs code-server or dev host on CDP_PORT).
test-cdp: compile
	bun tests/integration/plantuml_note_highlight_check.ts
	bun tests/integration/mermaid_stale_check.ts
	bun tests/integration/test_preview.ts

## Playwright E2E tests (connects to the browser on CDP_PORT).
test-e2e: compile
	CDP_PORT=$(CDP_PORT) npx playwright test --config playwright.config.ts

compile:
	npm run compile
