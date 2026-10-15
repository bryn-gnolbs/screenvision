# Changelog

## 3 — Live Text selection (2026-10-16)

- Select recognised words like text: the pointer becomes an I-beam over text, drag
  selects words in reading order, double-click a word, triple-click a line. Pressing
  anywhere else still draws or moves the area.
- Selected words show as blue per-line bars; the bubble says "N words selected" and
  Remember, Copy, Search, Lens and Ctrl+C act on just those words (Remember and Lens
  capture the words' area).
- Esc clears a text selection before closing the overlay.

## 2 — ScreenVision interface (2026-10-15)

- New interface: the stock screenshot toolbar is replaced by the selection, the
  assistant's bubble and a slim glass pill (Whole screen, hint, close). Screen
  recording keeps GNOME's own interface.
- **Enter = Remember:** saves the image to Pictures/Screenshots and adds what was
  selected (text, links, emails, codes, source app and window) to a private memory
  log for the coming assistant. Ctrl+C copies text (or the image).
- The assistant's voice: a streaming text bubble that says what it sees, with
  suggested actions as chips. Shared design language in DESIGN.md.
- Live selection: the whole screen is read when the tool opens (parallel bands,
  about half a second), so text, highlights and suggestions follow the selection
  instantly; the selection is read again at full detail on release.
- QR codes are found automatically, close-up scans catch small ones; Wi-Fi codes
  offer their password, links open directly.
- No more invented text in photos (landscape wallpapers and similar).
- Settings: Memory section with "Remember with Enter" and Forget All; the old Lens
  and QR toolbar switches are gone (both live in the bubble).

## 1 — Fork of Shotzy (2026-10-15)

- Renamed to ScreenVision; Google Lens fixed for Snap browsers; screenshots no
  longer written to /tmp; adaptive OCR; configurable shortcut; vision provider
  layer; tests and CI.
