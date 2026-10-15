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
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {captureRect, captureScreen, captureSelection, isSelectionMode} from './capture.js';
import {buildSearchUrl, clamp, logError, parseRgbaSetting} from './lib/common.js';
import {suggestActions} from './lib/intents.js';
import {describeSelection} from './lib/narration.js';
import {makeEntry, MemoryStore} from './lib/memory.js';
import {hasLettersOrDigits, wordsToText} from './lib/ocrText.js';
import {
    ClickCounter, boundingRect, lineHighlights, lineRange, nearestWord, selectedWords, wordAt,
} from './lib/textSelection.js';
import {ScreenContext} from './lib/screenContext.js';
import {saveScreenshot} from './lib/screenshotFile.js';
import {scanCodes} from './lib/vision/codes.js';
import {createProvider} from './lib/vision/index.js';
import {wordsToStage} from './lib/vision/provider.js';
import {chooseBandCount, recognizeInBands} from './lib/vision/tiling.js';
import {AgentBubble} from './ui/bubble.js';

const DEFAULT_STYLE = {
    fill: [0.10, 0.11, 0.13, 0.34],
    border: [0.92, 0.94, 0.97, 0.34],
    shadowOpacity: 0.18,
    glow: [1.00, 1.00, 1.00, 0.07],
    radius: 6,
    padding: 3,
    borderWidth: 1.25,
};

const MAX_ACTIONS = 5;
// Live Text selection bars: system blue, see DESIGN.md.
const SELECTION_COLOR = [0.04, 0.52, 1.0, 0.38];
const SELECTION_PADDING = 2;
// Margin added around selected words when capturing them as an image.
const TEXT_CAPTURE_MARGIN = 6;
// Pause after "Remembered" before the overlay closes.
const CONFIRM_BEFORE_CLOSE_MS = 650;
// How long the selection must rest before the bubble streams its text.
const SETTLE_MS = 400;
// How long a stand-alone message stays up.
const MESSAGE_MS = 2200;
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
        this._highlights = [];
        this._style = DEFAULT_STYLE;
    }

    setBoxes(boxes) {
        this._boxes = boxes;
        this._sync();
    }

    /** Live Text selection: one rounded bar per selected line. */
    setHighlights(rects) {
        this._highlights = rects;
        this._sync();
    }

    _sync() {
        this.visible = this._boxes.length > 0 || this._highlights.length > 0;
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

        cr.setSourceRGBA(...SELECTION_COLOR);
        for (const r of this._highlights) {
            const pad = SELECTION_PADDING;
            roundedRect(cr, r.x - pad, r.y - pad, r.width + pad * 2, r.height + pad * 2,
                Math.min(4, (r.height + pad * 2) / 2));
            cr.fill();
        }

        cr.$dispose();
    }
});

export class LiveVisionController {
    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {object} hooks
     * @param {function(): void} hooks.searchWithLens - sends the selection to Google Lens
     * @param {function(): object|null} [hooks.avoidRect] - screen area the bubble must not cover
     */
    constructor(settings, {searchWithLens, avoidRect = () => null}) {
        this._settings = settings;
        this._searchWithLens = searchWithLens;
        this._avoidRect = avoidRect;
        this._memory = new MemoryStore();
        this._source = null;
        // Live Text selection: indices into the screen's words, in reading order.
        this._textSel = null;
        this._textDragging = false;
        this._clicks = new ClickCounter();
        this._overlay = null;
        this._bubbleLayer = null;
        this._bubble = null;
        this._settleId = 0;
        this._messageId = 0;
        this._said = null;
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
        this._bubbleLayer?.destroy();
        this._bubbleLayer = null;
        this._bubble = null;
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
        this._textSel = null;
        this._textDragging = false;

        this._overlay?.setBoxes([]);
        this._overlay?.setHighlights([]);
        this._cancelSettle();
        this._cancelMessage();
        this._said = null;
        this._bubble?.hide();
    }

    /**
     * Say something short in the bubble, e.g. a confirmation or a problem.
     * Next to the selection it briefly replaces the headline; with no
     * selection it appears above the toolbar and fades away.
     */
    flash(text) {
        if (!this._bubble)
            return;

        if (this._bubble.visible && this._getSelection(Main.screenshotUI)) {
            this._bubble.flash(text);
            return;
        }

        this._cancelMessage();
        this._said = null;
        this._bubble.say({headline: text});
        this._bubble.setActions([]);
        this._bubble.show();
        const hud = this._avoidRect();
        const [, width] = this._bubble.get_preferred_width(-1);
        const [, height] = this._bubble.get_preferred_height(width);
        this._bubble.set_position(
            Math.round((global.stage.width - width) / 2),
            Math.max(12, Math.round((hud?.y ?? global.stage.height) - height - 16)));
        this._raiseBubble();
        this._messageId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MESSAGE_MS, () => {
            this._messageId = 0;
            this._bubble?.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Called each time the screenshot UI opens. */
    onOpened(ui) {
        this._source = focusedWindowInfo();
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
        const subject = this._config.enabled ? this._subject(ui) : null;
        if (!this._overlay || !subject) {
            this._overlay?.setBoxes([]);
            this._overlay?.setHighlights([]);
            this._cancelSettle();
            if (!this._messageId)
                this._bubble?.hide();
            return;
        }

        this._selected = subject.selected;
        const area = this._getSelection(ui);
        this._overlay.set_size(global.stage.width, global.stage.height);
        this._overlay.setBoxes(area ? this._context.select(area).words : []);
        this._overlay.setHighlights(subject.text ? lineHighlights(subject.selected.words) : []);
        this._updateBubble(subject.rect, false);

        // Once the selection stops moving, let the bubble speak.
        this._cancelSettle();
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this.settle(ui);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** The selection has come to rest: stream what was understood. */
    settle(ui) {
        this._cancelSettle();
        const subject = this._config.enabled ? this._subject(ui) : null;
        if (subject && this._bubble)
            this._updateBubble(subject.rect, true);
    }

    // ── Live Text selection ───────────────────────────────────────────────

    /** Index of the recognised word under a screen point, or -1. */
    wordAtPoint(x, y) {
        if (!this._config.enabled || this._context.status !== 'ready')
            return -1;
        return wordAt(this._context.words, x, y);
    }

    get hasTextSelection() {
        return this._textSel !== null;
    }

    get isTextDragging() {
        return this._textDragging;
    }

    /** Press on a word: start dragging; double-click selects the word, triple the line. */
    pointerPress(ui, x, y, timeMs) {
        const index = this.wordAtPoint(x, y);
        if (index < 0)
            return;
        const clicks = this._clicks.press(x, y, timeMs);
        if (clicks === 3) {
            const [start, end] = lineRange(this._context.words, index);
            this._textSel = {anchor: start, focus: end};
        } else {
            this._textSel = {anchor: index, focus: index};
            this._textDragging = clicks === 1;
        }
        this.refreshSelection(ui);
        if (!this._textDragging)
            this.settle(ui);
    }

    /** Dragging: extend the selection to the word nearest the pointer. */
    pointerMotion(ui, x, y) {
        if (!this._textDragging || !this._textSel)
            return;
        const words = this._context.words;
        const over = wordAt(words, x, y);
        const focus = over >= 0 ? over : nearestWord(words, x, y);
        if (focus >= 0 && focus !== this._textSel.focus) {
            this._textSel = {...this._textSel, focus};
            this.refreshSelection(ui);
        }
    }

    pointerRelease(ui) {
        if (!this._textDragging)
            return;
        this._textDragging = false;
        this.settle(ui);
    }

    /** Drop the text selection; the area selection (if any) becomes the subject again. */
    clearTextSelection(ui, refresh = true) {
        if (!this._textSel && !this._textDragging)
            return;
        this._textSel = null;
        this._textDragging = false;
        this._said = null;
        if (refresh)
            this.refreshSelection(ui);
    }

    /**
     * What the bubble, suggestions, Remember, Lens and Ctrl+C act on: the
     * selected words if there is a text selection, otherwise the area.
     *
     * @returns {{rect: object, selected: object, text: boolean}|null}
     */
    _subject(ui) {
        if (this._textSel) {
            const words = selectedWords(this._context.words, this._textSel);
            const rect = boundingRect(words);
            if (rect)
                return {rect, text: true, selected: {words, codes: [], text: wordsToText(words)}};
            this._textSel = null;
        }
        const area = this._getSelection(ui);
        return area ? {rect: area, text: false, selected: this._context.select(area)} : null;
    }

    /** Capture what the subject covers: the area, or the selected words plus a margin. */
    captureSubject(ui) {
        if (!this._textSel)
            return captureSelection(ui);
        const rect = this._subject(ui)?.rect;
        const m = TEXT_CAPTURE_MARGIN;
        return captureRect(ui, rect && {x: rect.x - m, y: rect.y - m, width: rect.width + 2 * m, height: rect.height + 2 * m});
    }

    /**
     * Read the current selection again at full detail and swap the result in.
     * Runs when the user lets go of the selection.
     */
    async recognizeSelection(ui) {
        if (!this._config.enabled || !this._checkAvailable())
            return;
        this.settle(ui);

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
            // Small QR codes read better close up, so scan the selection too.
            const [words, codes] = await Promise.all([
                this._provider.recognize(png, {
                    languages: this._config.languages,
                    minConfidence: this._config.confidence,
                    cancellable,
                }),
                scanCodes(capture.png, {cancellable}),
            ]);
            if (cancellable.is_cancelled())
                return;

            this._context.setRefined(selection, wordsToStage(words, {
                scale: ui._scale * resizeScale,
                offsetX: selection.x,
                offsetY: selection.y,
            }), wordsToStage(codes, {
                scale: ui._scale,
                offsetX: selection.x,
                offsetY: selection.y,
            }));
            this.refreshSelection(ui);
            this.settle(ui);
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

    /**
     * Enter: keep this moment. Saves the selection to ~/Pictures/Screenshots
     * and, unless turned off, adds what was seen to the memory log for the
     * assistant. The clipboard is left alone.
     */
    async remember(ui) {
        const selection = this._subject(ui)?.rect ?? null;
        const capture = selection ? await this.captureSubject(ui) : null;
        if (!capture) {
            this.flash(_('Select something to remember'));
            return;
        }

        try {
            const image = await saveScreenshot(capture.png);
            let entry = null;
            if (this._config.remember) {
                entry = await this._memory.remember(makeEntry({
                    ...this._selected,
                    image,
                    source: this._source,
                    rect: selection,
                }));
            }
            if (!entry)
                this.flash(_('Saved to Screenshots'));
            else
                this.flash(entry.hidden.length ? _('Remembered, passwords and keys hidden') : _('Remembered'));
        } catch (e) {
            logError('Remembering failed', e);
            this.flash(_('Could not save: %s').format(e.message));
            return;
        }

        // Let the confirmation register before the overlay goes away.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_BEFORE_CLOSE_MS, () => {
            ui.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Ctrl+C: copy the selected text, or the image if there is no text. */
    async copySelection(ui) {
        if (this._selected.text) {
            this._copy(this._selected.text, _('Text copied'), this._config.closeAfterCopy);
            return;
        }

        const capture = this._subject(ui) ? await this.captureSubject(ui) : null;
        if (!capture)
            return;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png',
            new GLib.Bytes(capture.png));
        this.flash(_('Image copied'));
    }

    _checkAvailable() {
        if (this._provider.isAvailable())
            return true;

        if (!this._warnedUnavailable) {
            this._warnedUnavailable = true;
            this.flash(_('Install %s to recognise text').format(this._provider.name));
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

        if (!this._bubbleLayer) {
            this._bubbleLayer = new St.Widget({reactive: false});
            this._bubbleLayer.add_constraint(new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            this._bubble = new AgentBubble();
            this._bubbleLayer.add_child(this._bubble);
            ui.insert_child_above(this._bubbleLayer, ui._areaSelector);
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

    /**
     * Update the bubble for a selection. While the selection moves only the
     * headline and actions change (instantly); once it settles the text
     * streams in. Repeating the same message does not re-animate it.
     */
    _updateBubble(selection, settled) {
        this._cancelMessage();
        const reading = this._context.status === 'reading' && this._selected.words.length === 0;
        const narration = describeSelection(this._selected, {reading, textSelection: this._textSel !== null, _});

        // "Remember" always comes first: it is what Enter does.
        this._bubble.setActions([
            {label: _('Remember'), onActivate: () => this.remember(Main.screenshotUI).catch(e => logError('Remembering failed', e))},
            ...suggestActions(this._selected)
                .slice(0, MAX_ACTIONS - 1)
                .map(suggestion => ({
                    label: this._labelFor(suggestion),
                    onActivate: () => this._runAction(suggestion),
                })),
        ]);

        const key = `${narration.headline}\n${narration.body}`;
        if (narration.thinking) {
            if (this._said !== 'thinking')
                this._bubble.think(narration.headline);
            this._said = 'thinking';
        } else if (settled) {
            if (this._said !== key)
                this._bubble.say(narration);
            this._said = key;
        } else if (this._said !== key) {
            // Moving: show the new headline at once, hold the text back.
            if (this._said !== `${narration.headline}\n`)
                this._bubble.say({headline: narration.headline});
            this._said = `${narration.headline}\n`;
        }

        this._bubble.show();
        this._bubble.placeNear(selection, this._avoidRect());
        this._raiseBubble();
    }

    _raiseBubble() {
        this._bubbleLayer?.get_parent()?.set_child_above_sibling(this._bubbleLayer, null);
    }

    _cancelSettle() {
        if (this._settleId) {
            GLib.source_remove(this._settleId);
            this._settleId = 0;
        }
    }

    _cancelMessage() {
        if (this._messageId) {
            GLib.source_remove(this._messageId);
            this._messageId = 0;
        }
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
        this.flash(message);

        if (closeAfter)
            Main.screenshotUI?.close();
    }

    _openUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
            Main.screenshotUI?.close();
        } catch (e) {
            logError(`Opening ${uri} failed`, e);
            this.flash(_('Could not open %s').format(uri));
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
            remember: s.get_boolean('remember-enabled'),
            confidence: clamp(s.get_int('selection-confidence'), 0, 99),
            maxEdge: clamp(s.get_int('selection-max-edge'), 800, 4096),
            languages: s.get_strv('ocr-languages'),
            searchEngine: s.get_string('search-engine'),
            closeAfterCopy: s.get_boolean('close-after-copy'),
        };
    }
}


function roundedRect(cr, x, y, width, height, radius) {
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 3 / 2);
    cr.closePath();
}

/** App name and window title of the window that had focus, or null. */
function focusedWindowInfo() {
    const window = global.display.focus_window;
    if (!window)
        return null;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return {app: app?.get_name() ?? window.get_wm_class() ?? '', title: window.get_title() ?? ''};
}
