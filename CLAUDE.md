# ScreenVision

Part of Bryn's agentic personal OS. Read **~/Documents/Code/genolabs-os/PROJECT.md first**
(vision, decisions, rules, roadmap) and ~/Documents/Code/genolabs-os/docs/DESIGN.md (design
language). Also see this repo's README.md and DEVELOPING.md.

Must-follow rules:
- Never push to the original (upstream) repository; push only to bryn-gnolbs/screenvision and pass `--repo bryn-gnolbs/screenvision` to every `gh pr` command.
- Test with `make test` and `make smoke` (isolated headless GNOME Shell); look at screenshots of UI changes.
- Extensions reload only after log out/in on Wayland; `make nested` for a windowed test shell.
- Reply buttons must be complete answers (typed additions after a button's text never arrive).
- Record important changes in ~/Documents/Code/genolabs-os/PROJECT.md.
