NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
DEST    := $(HOME)/.vscode/extensions/$(PUB).$(NAME)-$(VERSION)

.PHONY: build install

build:
	npm run compile

install: build
	rm -r "$(DEST)" || true
	mkdir -p "$(DEST)"
	cp -R out build syntaxes "$(DEST)"/
	cp package.json README.md "$(DEST)"/
	@test -f "$(DEST)/syntaxes/codeblock.json" \
	  && test -f "$(DEST)/syntaxes/plantuml.tmLanguage.json" \
	  && test -f "$(DEST)/syntaxes/language-configuration.json" \
	  && echo "syntaxes installed: codeblock.json, plantuml.tmLanguage.json, language-configuration.json" \
	  || (echo "ERROR: syntaxes/ files missing in $(DEST)" >&2 && false)
	@echo "Installed to $(DEST). Reload VS Code (Cmd+Shift+P > Developer: Reload Window) to activate."
