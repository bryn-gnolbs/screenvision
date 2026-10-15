// The agent's voice: one floating glass card that every part of the project
// uses whenever the assistant has something to say. See DESIGN.md.
//
//   think(headline)          show a pulsing "thinking" state
//   say({headline, body})    show a headline and stream the body in, word by word
//   stream(chunk)            append more text to the body (e.g. model tokens)
//   setActions([...])        chips under the text: {label, onActivate}
//   flash(text)              briefly confirm something ("Copied")
//   placeNear(rect) / placeAt(x, y), show(), hide()

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {renderTokens, tokenize} from './textReveal.js';

// Timing, in milliseconds. Words start one after another and fade in
// individually, which reads as calm streaming rather than a typewriter.
const WORD_INTERVAL_MS = 28;
const WORD_FADE_MS = 220;
const MAX_STREAM_DURATION_MS = 1600;
const APPEAR_MS = 180;
const FLASH_MS = 1400;
const MAX_WIDTH = 440;
// Keep in sync with stylesheet.css (.sv-bubble padding, chip row spacing).
const CARD_PADDING_X = 32;
const CHIP_SPACING = 8;

export const AgentBubble = GObject.registerClass(
class AgentBubble extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'sv-bubble',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
            opacity: 0,
        });
        // Scale from the centre when appearing.
        this.set_pivot_point(0.5, 0.5);

        this._tokens = [];
        this._streamStart = 0;
        this._revealId = 0;
        this._pulseId = 0;
        this._flashId = 0;
        this._headlineText = '';
        this._actionsSignature = null;
        this._chips = [];

        this._headline = new St.Label({style_class: 'sv-bubble-headline', x_expand: true});
        this._thinking = new St.Label({style_class: 'sv-bubble-thinking', text: '•••', visible: false});
        const header = new St.BoxLayout({style_class: 'sv-bubble-header'});
        header.add_child(this._headline);
        header.add_child(this._thinking);

        this._body = new St.Label({style_class: 'sv-bubble-body', visible: false});
        const text = this._body.clutter_text;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.ellipsize = Pango.EllipsizeMode.NONE;
        text.use_markup = true;

        // Chips are packed into rows by their real widths (Clutter's
        // FlowLayout would give every column the width of the widest chip).
        this._actions = new St.BoxLayout({
            style_class: 'sv-bubble-actions',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });

        this.add_child(header);
        this.add_child(this._body);
        this.add_child(this._actions);

        // Frosted glass: blur whatever is behind the card, where supported.
        try {
            this.add_effect(new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius: 28,
                brightness: 0.9,
            }));
        } catch (_e) {
            // Older or unusual setups simply get the plain translucent card.
        }

        this.connect('destroy', () => this._stopTimers());
    }

    vfunc_get_preferred_width(forHeight) {
        const [min, natural] = super.vfunc_get_preferred_width(forHeight);
        return [Math.min(min, MAX_WIDTH), Math.min(natural, MAX_WIDTH)];
    }

    /** Fade and scale in, if hidden. */
    show() {
        if (this.visible && this.opacity === 255)
            return;
        this.remove_all_transitions();
        super.show();
        this.set_scale(0.97, 0.97);
        this.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: APPEAR_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide() {
        if (!this.visible)
            return;
        this._stopTimers();
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: APPEAR_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => super.hide(),
        });
    }

    /** Show that the assistant is working on something. */
    think(headline = '') {
        this._endFlash();
        this._setHeadline(headline);
        this._clearBody();
        this._setThinking(true);
    }

    /**
     * Say something. The headline appears at once; the body streams in.
     *
     * @param {object} message
     * @param {string} [message.headline]
     * @param {string} [message.body]
     */
    say({headline = '', body = ''} = {}) {
        this._endFlash();
        this._setThinking(false);
        this._setHeadline(headline);
        this._clearBody();
        if (body)
            this.stream(body);
    }

    /** Update the headline only, without touching the body. */
    setHeadline(headline) {
        this._setThinking(false);
        this._setHeadline(headline);
    }

    /** Append text to the body; new words fade in after the ones before. */
    stream(chunk) {
        if (!chunk)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        const animate = St.Settings.get().enable_animations;
        const newTokens = tokenize(chunk);
        // Keep long messages from taking ages: shorten the gap between words.
        const interval = Math.min(WORD_INTERVAL_MS, MAX_STREAM_DURATION_MS / Math.max(1, newTokens.length));

        let next = Math.max(now, this._tokens.at(-1)?.start ?? now);
        if (this._tokens.length > 0)
            next += interval;
        for (const text of newTokens) {
            this._tokens.push({text, start: animate ? next : 0});
            next += interval;
        }

        this._body.show();
        this._startReveal();
    }

    /** The body text as plain text. */
    get bodyText() {
        return this._tokens.map(token => token.text).join('');
    }

    get headlineText() {
        return this._headlineText;
    }

    /**
     * Replace the action chips. Rebuilt only when the labels change, so it
     * can be called on every pointer movement.
     *
     * @param {Array<{label: string, onActivate: function}>} actions
     */
    setActions(actions) {
        const signature = JSON.stringify(actions.map(a => a.label));
        if (signature === this._actionsSignature)
            return;
        this._actionsSignature = signature;

        this._actions.destroy_all_children();
        this._chips = actions.map((action, index) => {
            const chip = new St.Button({
                label: action.label,
                style_class: index === 0 ? 'sv-bubble-chip sv-bubble-chip-primary' : 'sv-bubble-chip',
                can_focus: true,
            });
            chip.connect('clicked', () => action.onActivate());
            return chip;
        });

        // Greedy rows: add chips to a row until the next one would not fit.
        const available = MAX_WIDTH - CARD_PADDING_X;
        let row = null;
        let used = 0;
        for (const chip of this._chips) {
            // Measuring needs the chip on stage for its style.
            const probe = row ?? this._newChipRow();
            probe.add_child(chip);
            const [, width] = chip.get_preferred_width(-1);
            if (row && used + CHIP_SPACING + width > available) {
                row.remove_child(chip);
                row = this._newChipRow();
                row.add_child(chip);
                used = width;
            } else {
                row = probe;
                used += (used ? CHIP_SPACING : 0) + width;
            }
        }
        this._actions.visible = actions.length > 0;
    }

    _newChipRow() {
        const row = new St.BoxLayout({style_class: 'sv-bubble-chip-row'});
        this._actions.add_child(row);
        return row;
    }

    get actionLabels() {
        return (this._chips ?? []).map(chip => chip.label);
    }

    /** Briefly replace the headline with a confirmation, then restore it. */
    flash(text) {
        this._endFlash();
        this._headline.text = text;
        this._headline.visible = true;
        this._headline.add_style_pseudo_class('flash');
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLASH_MS, () => {
            this._flashId = 0;
            this._endFlash();
            return GLib.SOURCE_REMOVE;
        });
        this.show();
    }

    /** Stop a confirmation early and show the current headline again. */
    _endFlash() {
        if (this._flashId) {
            GLib.source_remove(this._flashId);
            this._flashId = 0;
        }
        this._headline.remove_style_pseudo_class('flash');
        this._headline.text = this._headlineText;
    }

    /**
     * Place the card next to a rectangle (below it if there is room, then
     * above, then beside), keeping clear of `avoid` and the screen edges.
     */
    placeNear(rect, avoid = null) {
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        const {x, y} = placeBeside(rect, {width, height}, avoid,
            {width: global.stage.width, height: global.stage.height});
        this.set_position(x, y);
    }

    _setHeadline(text) {
        this._headlineText = text;
        if (!this._flashId)
            this._headline.text = text;
        this._headline.visible = Boolean(text) || this._thinking.visible;
    }

    _setThinking(thinking) {
        this._thinking.visible = thinking;
        if (thinking && !this._pulseId) {
            // A slow breathing pulse.
            let up = false;
            const pulse = () => {
                this._thinking.ease({
                    opacity: up ? 255 : 90,
                    duration: 600,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
                up = !up;
                return GLib.SOURCE_CONTINUE;
            };
            pulse();
            this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, pulse);
        } else if (!thinking && this._pulseId) {
            GLib.source_remove(this._pulseId);
            this._pulseId = 0;
            this._thinking.remove_all_transitions();
            this._thinking.opacity = 255;
        }
    }

    _clearBody() {
        this._stopReveal();
        this._tokens = [];
        this._body.clutter_text.set_markup('');
        this._body.hide();
    }

    _startReveal() {
        if (this._revealId)
            return;
        const tick = () => {
            const {markup, done} = renderTokens(this._tokens, GLib.get_monotonic_time() / 1000, WORD_FADE_MS);
            this._body.clutter_text.set_markup(markup);
            if (done) {
                this._revealId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };
        if (tick() === GLib.SOURCE_CONTINUE)
            this._revealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, tick);
    }

    _stopReveal() {
        if (this._revealId) {
            GLib.source_remove(this._revealId);
            this._revealId = 0;
        }
    }

    _stopTimers() {
        this._stopReveal();
        this._setThinking(false);
        if (this._flashId) {
            GLib.source_remove(this._flashId);
            this._flashId = 0;
        }
    }
});

/**
 * Pick a spot for a card next to a rectangle: below, above, right, left,
 * skipping spots that leave the screen or overlap `avoid`.
 *
 * @returns {{x: number, y: number}}
 */
export function placeBeside(rect, card, avoid, stage, margin = 12) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const fitX = x => clamp(Math.round(x), margin, stage.width - card.width - margin);
    const fitY = y => clamp(Math.round(y), margin, stage.height - card.height - margin);

    const centerX = fitX(rect.x + (rect.width - card.width) / 2);
    const centerY = fitY(rect.y + (rect.height - card.height) / 2);
    const below = Math.round(rect.y + rect.height + margin);
    const above = Math.round(rect.y - card.height - margin);

    const candidates = [
        {x: centerX, y: below},
        {x: centerX, y: above},
        {x: Math.round(rect.x + rect.width + margin), y: centerY},
        {x: Math.round(rect.x - card.width - margin), y: centerY},
    ];
    const blocked = avoid && {
        x: avoid.x - margin,
        y: avoid.y - margin,
        width: avoid.width + margin * 2,
        height: avoid.height + margin * 2,
    };
    const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;

    for (const {x, y} of candidates) {
        const onScreen = x >= margin && y >= margin &&
            x + card.width <= stage.width - margin && y + card.height <= stage.height - margin;
        if (onScreen && !(blocked && overlaps({x, y, ...card}, blocked)))
            return {x, y};
    }

    // Nothing is fully clear: stay on screen, below or above the rectangle.
    return {x: centerX, y: below + card.height <= stage.height - margin ? below : fitY(above)};
}
