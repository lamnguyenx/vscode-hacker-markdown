NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
EXT_ID  := $(PUB).$(NAME)-$(VERSION)
VSIX    := build/$(EXT_ID).vsix

CDP_PORT ?= 9024

.PHONY: build install install-code install-code-server vsix test test-unit test-cdp test-e2e

build: vsix

install: install-code install-code-server

install-code: build
	code --install-extension $(VSIX) --force

install-code-server: build
	code-server --install-extension $(VSIX) --force

vsix:
	mkdir -p build
	npx --yes @vscode/vsce pack -o $(VSIX)

## Compile, run pure-logic + CDP + Playwright tests.
test: test-unit test-cdp test-e2e

## Pure-logic checks (no host, no server).
test-unit: compile
	node tests/plantuml_check.cjs
	node tests/plantuml_inline_check.cjs
	node tests/plantuml_completion_check.cjs
	node tests/plantuml_definition_check.cjs
	node tests/mermaid_check.cjs

## CDP integration checks (needs code-server or dev host on CDP_PORT).
test-cdp: compile
	node tests/plantuml_note_highlight_check.cjs
	node tests/mermaid_stale_check.cjs
	node tests/test_preview.cjs

## Playwright E2E tests (connects to the browser on CDP_PORT).
test-e2e: compile
	CDP_PORT=$(CDP_PORT) npx playwright test --config playwright.config.ts

compile:
	npm run compile
