NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
EXT_ID  := $(PUB).$(NAME)-$(VERSION)

.PHONY: build install vsix

build:
	npm run compile

# Packs the extension into a VSIX (build/) and installs it into every
# supported extension directory that exists on this machine (native VS Code,
# code-server, Remote-SSH server). Delegates to the published vscode-hacker-meta
# CLI with the VSIX path and the verification script registered explicitly.
install: build
	npx --yes vscode-hacker-meta install "build/$(EXT_ID).vsix" --post-install-script tools/post_install.sh

# Packs the extension into a VSIX placed in build/. vsce runs the compile via
# the vscode:prepublish script.
build:
	npx --yes @vscode/vsce pack -o build/$(EXT_ID).vsix
