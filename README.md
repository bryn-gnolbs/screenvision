# ScreenVision

Text recognition, QR scanning and Google Lens search inside the built-in GNOME
screenshot tool (GNOME 49–50).

ScreenVision is a fork of [Shotzy](https://github.com/SamkitJain660/Shotzy) by
Samkit Jain, licensed under the GPL-3.0 like the original.

## Features

- **Live selection:** when the screenshot tool opens, ScreenVision reads the whole screen
  in the background (about half a second). While you drag, recognised words light up and
  suggestions follow your selection instantly; when you let go, the selection is read again
  at full detail. All of this runs on your computer.
- **It tells you what it sees:** a small card follows your selection with a summary
  ("2 lines of text · Link to example.com") and, once you pause, streams in the text it
  read, word by word.
- **Smart suggestions:** the card's buttons adapt to what you select: open links, copy a
  Wi-Fi password from a QR code, write an email, **Copy** text, **Search** it, or ask **Lens**.
- **QR codes:** codes on screen are found automatically; the grid button copies them too.
- **Google Lens:** the magnifier button sends the selected area to Google Lens and opens
  the results in your browser.
- **Your own shortcut:** open the screenshot tool with any key combination, such as
  Super+Shift+S, set under *General → Keyboard Shortcut*. Print Screen keeps working too.

### Changes since Shotzy

- Google Lens works with sandboxed browsers such as Ubuntu's Snap Firefox. Instead of
  a launcher file in `/tmp`, the extension serves a one-time page on `127.0.0.1` (random
  address, stops once used) that makes your browser upload the image to Lens itself.
- Screenshots are no longer written to world-readable `/tmp` under predictable names.
  OCR passes the image to Tesseract through a pipe, and QR scanning uses a private file in
  `$XDG_RUNTIME_DIR` that is deleted straight away.
- More reliable recognition: text on mixed or dark backgrounds that Shotzy's sparse-text
  mode missed is now read, and copied text keeps Tesseract's line structure.
- Clear messages when Tesseract or zbar is missing instead of silently doing nothing.
- OCR runs again as soon as you switch back to Selection mode.
- Installed languages are detected with `tesseract --list-langs`, so distro-specific
  tessdata locations work without setting `TESSDATA_PREFIX`.
- Uses GNOME's `InjectionManager`, a stylesheet and translatable strings; covered by
  unit tests and an automated end-to-end test.

## Dependencies

Text recognition needs **Tesseract**; QR scanning needs **zbar**. Both are optional.

```bash
# Ubuntu / Debian
sudo apt install tesseract-ocr zbar-tools

# Arch
sudo pacman -S tesseract tesseract-data-eng zbar

# Fedora
sudo dnf install tesseract zbar
```

For other languages install the matching Tesseract data package (for example
`tesseract-ocr-deu` on Ubuntu), then enable it under *Text Recognition → Languages*.

## Install from source

```bash
make install
```

Then log out and back in (Wayland can't reload extensions in a running session) and run:

```bash
make enable
```

If the original Shotzy is also installed, disable it to avoid duplicate buttons:

```bash
gnome-extensions disable shotzy@SamkitJain660.github.io
```

## Development

See [DEVELOPING.md](DEVELOPING.md) for the code and [DESIGN.md](DESIGN.md) for the design
language shared by all parts of the project. `make test` runs the unit tests and `make smoke` runs an
end-to-end check in a throwaway headless GNOME Shell.

## Privacy

Text recognition and QR scanning run entirely on your computer. The Google Lens button
uploads the selected area to Google, and only when you click it.
