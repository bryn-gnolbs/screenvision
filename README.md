# Smart ScreenVision

Text recognition, QR scanning and Google Lens search inside the built-in GNOME
screenshot tool (GNOME 49–50).

Smart ScreenVision is a fork of [Shotzy](https://github.com/SamkitJain660/Shotzy) by
Samkit Jain, licensed under the GPL-3.0 like the original.

## Features

- **Text recognition:** select an area and every recognised word is highlighted.
  **Copy** puts the text on the clipboard; **Search** looks it up with your chosen engine.
- **QR codes:** the grid button decodes QR codes and barcodes in the selection and
  copies the content.
- **Google Lens:** the magnifier button sends the selected area to Google Lens and opens
  the results in your browser.

### Changes since Shotzy

- Google Lens works with sandboxed browsers such as Ubuntu's Snap Firefox: the image is
  uploaded directly and only the results link is opened. No HTML file is written to `/tmp`.
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

See [DEVELOPING.md](DEVELOPING.md). `make test` runs the unit tests and `make smoke` runs an
end-to-end check in a throwaway headless GNOME Shell.

## Privacy

Text recognition and QR scanning run entirely on your computer. The Google Lens button
uploads the selected area to Google, and only when you click it.
