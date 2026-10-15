// The user's keyboard shortcut for opening the screenshot tool.
//
// GNOME already opens the tool with its own 'show-screenshot-ui' shortcut
// (Print Screen by default). When our setting matches that, GNOME handles it
// and we register nothing; otherwise we add a second shortcut that behaves
// exactly like GNOME's own.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {showScreenshotUI} from 'resource:///org/gnome/shell/ui/screenshot.js';

export const SHORTCUT_KEY = 'screenshot-shortcut';

// Same modes as GNOME's built-in binding: everywhere except the login screen.
const SHORTCUT_MODES = Shell.ActionMode.ALL & ~Shell.ActionMode.LOGIN_SCREEN;

export class ScreenshotShortcut {
    /** @param {Gio.Settings} settings - extension settings */
    constructor(settings) {
        this._settings = settings;
        this._shellKeybindings = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        this._registered = false;

        this._settings.connectObject(`changed::${SHORTCUT_KEY}`, () => this._sync(), this);
        this._shellKeybindings.connectObject('changed::show-screenshot-ui', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._shellKeybindings.disconnectObject(this);
        this._unregister();
    }

    /** True when our shortcut is registered with the window manager. */
    get registered() {
        return this._registered;
    }

    _sync() {
        this._unregister();

        const accelerators = this._settings.get_strv(SHORTCUT_KEY).filter(Boolean);
        const builtIn = new Set(this._shellKeybindings.get_strv('show-screenshot-ui'));
        if (accelerators.length === 0 || accelerators.every(a => builtIn.has(a)))
            return;

        Main.wm.addKeybinding(SHORTCUT_KEY, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, SHORTCUT_MODES, showScreenshotUI);
        this._registered = true;
    }

    _unregister() {
        if (!this._registered)
            return;

        Main.wm.removeKeybinding(SHORTCUT_KEY);
        this._registered = false;
    }
}
