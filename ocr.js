// OCR inside the screenshot UI: runs Tesseract on the selected area, draws a
// highlight box around each recognised word and shows a Copy / Search menu.

import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {captureSelection, isSelectionMode} from './capture.js';
import {
    buildSearchUrl, clamp, hasProgram, listTesseractLanguages, logError,
    normalizeLanguageSelection, parseRgbaSetting, runCommand,
} from './lib/common.js';
import {parseTsv, wordsToText} from './lib/ocrText.js';

const DEFAULT_STYLE = {
    fill: [0.10, 0.11, 0.13, 0.34],
    border: [0.92, 0.94, 0.97, 0.34],
    shadowOpacity: 0.18,
    glow: [1.00, 1.00, 1.00, 0.07],
    radius: 6,
    padding: 3,
    borderWidth: 1.25,
};

// Tesseract page segmentation modes, tried in order until one finds words.
// Automatic layout (3) handles text on mixed backgrounds and keeps reading
// order; sparse text (11) catches scattered labels that 3 sometimes misses.
const TESSERACT_PAGE_MODES = ['3', '11'];

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

export class ScreenshotOCRController {
    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {function(string): void} showMessage - shows a toast in the screenshot UI
     */
    constructor(settings, showMessage) {
        this._settings = settings;
        this._showMessage = showMessage;
        this._overlay = null;
        this._menuLayer = null;
        this._menu = null;
        this._text = '';
        this._words = [];
        this._selectionKey = null;
        this._cancellable = null;
        this._installedLanguages = Promise.resolve(null);
        this._warnedMissingTesseract = false;

        this._reloadSettings();
        this._settings.connectObject('changed', () => {
            this._reloadSettings();
            this._overlay?.setStyle(this._style);

            if (this._config.enabled)
                this.refreshSelection(Main.screenshotUI);
            else
                this.reset();
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
    }

    /** Forget results and stop any running recognition. */
    reset() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._words = [];
        this._selectionKey = null;

        this._overlay?.setBoxes([]);
        this._hideMenu();
    }

    /** Called each time the screenshot UI opens. */
    onOpened(ui) {
        this._ensureAttached(ui);
        this._warnedMissingTesseract = false;

        // Language packs can be installed while the shell runs, so re-check.
        this._installedLanguages = listTesseractLanguages();

        if (isSelectionMode(ui))
            this.recognizeSelection(ui).catch(e => logError('OCR failed', e));
        else
            this.reset();
    }

    /** Re-position highlights while the selection rectangle moves. */
    refreshSelection(ui) {
        if (!this._overlay || !ui || !this._config.enabled || !isSelectionMode(ui)) {
            this._overlay?.setBoxes([]);
            this._hideMenu();
            return;
        }

        const selection = this._getSelection(ui);
        if (!selection || this._makeKey(selection) !== this._selectionKey) {
            // The selection changed since the last OCR run; hide stale boxes
            // until the drag ends and recognizeSelection() runs again.
            this._overlay.setBoxes([]);
            this._hideMenu();
            return;
        }

        this._overlay.set_size(global.stage.width, global.stage.height);
        this._overlay.setBoxes(this._words);
        this._showMenu(selection);
    }

    /** Run OCR on the current selection, unless it was already done. */
    async recognizeSelection(ui) {
        if (!this._config.enabled || !isSelectionMode(ui))
            return;

        if (!hasProgram('tesseract')) {
            if (!this._warnedMissingTesseract) {
                this._warnedMissingTesseract = true;
                this._showMessage(_('Install Tesseract to recognise text'));
            }
            return;
        }

        const selection = this._getSelection(ui);
        const key = this._makeKey(selection);
        if (!key)
            return;

        if (key === this._selectionKey && this._words.length > 0) {
            this.refreshSelection(ui);
            return;
        }

        this.reset();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        try {
            const capture = await captureSelection(ui);
            if (!capture || cancellable.is_cancelled())
                return;

            const {png, resizeScale} = this._prepareForOcr(capture);
            const languages = normalizeLanguageSelection(
                this._config.languages, await this._installedLanguages);

            for (const pageMode of TESSERACT_PAGE_MODES) {
                const result = await runCommand(
                    ['tesseract', 'stdin', 'stdout', '-l', languages.join('+'),
                        '--psm', pageMode, 'tsv'],
                    {input: png, cancellable});

                if (cancellable.is_cancelled())
                    return;
                if (!result.success)
                    throw new Error(result.stderr.trim() || `tesseract exited with ${result.status}`);

                this._words = parseTsv(result.stdout, {
                    scale: ui._scale * resizeScale,
                    offsetX: selection.x,
                    offsetY: selection.y,
                    minConfidence: this._config.confidence,
                });
                if (this._words.length > 0)
                    break;
            }
            this._text = wordsToText(this._words);
            this._selectionKey = key;
            this.refreshSelection(ui);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }
    }

    /** Shrink very large selections so Tesseract stays fast. */
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
            this._menu.add_child(this._makeMenuButton(_('Copy'), () => this._copyText()));
            this._menu.add_child(this._makeMenuButton(_('Search'), () => this._searchText()));
            this._menuLayer.add_child(this._menu);

            ui.insert_child_above(this._menuLayer, ui._areaSelector);
        }
    }

    _makeMenuButton(label, onClicked) {
        const button = new St.Button({
            label,
            style_class: 'ssv-text-menu-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClicked);
        return button;
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

    _makeKey(selection) {
        if (!selection)
            return null;

        return [selection.x, selection.y, selection.width, selection.height]
            .map(Math.round).join(':');
    }

    _showMenu(selection) {
        if (!this._menu || this._words.length === 0) {
            this._hideMenu();
            return;
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

    _copyText() {
        if (!this._text)
            return;

        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, this._text);
        clipboard.set_text(St.ClipboardType.PRIMARY, this._text);
        this._showMessage(_('Text copied'));

        if (this._config.closeAfterCopy)
            Main.screenshotUI?.close();
    }

    _searchText() {
        if (!this._text)
            return;

        try {
            Gio.AppInfo.launch_default_for_uri(
                buildSearchUrl(this._config.searchEngine, this._text), null);
            Main.screenshotUI?.close();
        } catch (e) {
            logError('Opening search failed', e);
            this._showMessage(_('Could not open the browser'));
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
            confidence: clamp(s.get_int('selection-confidence'), 0, 99),
            maxEdge: clamp(s.get_int('selection-max-edge'), 800, 4096),
            languages: s.get_strv('ocr-languages'),
            searchEngine: s.get_string('search-engine'),
            closeAfterCopy: s.get_boolean('close-after-copy'),
        };
    }
}

/**
 * Pick a spot for the Copy/Search menu: below the selection, then above, then
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
