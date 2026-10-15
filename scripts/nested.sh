#!/bin/bash
# Run a throwaway GNOME Shell in a window (Mutter devkit) with the installed
# extension. Close the window to stop it.
#
# The full log goes to build/nested.log; the terminal only shows ScreenVision
# messages and JavaScript errors.
set -u

LOG="build/nested.log"
CRASH_FILE="${XDG_RUNTIME_DIR:-/run/user/$UID}/gnome-shell-disable-extensions"
mkdir -p build

if [ ! -x /usr/libexec/mutter-devkit ] && ! command -v mutter-devkit >/dev/null; then
    echo "The nested window needs the Mutter devkit: sudo apt install mutter-dev-bin" >&2
    exit 1
fi

# GNOME Shell keeps a crash-protection file here for its first 60 seconds.
# The nested shell shares this folder with your real session, so if it is
# killed early the file would stay behind and could disable your extensions
# after a later crash. Remember whether it existed, and clean up after.
[ -e "$CRASH_FILE" ] && existed=1 || existed=0

echo "Starting nested GNOME Shell (full log: $LOG). Close its window to stop."
echo "Note: Snap apps (e.g. Firefox) cannot launch from the nested shell, so test Google Lens"
echo "      and the Search button on your real desktop instead."
MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 \
    dbus-run-session gnome-shell --devkit --wayland 2>&1 \
    | tee "$LOG" \
    | grep --line-buffered -iE "screenvision|JS ERROR|^\s*[a-zA-Z_]*@file://.*smart-screenvision"

if [ "$existed" = 0 ] && [ -e "$CRASH_FILE" ]; then
    rm -f "$CRASH_FILE"
    echo "Removed leftover $CRASH_FILE"
fi
echo "Nested shell stopped."
