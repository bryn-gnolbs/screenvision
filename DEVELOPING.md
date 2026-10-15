# Developing ScreenVision

A field guide for people who know Python but are new to GNOME Shell extensions.

## The 60-second mental model

- **GNOME Shell is a JavaScript program.** The top bar, overview and screenshot tool
  are written in JS running on **GJS** (GNOME's JS engine, SpiderMonkey-based). An
  extension is a JS module that the shell `import`s into its own process. There is no
  sandbox or plugin API: we reach into the shell's own objects and modify them.
- **GJS ≈ PyGObject.** If you've used `from gi.repository import Gtk, GLib, Gio` in
  Python, you already know the libraries. `import Gio from 'gi://Gio'` is the same
  binding to the same C library, and the C docs map 1:1 (`g_file_get_contents` →
  `GLib.file_get_contents`).
- **Two processes.** `extension.js` and everything it imports run *inside*
  `gnome-shell`. `prefs.js` runs in a separate GTK 4/libadwaita app. They share only
  GSettings (a typed key/value store, see `schemas/*.gschema.xml`), so `lib/` must only
  import `gi://` modules that work in both.
- **Never block.** The extension shares a thread with the whole desktop. A synchronous
  file read or a `subprocess.run`-style wait freezes the mouse. Use async APIs
  (`runCommand` in `lib/common.js` wraps `Gio.Subprocess` the way `asyncio.create_subprocess_exec` would).
- **enable() / disable() must be exact inverses.** The shell calls `disable()` on every
  screen lock and `enable()` on unlock. Anything you add, connect or override has to be
  removed again. `connectObject(..., this)` / `disconnectObject(this)` and
  `InjectionManager` make that bookkeeping easier.

## Python → GJS cheat sheet

| Python | GJS |
|---|---|
| `from gi.repository import Gio` | `import Gio from 'gi://Gio';` |
| `async def` / `await` | `async function` / `await` (same idea; the GLib main loop drives it) |
| `asyncio.create_subprocess_exec` | `runCommand([...])` in `lib/common.js` |
| `tempfile` (private) | `writePrivateTempFile()` in `lib/common.js` |
| `print()` / `logging` | `console.log()` / `console.error()`, read with `make logs` |
| `requests.post` | `Soup.Session` (see `uploader.js`) |
| `unittest` | `make test` (plain `gjs`), `make smoke` (real shell) |
| f-strings | template literals: `` `Hello ${name}` `` |
| `_('text')` gettext | `_('text')`, imported from the extension module |

## Project layout

```
extension.js      Entry point: hooks the screenshot UI, adds the Lens and QR buttons, toasts
ocr.js            OCR controller: runs Tesseract, draws highlight boxes, Copy/Search menu
capture.js        Grabs the selected area from the screenshot UI's frozen frame as PNG
uploader.js       Google Lens upload over HTTPS (returns the results URL)
shortcut.js       Optional extra keyboard shortcut that opens the screenshot tool
prefs.js          Preferences window (separate GTK process)
lib/common.js     Shared helpers: subprocesses, temp files, Tesseract languages, settings parsing
lib/ocrText.js    Pure TSV → words → text logic (unit-tested)
lib/shortcutKeys.js  Key press → shortcut string for the prefs picker (GTK, unit-tested)
stylesheet.css    St widget styling (loaded automatically by the shell)
schemas/          GSettings schema: every user setting is declared here
tests/run.js      Unit tests, run with plain gjs
tests/smoke/      End-to-end test in a throwaway headless GNOME Shell
```

## How it hooks the screenshot tool

GNOME's screenshot UI is `Main.screenshotUI`, defined in the shell's
`ui/screenshot.js`. To read its source:

```bash
gresource extract /usr/lib/gnome-shell/libshell-*.so /org/gnome/shell/ui/screenshot.js > /tmp/screenshot.js
```

We rely on these internals (underscore = private, so they can change between GNOME
versions; check them when adding a new version to `metadata.json`):

- `open()`: wrapped with `InjectionManager` to start OCR when the tool opens
- `_areaSelector._updateSelectionRect()` and its `drag-ended` signal: follow the selection
- `_getSelectedGeometry()`, `_stageScreenshot`, `_scale`: read the selected pixels
- `_panel`, `_typeButtonContainer`, `_bottomRowContainer`, `_showPointerButtonContainer`: toolbar layout

## Day-to-day workflow

```bash
make test     # fast unit tests, no shell needed
make smoke    # builds, starts a hidden GNOME Shell, scripts the screenshot UI, prints PASS/FAIL
make install  # installs for your user
make logs     # follow GNOME Shell's log (console.log/console.error)
make prefs    # open the settings window
```

On **Wayland** the running shell cannot reload extension code. After `make install`,
either log out and back in, or use a nested shell in a window:

```bash
sudo apt install mutter-dev-bin   # once, provides the devkit viewer
make nested
```

In the nested shell press Print Screen to open the screenshot tool. Settings and enabled
extensions are shared with your real session. If you also have the original Shotzy
installed, disable one of them so both don't add buttons.

`make smoke` is the quickest safety net. It runs with its own D-Bus, in-memory
settings, and temporary data and runtime directories, so it never touches your desktop.
(The runtime directory matters: GNOME Shell keeps a crash-protection file there that,
if left behind in your real `/run/user/$UID`, would disable extensions after a crash.) It also saves
a screenshot (`ocr.png`) in the folder it prints.

## Packaging notes

- `gnome-extensions pack` does **not** compile the GSettings schema on GNOME 50, so the
  Makefile compiles it and adds `schemas/gschemas.compiled` to the zip. Without it the
  extension fails to enable.
- The UUID (`smart-screenvision@genolabs.net`) must match the install folder name and
  stay stable once published.

## Useful references

- GJS guide for extensions: https://gjs.guide/extensions/
- Review guidelines (what extensions.gnome.org checks): https://gjs.guide/extensions/review-guidelines/review-guidelines.html
- GJS API docs: https://gjs-docs.gnome.org/
- GNOME Shell source: https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/js/ui
