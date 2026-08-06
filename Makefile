NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
PUB     := $(shell node -p "require('./package.json').publisher")
EXT_ID  := $(PUB).$(NAME)-$(VERSION)

.PHONY: build install

build:
	npm run compile

# Installs the built extension into every supported extension directory that
# exists on this machine (native VS Code, code-server). See tools/install.sh.
install: build
	./tools/install.sh "$(EXT_ID)"
