#!/bin/bash
# End-to-end smoke test in a throwaway headless GNOME Shell.
#
# Everything is isolated from your desktop session: a private D-Bus, in-memory
# settings, and temporary data and runtime directories. Nothing is installed into your
# real ~/.local/share and your running shell is never touched.
#
# Usage: tests/smoke/run.sh   (or `make smoke`). Needs the zip from `make pack`.
# SSV_SMOKE_WITH="a.zip b.zip" loads other extensions first (e.g. Spotlight, which
# carries a copy of the bubble): ScreenVision must still load beside them.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
ZIP="$PROJECT/build/screenvision@genolabs.net.shell-extension.zip"
OUT="$(mktemp -d -t ssv-smoke-XXXXXX)"
[ -f "$ZIP" ] || { echo "Missing $ZIP - run 'make pack' first" >&2; exit 2; }

export XDG_DATA_HOME="$OUT/data" XDG_CONFIG_HOME="$OUT/config" XDG_CACHE_HOME="$OUT/cache"
# Own runtime dir too: GNOME Shell keeps crash-protection state there, which
# must never leak into the real session's /run/user/$UID.
# Kept short on purpose: Wayland socket paths are limited to 108 bytes.
export XDG_RUNTIME_DIR="$(mktemp -d /tmp/ssv-rt-XXXXXX)"
trap 'rm -rf "$XDG_RUNTIME_DIR"' EXIT
export GSETTINGS_BACKEND=memory SSV_SMOKE_OUT="$OUT"
EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions"
mkdir -p "$EXT_DIR/screenvision@genolabs.net" "$EXT_DIR/ssv-smoke-driver@test"
unzip -q "$ZIP" -d "$EXT_DIR/screenvision@genolabs.net"
cp "$PROJECT"/tests/smoke/driver/* "$EXT_DIR/ssv-smoke-driver@test/"
COMPANIONS=""
for zip in ${SSV_SMOKE_WITH:-}; do
    uuid=$(unzip -p "$zip" metadata.json | python3 -c 'import json, sys; print(json.load(sys.stdin)["uuid"])')
    mkdir -p "$EXT_DIR/$uuid" && unzip -q "$zip" -d "$EXT_DIR/$uuid"
    COMPANIONS="$COMPANIONS $uuid"
done
export COMPANIONS
cp "$PROJECT"/tests/fixtures/qr-codes.png "$EXT_DIR/ssv-smoke-driver@test/"
# The driver reads the memory log through the extension's own module.
mkdir -p "$EXT_DIR/ssv-smoke-driver@test/lib"
cp "$PROJECT"/lib/memory.js "$PROJECT"/lib/intents.js "$PROJECT"/lib/secrets.js "$EXT_DIR/ssv-smoke-driver@test/lib/"

# Pictures must point into the sandbox: "Remember" saves screenshots there,
# and nothing may land in the real ~/Pictures.
mkdir -p "$XDG_CONFIG_HOME" "$OUT/Pictures"
echo "XDG_PICTURES_DIR=\"$OUT/Pictures\"" > "$XDG_CONFIG_HOME/user-dirs.dirs"
unset WAYLAND_DISPLAY DISPLAY

timeout 120 dbus-run-session -- bash -c '
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x900 >"$SSV_SMOKE_OUT/shell.log" 2>&1 &
    shell=$!
    for _ in $(seq 60); do
        gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell >/dev/null 2>&1 && break
        sleep 0.5
    done
    for uuid in $COMPANIONS; do gnome-extensions enable "$uuid"; done
    gnome-extensions enable screenvision@genolabs.net
    gnome-extensions enable ssv-smoke-driver@test
    for _ in $(seq 120); do grep -q "SMOKE done" "$SSV_SMOKE_OUT/shell.log" && break; sleep 0.5; done
    # Whichever loaded first, every extension must be running (a shared class
    # name, for one, makes the second fail).
    for uuid in $COMPANIONS screenvision@genolabs.net; do
        state=$(gnome-extensions info "$uuid" | sed -n "s/.*State: //p")
        verdict=$([ "$state" = ACTIVE ] && echo PASS || echo FAIL)
        echo "SMOKE $verdict $uuid is running beside the others \"$state\"" >> "$SSV_SMOKE_OUT/checks.log"
    done
    kill $shell; wait $shell 2>/dev/null || true
' 2>"$OUT/session.log" || true

# The shell writes its log at its own offset, so the script's own checks go in checks.log.
touch "$OUT/checks.log"
grep -h -E "SMOKE (PASS|FAIL)" "$OUT/shell.log" "$OUT/checks.log" | sed -E 's/.*SMOKE //' || true
echo "Log and screenshot: $OUT"
if grep -q "SMOKE FAIL" "$OUT/shell.log" "$OUT/checks.log" || ! grep -q "SMOKE PASS" "$OUT/shell.log"; then
    exit 1
fi
