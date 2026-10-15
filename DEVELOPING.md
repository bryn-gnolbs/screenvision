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
live.js           Live vision UI: reads the whole screen on open, live highlights and suggestions while
                  dragging, sharper read on release
capture.js        Grabs the selected area from the screenshot UI's frozen frame as PNG
uploader.js       Google Lens hand-off: one-time 127.0.0.1 page that makes the browser upload
shortcut.js       Optional extra keyboard shortcut that opens the screenshot tool
prefs.js          Preferences window (separate GTK process)
lib/common.js     Shared helpers: subprocesses, temp files, settings parsing
lib/vision/       Vision providers: provider.js (contract), tesseract.js, index.js (registry),
                  tiling.js (parallel bands for whole screens), codes.js (QR/barcodes via zbar)
lib/screenContext.js  What is known about the current screen; answers "what's in this rectangle?"
lib/intents.js    Suggested actions for a selection (open link, Wi-Fi password, copy, search, Lens...)
lib/ocrText.js    Pure TSV → words → text logic (unit-tested)
lib/shortcutKeys.js  Key press → shortcut string for the prefs picker (GTK, unit-tested)
stylesheet.css    St widget styling (loaded automatically by the shell)
schemas/          GSettings schema: every user setting is declared here
tests/run.js      Unit tests, run with plain gjs
tests/smoke/      End-to-end test in a throwaway headless GNOME Shell
```

## How live vision works

1. **Overlay opens:** `live.js` captures the whole frozen frame and, in parallel,
   scans it for QR codes/barcodes (`codes.js`, ~0.1 s) and reads all text
   (`tiling.js` splits it into bands read by several single-threaded Tesseract
   processes, ~0.5-0.7 s on a 2560x1600 screen). Whole-screen reads use
   adaptive thresholding (light and dark areas mix) and drop low-confidence and
   symbol-only words. Results go into a `ScreenContext`.
2. **Dragging:** every movement of the selection asks the context what lies
   inside the rectangle - plain in-memory filtering, so highlights, text and
   suggestions (`intents.js`) update instantly.
3. **Release:** the selection is read again at full detail with default
   settings and replaces the whole-screen words for that exact rectangle.

The context is what the assistant will receive later. It never leaves the
computer unless the user acts.

## Vision providers

Text recognition goes through a small interface so the engine can be swapped
without touching the UI. `live.js` captures the screen or selection, calls
`provider.recognize(png, {languages, minConfidence, cancellable})`, and gets back
words with boxes in image pixels; it then maps them onto the screen.

To add a provider (for example an AI model running locally or on a server):

1. Create `lib/vision/<name>.js` implementing the contract documented in
   `lib/vision/provider.js` (`id`, `name`, `isAvailable()`, optional `prepare()`,
   `recognize()`).
2. Register it in `FACTORIES` in `lib/vision/index.js`.
3. Add unit tests in `tests/run.js`. `tests/fixtures/two-lines.png` is a ready-made
   test image.

Keep providers free of GNOME Shell imports (only `gi://` modules) so they can be
unit-tested with plain `gjs`. A remote provider would use `Soup.Session` for
HTTP, as the tests in `tests/run.js` do.

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

In the nested shell press Print Screen to open the screenshot tool. The terminal shows only
ScreenVision messages and JavaScript errors; the full log is in `build/nested.log`. Errors
from your other installed extensions show up there too, since the nested shell loads them.
After a code change, close the window and run `make nested` again; no re-login needed.

**Limitation:** Snap apps (Ubuntu's Firefox included) refuse to start from the nested shell,
because it runs on a private D-Bus outside a normal desktop session. Google Lens and the
Search button do hand their URL to the browser there, but Snap blocks the launch. Test those
on your real desktop (log out and back in after `make install`). Settings and enabled
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
- The UUID (`screenvision@genolabs.net`) must match the install folder name and
  stay stable once published.

## Useful references

- GJS guide for extensions: https://gjs.guide/extensions/
- Review guidelines (what extensions.gnome.org checks): https://gjs.guide/extensions/review-guidelines/review-guidelines.html
- GJS API docs: https://gjs-docs.gnome.org/
- GNOME Shell source: https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/js/ui
