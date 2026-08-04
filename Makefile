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
	cp -R out build "$(DEST)"/
	cp package.json README.md "$(DEST)"/
	@echo "Installed to $(DEST). Reload VS Code (Cmd+Shift+P > Developer: Reload Window) to activate."
