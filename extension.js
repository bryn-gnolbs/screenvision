// Entry point. GNOME Shell calls enable() when the extension is switched on
// (and on every unlock) and disable() when it is switched off (and on every
// lock), so disable() must undo everything enable() did.
//
// ScreenVision takes over GNOME's screenshot tool in screenshot mode: the
// stock toolbar is hidden and replaced by the selection, the assistant's
// bubble and a slim pill. In screen-recording mode it steps aside completely
// and GNOME's own interface is shown.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    Extension, InjectionManager, gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LiveVisionController} from './live.js';
import {ScreenshotShortcut} from './shortcut.js';
import {LensLauncher} from './uploader.js';
import {logError} from './lib/common.js';
import {VisionPill} from './ui/pill.js';

// Cursor types over the area's edges and corner handles: GNOME keeps those.
const RESIZE_CURSORS = new Set([
    Clutter.CursorType.NW_RESIZE, Clutter.CursorType.NE_RESIZE, Clutter.CursorType.SW_RESIZE,
    Clutter.CursorType.SE_RESIZE, Clutter.CursorType.N_RESIZE, Clutter.CursorType.S_RESIZE,
    Clutter.CursorType.E_RESIZE, Clutter.CursorType.W_RESIZE,
]);
const ENTER_KEYS = new Set([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter]);
// Stock shortcuts for features ScreenVision replaces (Space captured, C/W
// switched to screen/window mode, V to recording, P toggled the pointer).
const BLOCKED_KEYS = new Set([
    Clutter.KEY_space, Clutter.KEY_c, Clutter.KEY_C, Clutter.KEY_w, Clutter.KEY_W,
    Clutter.KEY_v, Clutter.KEY_V, Clutter.KEY_p, Clutter.KEY_P,
]);

export default class ScreenVisionExtension extends Extension {
    enable() {
        const ui = Main.screenshotUI;
        if (!ui)
            return;

        this._settings = this.getSettings();
        this._injections = new InjectionManager();
        this._lens = new LensLauncher();
        this._pill = new VisionPill({
            onWholeScreen: () => this._selectWholeScreen(ui),
            onClose: () => ui.close(),
        });
        ui.add_child(this._pill);
        this._live = new LiveVisionController(this._settings, {
            searchWithLens: () => this._searchWithLens(ui).catch(e => logError('Google Lens', e)),
            avoidRect: () => this._pill?.rect ?? null,
        });
        this._shortcut = new ScreenshotShortcut(this._settings);

        this._hookScreenshotUI(ui);
        this._syncMode(ui);
    }

    disable() {
        const ui = Main.screenshotUI;
        if (!ui || !this._settings)
            return;

        // Restore the original screenshot UI methods, signals and toolbar.
        this._injections.clear();
        this._injections = null;
        ui._areaSelector?.disconnectObject(this);
        ui._selectionButton?.disconnectObject(this);
        ui._castButton?.disconnectObject(this);
        ui.disconnectObject(this);
        this._setStockToolbarVisible(ui, true);

        this._shortcut.destroy();
        this._shortcut = null;
        this._pill.destroy();
        this._pill = null;
        this._live.destroy();
        this._live = null;
        this._lens.destroy();
        this._lens = null;
        this._settings = null;
    }

    /** True in screenshot mode, where ScreenVision's interface is shown. */
    _isVisionMode(ui) {
        return !ui._castButton?.checked;
    }

    _hookScreenshotUI(ui) {
        const live = this._live;
        const self = this;

        // Each time the tool opens: pick the interface and start reading the screen.
        this._injections.overrideMethod(ui, 'open', original => {
            return async function (...args) {
                const result = await original.apply(this, args);
                self._syncMode(this);
                if (self._isVisionMode(this)) {
                    this._selectionButton.checked = true;
                    live.onOpened(this);
                }
                return result;
            };
        });

        // Update highlights and the bubble on every move of the selection.
        if (ui._areaSelector) {
            this._injections.overrideMethod(ui._areaSelector, '_updateSelectionRect', original => {
                return function (...args) {
                    const result = original.apply(this, args);
                    if (self._isVisionMode(ui)) {
                        live.refreshSelection(ui);
                        self._pill.yieldTo(live.selectionRect(ui));
                    }
                    return result;
                };
            });

            this._hookTextSelection(ui);

            // On release, read the selection again at full detail.
            ui._areaSelector.connectObject('drag-ended', () => {
                if (self._isVisionMode(ui))
                    live.recognizeSelection(ui).catch(e => logError('Text recognition failed', e));
            }, this);
        }

        ui._selectionButton?.connectObject('notify::checked', () => live.refreshSelection(ui), this);

        // Recording mode gets GNOME's own interface back.
        ui._castButton?.connectObject('notify::checked', () => {
            this._syncMode(ui);
            if (this._isVisionMode(ui))
                live.refreshSelection(ui);
            else
                live.reset();
        }, this);

        // Runs before the stock key handler, so ScreenVision decides first.
        ui.connectObject('key-press-event', (_actor, event) => this._onKeyPress(ui, event), this);
        ui.connectObject('closed', () => live.reset(), this);
    }

    /**
     * Live Text: share the pointer with GNOME's area selector. A press on a
     * recognised word selects text; anywhere else (empty space, the
     * selection's edges and corner handles, or with Ctrl held) GNOME draws or
     * moves the area as before.
     */
    _hookTextSelection(ui) {
        const live = this._live;
        const self = this;
        const selector = ui._areaSelector;

        const claimsPoint = (x, y) => live.wordAtPoint(x, y) >= 0 &&
            !RESIZE_CURSORS.has(selector._computeCursorType(x, y));

        this._injections.overrideMethod(selector, '_onPress', original => {
            return function (event, button, sequence) {
                if (self._isVisionMode(ui) && button === Clutter.BUTTON_PRIMARY && !sequence &&
                    !this._dragButton && !(event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
                    const [x, y] = event.get_coords();
                    if (claimsPoint(x, y)) {
                        live.pointerPress(ui, x, y, event.get_time());
                        return Clutter.EVENT_STOP;
                    }
                }
                // GNOME takes this press: a new or moved area replaces any text selection.
                live.clearTextSelection(ui, false);
                return original.call(this, event, button, sequence);
            };
        });

        this._injections.overrideMethod(selector, '_onMotion', original => {
            return function (event, sequence) {
                const [x, y] = event.get_coords();
                if (live.isTextDragging) {
                    live.pointerMotion(ui, x, y);
                    return Clutter.EVENT_STOP;
                }
                if (self._isVisionMode(ui) && !sequence && !this._dragButton && claimsPoint(x, y)) {
                    this.set_cursor_type(Clutter.CursorType.TEXT);
                    return Clutter.EVENT_STOP;
                }
                return original.call(this, event, sequence);
            };
        });

        // Esc clears a text selection first; a second Esc closes as usual.
        // GNOME's grab helper turns Esc into ungrab({isUser: true}), which
        // closes the overlay; with a text selection, clear it instead.
        if (ui._grabHelper) {
            this._injections.overrideMethod(ui._grabHelper, 'ungrab', original => {
                return function (params = {}) {
                    if (params.isUser && !params.actor && ui.visible &&
                        self._isVisionMode(ui) && live.hasTextSelection) {
                        live.clearTextSelection(ui);
                        return;
                    }
                    return original.call(this, params);
                };
            });
        }

        this._injections.overrideMethod(selector, '_onRelease', original => {
            return function (event, button, sequence) {
                if (live.isTextDragging && button === Clutter.BUTTON_PRIMARY) {
                    live.pointerRelease(ui);
                    return Clutter.EVENT_STOP;
                }
                return original.call(this, event, button, sequence);
            };
        });
    }

    _syncMode(ui) {
        const vision = this._isVisionMode(ui);
        this._setStockToolbarVisible(ui, !vision);
        this._pill.visible = vision;
        if (vision)
            ui.set_child_above_sibling(this._pill, null);
    }

    _setStockToolbarVisible(ui, visible) {
        if (ui._panel)
            ui._panel.visible = visible;
        if (ui._closeButton)
            ui._closeButton.visible = visible;
    }

    _onKeyPress(ui, event) {
        if (!this._isVisionMode(ui))
            return Clutter.EVENT_PROPAGATE;

        const symbol = event.get_key_symbol();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (ENTER_KEYS.has(symbol)) {
            this._live.remember(ui).catch(e => logError('Remembering failed', e));
            return Clutter.EVENT_STOP;
        }
        if (control && (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C)) {
            this._live.copySelection(ui).catch(e => logError('Copying failed', e));
            return Clutter.EVENT_STOP;
        }
        if (!control && BLOCKED_KEYS.has(symbol))
            return Clutter.EVENT_STOP;

        return Clutter.EVENT_PROPAGATE;
    }

    /** Select the whole primary monitor, as if dragged corner to corner. */
    _selectWholeScreen(ui) {
        const monitor = Main.layoutManager.primaryMonitor;
        const selector = ui._areaSelector;
        if (!monitor || !selector)
            return;

        ui._selectionButton.checked = true;
        [selector._startX, selector._startY] = [monitor.x, monitor.y];
        [selector._lastX, selector._lastY] = [monitor.x + monitor.width - 1, monitor.y + monitor.height - 1];
        selector._updateSelectionRect();
        selector.emit('drag-ended');
    }

    async _searchWithLens(ui) {
        const capture = await this._live.captureSubject(ui);
        if (!capture)
            return;

        ui.close();

        // The browser does the upload itself (see uploader.js).
        try {
            const url = this._lens.serve(capture.png,
                capture.pixbuf.get_width(), capture.pixbuf.get_height());
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            logError('Google Lens hand-off failed', e);
            Main.notify(_('ScreenVision'), _('Could not open Google Lens: %s').format(e.message));
        }
    }
}
