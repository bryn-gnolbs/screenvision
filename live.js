// Live vision inside the screenshot UI. When the overlay opens, the whole
// frozen screen is read in the background (text and codes, see lib/vision).
// While the user drags a selection, highlights and suggested actions update
// instantly from that reading; on release, the selection is read again at
// full detail. Everything stays on this computer.

import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {captureScreen, captureSelection, isSelectionMode} from './capture.js';
import {buildSearchUrl, clamp, logError, parseRgbaSetting} from './lib/common.js';
import {suggestActions} from './lib/intents.js';
import {hasLettersOrDigits} from './lib/ocrText.js';
import {ScreenContext} from './lib/screenContext.js';
import {scanCodes} from './lib/vision/codes.js';
import {createProvider} from './lib/vision/index.js';
import {wordsToStage} from './lib/vision/provider.js';
import {chooseBandCount, recognizeInBands} from './lib/vision/tiling.js';

const DEFAULT_STYLE = {
    fill: [0.10, 0.11, 0.13, 0.34],
    border: [0.92, 0.94, 0.97, 0.34],
    shadowOpacity: 0.18,
    glow: [1.00, 1.00, 1.00, 0.07],
    radius: 6,
    padding: 3,
    borderWidth: 1.25,
};

const MAX_MENU_ACTIONS = 5;
// Minimum confidence for words from the whole-screen read (0-100).
const SCREEN_MIN_CONFIDENCE = 50;

const OCRHighlightOverlay = GObject.registerClass(
class OCRHighlightOverlay extends St.DrawingArea {
    _init() {
        super._init({
            reactive: false,
            visible: false,
        });

        this._boxes = [];
        this._style = DEFAULT_STYLE;
    }

    setBoxes(boxes) {
        this._boxes = boxes;
        this.visible = boxes.length > 0;
        this.queue_repaint();
    }

    setStyle(style) {
        this._style = style;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const style = this._style;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        for (const box of this._boxes) {
            const x = box.x - style.padding;
            const y = box.y - style.padding;
            const width = box.width + style.padding * 2;
            const height = box.height + style.padding * 2;
            const radius = Math.min(style.radius, width / 2, height / 2);

            cr.setSourceRGBA(0, 0, 0, style.shadowOpacity);
            roundedRect(cr, x, y + 2, width, height, radius + 1);
            cr.fill();

            cr.setSourceRGBA(...style.fill);
            roundedRect(cr, x, y, width, height, radius);
            cr.fillPreserve();

            cr.setSourceRGBA(...style.border);
            cr.setLineWidth(style.borderWidth);
            cr.stroke();

            cr.setSourceRGBA(...style.glow);
            cr.setLineWidth(1);
            cr.moveTo(x + radius, y + 1.5);
            cr.lineTo(x + width - radius, y + 1.5);
            cr.stroke();
        }

        cr.$dispose();
    }
});

export class LiveVisionController {
    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {object} hooks
     * @param {function(string): void} hooks.showMessage - shows a toast in the screenshot UI
     * @param {function(): void} hooks.searchWithLens - sends the selection to Google Lens
     */
    constructor(settings, {showMessage, searchWithLens}) {
        this._settings = settings;
        this._showMessage = showMessage;
        this._searchWithLens = searchWithLens;
        this._overlay = null;
        this._menuLayer = null;
        this._menu = null;
        this._status = null;
        this._menuSignature = null;
        this._selected = {words: [], codes: [], text: ''};
        this._context = new ScreenContext();
        this._screenCancellable = null;
        this._refineCancellable = null;
        this._provider = createProvider();
        this._warnedUnavailable = false;

        this._reloadSettings();
        this._settings.connectObject('changed', () => {
            this._reloadSettings();
            this._overlay?.setStyle(this._style);
            this.refreshSelection(Main.screenshotUI);
        }, this);
    }

    destroy() {
        this.reset();
        this._settings.disconnectObject(this);

        this._overlay?.destroy();
        this._overlay = null;
        this._menuLayer?.destroy();
        this._menuLayer = null;
        this._menu = null;
        this._status = null;
    }

    /** The current selection rectangle in stage coordinates, or null. */
    selectionRect(ui) {
        return this._getSelection(ui);
    }

    /** What ScreenVision currently knows about the screen. */
    get context() {
        return this._context;
    }

    /** Forget everything and stop any running recognition. */
    reset() {
        this._screenCancellable?.cancel();
        this._screenCancellable = null;
        this._refineCancellable?.cancel();
        this._refineCancellable = null;
        this._context.clear();
        this._selected = {words: [], codes: [], text: ''};

        this._overlay?.setBoxes([]);
        this._hideMenu();
    }

    /** Called each time the screenshot UI opens. */
    onOpened(ui) {
        this._ensureAttached(ui);
        this.reset();
        this._warnedUnavailable = false;

        if (!this._config.enabled)
            return;

        if (this._config.readWholeScreen) {
            this._readScreen(ui).catch(e => logError('Reading the screen failed', e));
        } else {
            this._provider.prepare?.().catch(e => logError('Preparing vision provider failed', e));
            this.recognizeSelection(ui).catch(e => logError('Text recognition failed', e));
        }
        this.refreshSelection(ui);
    }

    /**
     * Update highlights and suggestions for the current selection. Called on
     * every movement of the selection rectangle, so it only filters what is
     * already known and never waits for recognition.
     */
    refreshSelection(ui) {
        const selection = this._config.enabled ? this._getSelection(ui) : null;
        if (!this._overlay || !selection) {
            this._overlay?.setBoxes([]);
            this._hideMenu();
            return;
        }

        this._selected = this._context.select(selection);
        this._overlay.set_size(global.stage.width, global.stage.height);
        this._overlay.setBoxes(this._selected.words);
        this._showMenu(selection);
    }

    /**
     * Read the current selection again at full detail and swap the result in.
     * Runs when the user lets go of the selection.
     */
    async recognizeSelection(ui) {
        if (!this._config.enabled || !this._checkAvailable())
            return;

        const selection = this._getSelection(ui);
        if (!selection || this._context.hasRefined(selection))
            return;

        this._refineCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._refineCancellable = cancellable;

        try {
            const capture = await captureSelection(ui);
            if (!capture || cancellable.is_cancelled())
                return;

            const {png, resizeScale} = this._prepareForOcr(capture);
            const words = await this._provider.recognize(png, {
                languages: this._config.languages,
                minConfidence: this._config.confidence,
                cancellable,
            });
            if (cancellable.is_cancelled())
                return;

            this._context.setRefined(selection, wordsToStage(words, {
                scale: ui._scale * resizeScale,
                offsetX: selection.x,
                offsetY: selection.y,
            }));
            this.refreshSelection(ui);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        } finally {
            if (this._refineCancellable === cancellable)
                this._refineCancellable = null;
        }
    }

    /**
     * Recognise all text and codes on the frozen screen in the background, so
     * that selections can be answered instantly. Nothing leaves the computer.
     */
    async _readScreen(ui) {
        if (!this._checkAvailable())
            return;

        const cancellable = new Gio.Cancellable();
        this._screenCancellable = cancellable;
        this._context.status = 'reading';

        try {
            const [capture] = await Promise.all([
                captureScreen(ui),
                this._provider.prepare?.(),
            ]);
            if (cancellable.is_cancelled())
                return;

            // Whole screens mix light and dark areas and contain icons and
            // wallpaper, so read them with local thresholding and stricter
            // filtering than a selection.
            const options = {
                languages: this._config.languages,
                minConfidence: Math.max(this._config.confidence, SCREEN_MIN_CONFIDENCE),
                adaptiveThreshold: true,
                cancellable,
            };
            const height = capture.pixbuf.get_height();
            const [words, codes] = await Promise.all([
                this._provider.prefersBands
                    ? recognizeInBands(this._provider, capture.pixbuf, {
                        ...options,
                        bands: chooseBandCount(height, GLib.get_num_processors()),
                        overlap: Math.round(48 * ui._scale),
                        singleThread: true,
                    })
                    : this._provider.recognize(capture.png, options),
                scanCodes(capture.png, {cancellable}),
            ]);
            if (cancellable.is_cancelled())
                return;

            const toStage = {scale: ui._scale, offsetX: 0, offsetY: 0};
            this._context.setScreen({
                words: wordsToStage(words.filter(hasLettersOrDigits), toStage),
                codes: wordsToStage(codes, toStage),
            });
            this.refreshSelection(ui);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        } finally {
            if (this._screenCancellable === cancellable)
                this._screenCancellable = null;
        }
    }

    _checkAvailable() {
        if (this._provider.isAvailable())
            return true;

        if (!this._warnedUnavailable) {
            this._warnedUnavailable = true;
            this._showMessage(_('Install %s to recognise text').format(this._provider.name));
        }
        return false;
    }

    /** Shrink very large selections so recognition stays fast. */
    _prepareForOcr({pixbuf, png}) {
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const longEdge = Math.max(width, height);
        if (longEdge <= this._config.maxEdge)
            return {png, resizeScale: 1};

        const resizeScale = this._config.maxEdge / longEdge;
        const scaled = pixbuf.scale_simple(
            Math.max(1, Math.round(width * resizeScale)),
            Math.max(1, Math.round(height * resizeScale)),
            GdkPixbuf.InterpType.BILINEAR);
        const [, buffer] = scaled.save_to_bufferv('png', [], []);
        return {png: buffer, resizeScale};
    }

    _ensureAttached(ui) {
        if (!this._overlay) {
            this._overlay = new OCRHighlightOverlay();
            this._overlay.add_constraint(new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            this._overlay.setStyle(this._style);
            ui._stageScreenshotContainer.insert_child_above(this._overlay, ui._stageScreenshot);
        }

        if (!this._menuLayer) {
            this._menuLayer = new St.Widget({reactive: false});
            this._menuLayer.add_constraint(new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }));

            this._menu = new St.BoxLayout({
                style_class: 'ssv-text-menu',
                visible: false,
                reactive: true,
            });
            this._menuLayer.add_child(this._menu);
            ui.insert_child_above(this._menuLayer, ui._areaSelector);
        }
    }

    _getSelection(ui) {
        if (!isSelectionMode(ui))
            return null;

        const geometry = ui._getSelectedGeometry(false);
        if (!geometry || geometry[2] <= 0 || geometry[3] <= 0)
            return null;

        const [x, y, width, height] = geometry;
        return {x, y, width, height};
    }

    /** Rebuild the buttons only when the suggestions change, then place the menu. */
    _showMenu(selection) {
        if (!this._menu)
            return;

        const reading = this._context.status === 'reading' && this._selected.words.length === 0;
        const suggestions = suggestActions(this._selected).slice(0, MAX_MENU_ACTIONS);
        const signature = JSON.stringify([reading, suggestions]);

        if (signature !== this._menuSignature) {
            this._menuSignature = signature;
            this._menu.destroy_all_children();
            if (reading) {
                this._menu.add_child(new St.Label({
                    text: _('Reading screen…'),
                    style_class: 'ssv-text-menu-status',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            for (const suggestion of suggestions) {
                const button = new St.Button({
                    label: this._labelFor(suggestion),
                    style_class: 'ssv-text-menu-button',
                    can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                button.connect('clicked', () => this._runAction(suggestion));
                this._menu.add_child(button);
            }
        }

        const [, menuWidth] = this._menu.get_preferred_width(-1);
        const [, menuHeight] = this._menu.get_preferred_height(menuWidth);
        const position = placeMenu(selection, {width: menuWidth, height: menuHeight},
            getHudRect(), {width: global.stage.width, height: global.stage.height});

        this._menu.set_position(position.x, position.y);
        this._menu.show();
        this._menuLayer.set_child_above_sibling(this._menu, null);
    }

    _hideMenu() {
        this._menu?.hide();
    }

    _labelFor({kind, detail}) {
        switch (kind) {
        case 'open-url':
            return _('Open %s').format(detail);
        case 'copy-wifi-password':
            return detail ? _('Copy Wi-Fi password (%s)').format(detail) : _('Copy Wi-Fi password');
        case 'copy-code':
            return _('Copy QR content');
        case 'email':
            return _('Write email');
        case 'copy-text':
            return _('Copy');
        case 'search':
            return _('Search');
        case 'lens':
            return _('Lens');
        default:
            return kind;
        }
    }

    _runAction({kind, value}) {
        switch (kind) {
        case 'open-url':
            this._openUri(value);
            break;
        case 'email':
            this._openUri(`mailto:${value}`);
            break;
        case 'search':
            this._openUri(buildSearchUrl(this._config.searchEngine, value));
            break;
        case 'copy-text':
            this._copy(value, _('Text copied'), this._config.closeAfterCopy);
            break;
        case 'copy-code':
            this._copy(value, _('QR content copied'), false);
            break;
        case 'copy-wifi-password':
            this._copy(value, _('Wi-Fi password copied'), false);
            break;
        case 'lens':
            this._searchWithLens();
            break;
        }
    }

    _copy(text, message, closeAfter) {
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        clipboard.set_text(St.ClipboardType.PRIMARY, text);
        this._showMessage(message);

        if (closeAfter)
            Main.screenshotUI?.close();
    }

    _openUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
            Main.screenshotUI?.close();
        } catch (e) {
            logError(`Opening ${uri} failed`, e);
            this._showMessage(_('Could not open %s').format(uri));
        }
    }

    _reloadSettings() {
        const s = this._settings;

        this._style = {
            ...DEFAULT_STYLE,
            fill: parseRgbaSetting(s.get_string('highlight-fill-color'), DEFAULT_STYLE.fill),
            border: parseRgbaSetting(s.get_string('highlight-border-color'), DEFAULT_STYLE.border),
            shadowOpacity: clamp(s.get_double('highlight-shadow-opacity'), 0, 0.75),
            radius: clamp(s.get_int('highlight-radius'), 0, 24),
            padding: clamp(s.get_int('highlight-padding'), 0, 24),
            borderWidth: clamp(s.get_double('highlight-border-width'), 0.5, 8),
        };

        this._config = {
            enabled: s.get_boolean('ocr-enabled'),
            readWholeScreen: s.get_boolean('read-whole-screen'),
            confidence: clamp(s.get_int('selection-confidence'), 0, 99),
            maxEdge: clamp(s.get_int('selection-max-edge'), 800, 4096),
            languages: s.get_strv('ocr-languages'),
            searchEngine: s.get_string('search-engine'),
            closeAfterCopy: s.get_boolean('close-after-copy'),
        };
    }
}

/**
 * Pick a spot for the suggestions menu: below the selection, then above, then
 * either side, skipping spots that leave the screen or cover the screenshot
 * toolbar.
 */
function placeMenu(selection, menu, blocker, stage) {
    const margin = 12;
    const fitX = x => clamp(Math.round(x), margin, stage.width - menu.width - margin);
    const fitY = y => clamp(Math.round(y), margin, stage.height - menu.height - margin);

    const centerX = fitX(selection.x + (selection.width - menu.width) / 2);
    const centerY = fitY(selection.y + (selection.height - menu.height) / 2);
    const below = Math.round(selection.y + selection.height + margin);
    const above = Math.round(selection.y - menu.height - margin);

    const candidates = [
        {x: centerX, y: below},
        {x: centerX, y: above},
        {x: Math.round(selection.x + selection.width + margin), y: centerY},
        {x: Math.round(selection.x - menu.width - margin), y: centerY},
    ];

    const inflated = blocker && {
        x: blocker.x - margin,
        y: blocker.y - margin,
        width: blocker.width + margin * 2,
        height: blocker.height + margin * 2,
    };

    for (const {x, y} of candidates) {
        const rect = {x, y, width: menu.width, height: menu.height};
        const onScreen = x >= margin && y >= margin &&
            x + menu.width <= stage.width - margin &&
            y + menu.height <= stage.height - margin;
        if (onScreen && !(inflated && rectsOverlap(rect, inflated)))
            return {x, y};
    }

    // Nothing is fully clear; stay on screen below or above the selection.
    return {x: centerX, y: below + menu.height <= stage.height - margin ? below : fitY(above)};
}

function getHudRect() {
    const panel = Main.screenshotUI?._panel;
    if (!panel?.visible)
        return null;

    const extents = panel.get_transformed_extents();
    return {
        x: extents.get_x(),
        y: extents.get_y(),
        width: extents.get_width(),
        height: extents.get_height(),
    };
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y;
}

function roundedRect(cr, x, y, width, height, radius) {
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 3 / 2);
    cr.closePath();
}
