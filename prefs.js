// Preferences window (opened from the Extensions app). This runs in its own
// GTK 4 / libadwaita process, not inside GNOME Shell.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences, gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    SEARCH_ENGINES, formatRgbaSetting, hasProgram, parseRgbaSetting,
} from './lib/common.js';
import {listTesseractLanguages, normalizeLanguageSelection} from './lib/vision/tesseract.js';
import {interpretKeyPress} from './lib/shortcutKeys.js';

export default class ScreenVisionPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const languages = await listTesseractLanguages();

        window.set_default_size(720, 640);
        window.add(this._buildGeneralPage(settings, window));
        window.add(this._buildAppearancePage(settings));
        window.add(this._buildOcrPage(settings, languages));
        window.add(this._buildSearchPage(settings));
    }

    _buildGeneralPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const missingRow = this._buildMissingToolsRow();
        if (missingRow) {
            const group = new Adw.PreferencesGroup();
            group.add(missingRow);
            page.add(group);
        }

        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcut'),
            description: _('Print Screen always opens the screenshot tool as well; ' +
                'change that in Settings › Keyboard › Keyboard Shortcuts.'),
        });
        shortcutGroup.add(this._shortcutRow(settings, 'screenshot-shortcut', window, {
            title: _('Open screenshot tool'),
            defaultLabel: _('Print Screen'),
        }));
        page.add(shortcutGroup);

        const buttonsGroup = new Adw.PreferencesGroup({
            title: _('Screenshot Buttons'),
            description: _('Extra buttons shown in the screenshot tool.'),
        });
        buttonsGroup.add(this._switchRow(settings, 'show-google-lens-button', {
            title: _('Google Lens'),
            subtitle: _('Send the selected area to Google Lens. The image is uploaded to Google.'),
        }));
        buttonsGroup.add(this._switchRow(settings, 'show-qr-button', {
            title: _('QR code scanner'),
            subtitle: _('Read QR codes and barcodes in the selected area and copy their content.'),
        }));
        page.add(buttonsGroup);

        return page;
    }

    _buildAppearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Highlighting'),
            icon_name: 'preferences-desktop-theme-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('How recognised text is highlighted in the screenshot tool.'),
        });
        page.add(group);

        group.add(this._colorRow(settings, 'highlight-fill-color', _('Fill color')));
        group.add(this._colorRow(settings, 'highlight-border-color', _('Border color')));
        group.add(this._spinRow(settings, 'highlight-padding', {
            title: _('Box padding'),
            subtitle: _('Extra room around each detected word.'),
            min: 0, max: 16, step: 1,
        }));
        group.add(this._spinRow(settings, 'highlight-radius', {
            title: _('Corner radius'),
            subtitle: _('Roundedness of the highlight shape.'),
            min: 0, max: 24, step: 1,
        }));
        group.add(this._spinRow(settings, 'highlight-border-width', {
            title: _('Border width'),
            subtitle: _('Outline thickness of each highlight box.'),
            min: 0.5, max: 4, step: 0.25, digits: 2,
        }));
        group.add(this._spinRow(settings, 'highlight-shadow-opacity', {
            title: _('Shadow opacity'),
            subtitle: _('Depth under the highlight boxes.'),
            min: 0, max: 0.5, step: 0.01, digits: 2,
        }));

        return page;
    }

    _buildOcrPage(settings, languages) {
        const page = new Adw.PreferencesPage({
            title: _('Text Recognition'),
            icon_name: 'accessories-text-editor-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Recognition'),
            description: _('Text recognition runs on the selected area using Tesseract.'),
        });
        page.add(group);

        group.add(this._switchRow(settings, 'ocr-enabled', {
            title: _('Recognise text'),
            subtitle: _('Highlight text in the selected area and offer Copy and Search.'),
        }));
        group.add(this._spinRow(settings, 'selection-confidence', {
            title: _('Minimum confidence'),
            subtitle: _('Lower values catch more text but add false positives.'),
            min: 0, max: 95, step: 1,
        }));
        group.add(this._spinRow(settings, 'selection-max-edge', {
            title: _('Maximum image size'),
            subtitle: _('Larger selections are scaled down to this many pixels. Higher is more accurate but slower.'),
            min: 1000, max: 4000, step: 100,
        }));
        group.add(this._languageRow(settings, languages));
        group.add(this._switchRow(settings, 'close-after-copy', {
            title: _('Close after copying'),
            subtitle: _('Close the screenshot tool once text is copied.'),
        }));

        return page;
    }

    _buildSearchPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Search'),
            icon_name: 'system-search-symbolic',
        });

        const searchGroup = new Adw.PreferencesGroup({title: _('Text Search')});
        page.add(searchGroup);

        const engineRow = new Adw.ComboRow({
            title: _('Search engine'),
            subtitle: _('Used by the Search button for recognised text.'),
            model: Gtk.StringList.new(SEARCH_ENGINES.map(engine => engine.name)),
        });
        const syncEngine = () => {
            const index = SEARCH_ENGINES.findIndex(e => e.id === settings.get_string('search-engine'));
            engineRow.selected = Math.max(0, index);
        };
        syncEngine();
        settings.connect('changed::search-engine', syncEngine);
        engineRow.connect('notify::selected', () => {
            settings.set_string('search-engine', SEARCH_ENGINES[engineRow.selected].id);
        });
        searchGroup.add(engineRow);

        return page;
    }

    _buildMissingToolsRow() {
        const missing = [
            {program: 'tesseract', feature: _('text recognition')},
            {program: 'zbarimg', feature: _('QR scanning')},
        ].filter(tool => !hasProgram(tool.program));

        if (missing.length === 0)
            return null;

        const row = new Adw.ActionRow({
            title: _('Missing optional tools: %s').format(missing.map(t => t.program).join(', ')),
            subtitle: _('Install them to enable %s. See the README for package names.')
                .format(missing.map(t => t.feature).join(_(' and '))),
        });
        row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
        return row;
    }

    _languageRow(settings, installed) {
        if (installed.length === 0) {
            const row = new Adw.ActionRow({
                title: _('Languages'),
                subtitle: _('Tesseract reports no installed languages.'),
            });
            row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
            return row;
        }

        const row = new Adw.ExpanderRow({
            title: _('Languages'),
            subtitle: _('Selecting fewer languages is faster and more accurate.'),
        });
        const selected = () => normalizeLanguageSelection(settings.get_strv('ocr-languages'), installed);
        const switches = new Map();

        for (const code of installed) {
            const switchRow = new Adw.SwitchRow({title: code});
            switchRow.connect('notify::active', () => {
                const current = new Set(selected());
                if (switchRow.active)
                    current.add(code);
                else
                    current.delete(code);
                settings.set_strv('ocr-languages', normalizeLanguageSelection([...current], installed));
            });
            switches.set(code, switchRow);
            row.add_row(switchRow);
        }

        // Also fixes up a switch that was turned off when it was the last
        // language: the normalized selection turns it back on.
        const sync = () => {
            const active = new Set(selected());
            for (const [code, switchRow] of switches)
                switchRow.active = active.has(code);
        };
        sync();
        settings.connect('changed::ocr-languages', sync);
        return row;
    }

    /**
     * A row showing a keyboard shortcut. Clicking it opens a dialog that
     * records the next key combination.
     */
    _shortcutRow(settings, key, window, {title, defaultLabel}) {
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to %s').format(defaultLabel),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const row = new Adw.ActionRow({
            title,
            subtitle: _('Click to change'),
            activatable: true,
        });
        row.add_suffix(reset);
        row.add_suffix(label);

        const sync = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
            reset.sensitive = settings.get_user_value(key) !== null;
        };
        sync();
        settings.connect(`changed::${key}`, sync);

        reset.connect('clicked', () => settings.reset(key));
        row.connect('activated', () => {
            this._recordShortcut(window, title, accelerator => {
                settings.set_strv(key, accelerator ? [accelerator] : []);
            });
        });
        return row;
    }

    /**
     * Ask for a key combination. Calls onDone(accelerator) with a GTK
     * accelerator string, or with '' when the user disables the shortcut.
     */
    _recordShortcut(window, title, onDone) {
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: _('Press a key combination'),
            description: _('Esc to cancel · Backspace to disable'),
        });
        const toolbar = new Adw.ToolbarView({content: status});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({
            title,
            child: toolbar,
            content_width: 440,
        });

        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const result = interpretKeyPress(keyval, keycode, state);
            switch (result.action) {
            case 'wait':
                break;
            case 'reject':
                status.description = result.reason === 'needs-modifier'
                    ? _('Add Ctrl, Alt or Super so the shortcut does not fire while typing')
                    : _('That key cannot be used as a shortcut');
                break;
            case 'cancel':
                dialog.close();
                break;
            default:
                onDone(result.accelerator ?? '');
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);

        // GNOME grabs keys like Print Screen and Super+S before any window sees
        // them. Pause those grabs while recording, as GNOME Settings does.
        const toplevel = window.get_surface();
        dialog.connect('closed', () => toplevel?.restore_system_shortcuts());
        dialog.present(window);
        toplevel?.inhibit_system_shortcuts(null);
    }

    _switchRow(settings, key, {title, subtitle}) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow(settings, key, {title, subtitle, min, max, step, digits = 0}) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            digits,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step * 10,
            }),
        });
        // GSettings converts between integer keys and the double 'value'.
        settings.bind(key, row.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _colorRow(settings, key, title) {
        const row = new Adw.ActionRow({title});
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true}),
            valign: Gtk.Align.CENTER,
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to default'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        const defaultValue = settings.get_default_value(key).deep_unpack();
        const fromSettings = () => {
            const [red, green, blue, alpha] = parseRgbaSetting(
                settings.get_string(key), parseRgbaSetting(defaultValue, [0, 0, 0, 1]));
            const rgba = new Gdk.RGBA({red, green, blue, alpha});
            if (!rgba.equal(button.rgba))
                button.rgba = rgba;
        };
        fromSettings();
        settings.connect(`changed::${key}`, fromSettings);

        button.connect('notify::rgba', () => {
            const {red, green, blue, alpha} = button.rgba;
            settings.set_string(key, formatRgbaSetting([red, green, blue, alpha]));
        });
        reset.connect('clicked', () => settings.reset(key));

        row.add_suffix(reset);
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }
}

