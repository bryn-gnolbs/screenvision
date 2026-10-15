// Turning key presses into shortcut strings for the preferences window.
// Uses GTK 4, so only import this from prefs.js and tests, never from the shell.

import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

// Keys that are only modifiers: keep waiting for the real key.
const MODIFIER_KEYVALS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
]);

/**
 * Decide what a key press in the shortcut dialog means.
 *
 * @param {number} keyval - Gdk key value
 * @param {number} keycode - hardware keycode (0 if unknown)
 * @param {number} state - Gdk.ModifierType flags held during the press
 * @returns {{action: 'wait'|'cancel'|'disable'|'set'|'reject',
 *   accelerator?: string, reason?: 'needs-modifier'|'invalid'}}
 */
export function interpretKeyPress(keyval, keycode, state) {
    const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;

    if (MODIFIER_KEYVALS.has(keyval))
        return {action: 'wait'};
    if (mask === 0 && keyval === Gdk.KEY_Escape)
        return {action: 'cancel'};
    if (mask === 0 && keyval === Gdk.KEY_BackSpace)
        return {action: 'disable'};

    // A letter, digit or symbol with no modifier (or only Shift) would fire
    // while typing, so require Ctrl, Alt or Super for those.
    const typesCharacter = Gdk.keyval_to_unicode(keyval) !== 0;
    if (typesCharacter && (mask & ~Gdk.ModifierType.SHIFT_MASK) === 0)
        return {action: 'reject', reason: 'needs-modifier'};

    if (!Gtk.accelerator_valid(keyval, mask))
        return {action: 'reject', reason: 'invalid'};

    return {action: 'set', accelerator: Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mask)};
}
