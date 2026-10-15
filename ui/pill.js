// The slim glass pill at the bottom of the screen: everything ScreenVision's
// overlay needs that can't live in the bubble. See DESIGN.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const BOTTOM_MARGIN = 32;
// How far the pill fades when the selection runs underneath it.
const YIELD_OPACITY = 70;
const YIELD_MARGIN = 8;

export const VisionPill = GObject.registerClass(
class VisionPill extends St.BoxLayout {
    /**
     * @param {object} actions
     * @param {function(): void} actions.onWholeScreen - select the whole screen
     * @param {function(): void} actions.onClose - close the overlay
     */
    _init({onWholeScreen, onClose}) {
        super._init({
            style_class: 'sv-pill',
            reactive: true,
            visible: false,
        });

        const wholeScreenBox = new St.BoxLayout({style_class: 'sv-pill-button-box'});
        wholeScreenBox.add_child(new St.Icon({icon_name: 'view-fullscreen-symbolic', style_class: 'sv-pill-icon'}));
        wholeScreenBox.add_child(new St.Label({text: _('Whole screen'), y_align: Clutter.ActorAlign.CENTER}));
        const wholeScreen = new St.Button({
            style_class: 'sv-pill-button',
            can_focus: true,
            accessible_name: _('Select the whole screen'),
            child: wholeScreenBox,
        });
        wholeScreen.connect('clicked', () => onWholeScreen());

        this._hint = new St.Label({
            style_class: 'sv-pill-hint',
            text: _('Drag to select  ·  ↵ Remember  ·  Esc to close'),
            y_align: Clutter.ActorAlign.CENTER,
        });

        const close = new St.Button({
            style_class: 'sv-pill-button sv-pill-close',
            can_focus: true,
            accessible_name: _('Close'),
            child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'sv-pill-icon'}),
        });
        close.connect('clicked', () => onClose());

        this.add_child(wholeScreen);
        this.add_child(this._hint);
        this.add_child(close);

        // Stay centred at the bottom of the primary monitor as the size changes.
        this.connect('notify::width', () => this._reposition());
        this.connect('notify::height', () => this._reposition());
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.set_position(
            Math.round(monitor.x + (monitor.width - this.width) / 2),
            Math.round(monitor.y + monitor.height - this.height - BOTTOM_MARGIN));
    }

    /**
     * Fade back when the selection runs underneath, so the selection and its
     * handles stay visible; come back when it moves away.
     *
     * @param {{x: number, y: number, width: number, height: number}|null} selection
     */
    yieldTo(selection) {
        const rect = this.rect;
        const overlapping = Boolean(rect && selection) &&
            selection.x < rect.x + rect.width + YIELD_MARGIN &&
            selection.x + selection.width > rect.x - YIELD_MARGIN &&
            selection.y < rect.y + rect.height + YIELD_MARGIN &&
            selection.y + selection.height > rect.y - YIELD_MARGIN;
        const opacity = overlapping ? YIELD_OPACITY : 255;
        if (this._targetOpacity === opacity)
            return;
        this._targetOpacity = opacity;
        this.ease({opacity, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /** Screen rectangle the pill covers, for keeping the bubble clear of it. */
    get rect() {
        if (!this.visible)
            return null;
        const [x, y] = this.get_transformed_position();
        return {x, y, width: this.width, height: this.height};
    }
});
