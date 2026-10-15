// Entry point. GNOME Shell calls enable() when the extension is switched on
// (and on every unlock) and disable() when it is switched off (and on every
// lock), so disable() must undo everything enable() did.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    Extension, InjectionManager, gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {captureSelection, isSelectionMode} from './capture.js';
import {LiveVisionController} from './live.js';
import {ScreenshotShortcut} from './shortcut.js';
import {LensLauncher} from './uploader.js';
import {logError} from './lib/common.js';
import {codesAvailable, scanCodes} from './lib/vision/codes.js';

const TOAST_TIMEOUT_MS = 1800;
const NOTIFY_PREVIEW_CHARS = 120;

const Tooltip = GObject.registerClass(
class Tooltip extends St.Label {
    _init(widget, text) {
        super._init({
            text,
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });

        widget.connectObject(
            'notify::hover', () => (widget.hover ? this._show(widget) : this._hide()),
            'destroy', () => this.destroy(),
            this);
    }

    _show(widget) {
        const extents = widget.get_transformed_extents();
        const x = Math.floor(extents.get_x() + (extents.get_width() - this.width) / 2);
        const y = extents.get_y() + extents.get_height() + 6;

        this.remove_all_transitions();
        this.set_position(x, y);
        this.opacity = 0;
        this.show();
        this.ease({
            opacity: 255,
            delay: 500,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hide() {
        this.remove_all_transitions();
        this.hide();
    }
});

export default class ScreenVisionExtension extends Extension {
    enable() {
        const ui = Main.screenshotUI;
        if (!ui)
            return;

        this._settings = this.getSettings();
        this._injections = new InjectionManager();
        this._lens = new LensLauncher();
        this._live = new LiveVisionController(this._settings, {
            showMessage: text => this._showToast(text),
            searchWithLens: () => this._searchWithLens(ui).catch(e => logError('Google Lens', e)),
        });
        this._shortcut = new ScreenshotShortcut(this._settings);
        this._toast = null;
        this._toastTimeoutId = 0;

        this._hookScreenshotUI(ui);
        this._createButtons(ui);
        this._syncButtons();
        this._settings.connectObject(
            'changed::show-google-lens-button', () => this._syncButtons(),
            'changed::show-qr-button', () => this._syncButtons(),
            this);
    }

    disable() {
        const ui = Main.screenshotUI;
        if (!ui || !this._settings)
            return;

        // Restore the original screenshot UI methods and signal handlers.
        this._injections.clear();
        this._injections = null;
        ui._areaSelector?.disconnectObject(this);
        ui._selectionButton?.disconnectObject(this);
        ui.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._shortcut.destroy();
        this._shortcut = null;

        this._restoreDefaultLayout(ui);
        this._lensButton?.destroy();
        this._lensButton = null;
        this._qrButton?.destroy();
        this._qrButton = null;

        if (this._toastTimeoutId) {
            GLib.source_remove(this._toastTimeoutId);
            this._toastTimeoutId = 0;
        }
        this._toast?.destroy();
        this._toast = null;

        this._live.destroy();
        this._live = null;
        this._lens.destroy();
        this._lens = null;
        this._settings = null;
    }

    _hookScreenshotUI(ui) {
        const live = this._live;

        // Start reading the screen each time the screenshot tool opens.
        this._injections.overrideMethod(ui, 'open', original => {
            return async function (...args) {
                const result = await original.apply(this, args);
                live.onOpened(this);
                return result;
            };
        });

        // Update highlights and suggestions on every move of the selection.
        if (ui._areaSelector) {
            this._injections.overrideMethod(ui._areaSelector, '_updateSelectionRect', original => {
                return function (...args) {
                    const result = original.apply(this, args);
                    live.refreshSelection(ui);
                    return result;
                };
            });

            // On release, read the selection again at full detail.
            ui._areaSelector.connectObject('drag-ended', () => {
                live.recognizeSelection(ui).catch(e => logError('Text recognition failed', e));
            }, this);
        }

        // Hide or show suggestions when switching modes; the screen reading
        // is kept, so returning to selection mode is instant.
        ui._selectionButton?.connectObject('notify::checked', () => live.refreshSelection(ui), this);

        ui.connectObject('closed', () => live.reset(), this);
    }

    _createButtons(ui) {
        if (!ui._panel || !ui._showPointerButtonContainer)
            return;

        this._lensButton = this._makeActionButton(ui, {
            iconName: 'system-search-symbolic',
            styleClass: 'ssv-lens-button',
            tooltip: _('Search with Google Lens'),
            onClicked: () => this._searchWithLens(ui),
        });
        ui._showPointerButtonContainer.add_child(this._lensButton);

        this._qrButton = this._makeActionButton(ui, {
            iconName: 'view-grid-symbolic',
            styleClass: 'ssv-qr-button',
            tooltip: _('Scan QR code'),
            onClicked: () => this._scanQrCode(ui),
        });
    }

    _makeActionButton(ui, {iconName, styleClass, tooltip, onClicked}) {
        const button = new St.Button({
            // Reuse the screenshot UI's own class so the button looks native.
            style_class: `screenshot-ui-show-pointer-button ${styleClass}`,
            child: new St.Icon({icon_name: iconName, icon_size: 24}),
            can_focus: true,
            accessible_name: tooltip,
        });
        button.connect('clicked', () => {
            onClicked().catch(e => {
                logError(tooltip, e);
                this._showToast(_('Something went wrong: %s').format(e.message));
            });
        });
        ui.add_child(new Tooltip(button, tooltip));
        return button;
    }

    _syncButtons() {
        const ui = Main.screenshotUI;
        if (!this._lensButton || !this._qrButton)
            return;

        this._lensButton.visible = this._settings.get_boolean('show-google-lens-button');

        const showQr = this._settings.get_boolean('show-qr-button');
        this._qrButton.visible = showQr;
        if (showQr)
            this._useSideBoxLayout(ui);
        else
            this._restoreDefaultLayout(ui);
    }

    /**
     * The QR button sits in a column to the right of the screenshot toolbar.
     * The toolbar's own rows are moved into a wrapper next to that column:
     *
     *   _panel ─ wrapper ─┬─ innerBox ─┬─ _typeButtonContainer
     *                     │            └─ _bottomRowContainer
     *                     └─ sideBox ─── QR button
     */
    _useSideBoxLayout(ui) {
        if (this._layoutWrapper)
            return;

        const typeRow = ui._typeButtonContainer;
        const bottomRow = ui._bottomRowContainer;
        if (!typeRow || !bottomRow)
            return;

        this._layoutWrapper = new St.BoxLayout();
        this._layoutInner = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._sideBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ssv-side-box',
        });

        ui._panel.remove_child(typeRow);
        ui._panel.remove_child(bottomRow);
        this._layoutInner.add_child(typeRow);
        this._layoutInner.add_child(bottomRow);
        this._sideBox.add_child(this._qrButton);
        this._layoutWrapper.add_child(this._layoutInner);
        this._layoutWrapper.add_child(this._sideBox);
        ui._panel.add_child(this._layoutWrapper);
    }

    _restoreDefaultLayout(ui) {
        if (!this._layoutWrapper)
            return;

        for (const row of [ui._typeButtonContainer, ui._bottomRowContainer]) {
            this._layoutInner.remove_child(row);
            ui._panel.add_child(row);
        }
        this._sideBox.remove_child(this._qrButton);

        // Destroying the wrapper also destroys the inner and side boxes.
        this._layoutWrapper.destroy();
        this._layoutWrapper = null;
        this._layoutInner = null;
        this._sideBox = null;
    }

    async _searchWithLens(ui) {
        const capture = await captureSelection(ui);
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

    async _scanQrCode(ui) {
        if (!isSelectionMode(ui)) {
            this._showToast(_('Select an area to scan for QR codes'));
            return;
        }
        if (!codesAvailable()) {
            this._showToast(_('Install zbar (zbarimg) to scan QR codes'));
            return;
        }

        // Codes found when the screen was read are instant; otherwise scan
        // the selection itself (small codes read better close up).
        let codes = this._live.context.select(this._live.selectionRect(ui)).codes;
        if (codes.length === 0) {
            const capture = await captureSelection(ui);
            codes = capture ? await scanCodes(capture.png) : [];
        }

        if (codes.length === 0) {
            this._showToast(_('No QR code found in the selection'));
            return;
        }

        const content = codes.map(code => code.data).join('\n');
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, content);
        ui.close();

        const preview = content.length > NOTIFY_PREVIEW_CHARS
            ? `${content.slice(0, NOTIFY_PREVIEW_CHARS)}…`
            : content;
        Main.notify(_('QR code copied'), preview);
    }

    /** Show a short message floating above the screenshot toolbar. */
    _showToast(text) {
        const ui = Main.screenshotUI;

        if (!this._toast) {
            this._toast = new St.Label({style_class: 'ssv-toast', visible: false});
            ui.add_child(this._toast);
        }
        if (this._toastTimeoutId)
            GLib.source_remove(this._toastTimeoutId);

        const toast = this._toast;
        toast.remove_all_transitions();
        toast.text = text;
        toast.opacity = 0;
        toast.show();
        ui.set_child_above_sibling(toast, null);

        const [, width] = toast.get_preferred_width(-1);
        const [, height] = toast.get_preferred_height(width);
        const panel = ui._panel?.get_transformed_extents();
        toast.set_position(
            Math.max(12, Math.round((global.stage.width - width) / 2)),
            panel ? Math.max(12, Math.round(panel.get_y() - height - 16)) : 24);
        toast.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        this._toastTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_TIMEOUT_MS, () => {
            this._toastTimeoutId = 0;
            toast.ease({
                opacity: 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => toast.hide(),
            });
            return GLib.SOURCE_REMOVE;
        });
    }
}
