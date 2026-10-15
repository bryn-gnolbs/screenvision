# Common development tasks. Run `make help` for the list.

UUID := screenvision@genolabs.net
ZIP := build/$(UUID).shell-extension.zip
SOURCES := $(shell git ls-files --cached --others --exclude-standard '*.js' '*.css' '*.json' '*.xml' 2>/dev/null)

.PHONY: help test lint smoke pack install uninstall enable disable prefs logs nested clean

help:
	@echo "make test      Run unit tests (plain gjs, no GNOME Shell needed)"
	@echo "make lint      Check code style with ESLint (needs Node.js: sudo apt install nodejs npm)"
	@echo "make smoke     End-to-end test in a throwaway headless GNOME Shell"
	@echo "make pack      Build $(ZIP)"
	@echo "make install   Pack and install for the current user (log out/in to load on Wayland)"
	@echo "make nested    Run a throwaway GNOME Shell in a window to try changes (needs mutter-dev-bin)"
	@echo "make logs      Follow GNOME Shell's log, where console.log/console.error output goes"
	@echo "make prefs     Open the preferences window"
	@echo "make enable / disable / uninstall / clean"

test:
	gjs -m tests/run.js

lint: node_modules
	npx eslint .

node_modules: package.json
	npm install --no-audit --no-fund
	@touch node_modules

smoke: $(ZIP)
	tests/smoke/run.sh

$(ZIP): $(SOURCES) Makefile
	@mkdir -p build
	gnome-extensions pack --force --out-dir=build \
		--extra-source=capture.js --extra-source=live.js \
		--extra-source=uploader.js --extra-source=shortcut.js --extra-source=lib --extra-source=ui .
	@# pack does not compile the settings schema; GNOME Shell needs the compiled file.
	@mkdir -p build/schemas
	glib-compile-schemas --strict --targetdir=build/schemas schemas
	cd build && zip -q $(notdir $(ZIP)) schemas/gschemas.compiled

pack: $(ZIP)

install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Installed. On Wayland, log out and back in (or use 'make nested') to load the new code."

uninstall:
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

logs:
	journalctl --user -f -o cat /usr/bin/gnome-shell

# GNOME 49+ runs a nested shell through the Mutter development kit window.
nested: install
	scripts/nested.sh

clean:
	rm -rf build
