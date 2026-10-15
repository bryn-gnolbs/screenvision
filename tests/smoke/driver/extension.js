// Scripted end-to-end check, loaded next to ScreenVision inside a
// headless GNOME Shell (see run.sh). It puts text on screen, opens the
// screenshot UI, selects the text and reports what the extension did as
// "SMOKE <name> <json>" lines in the shell log.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'screenvision@genolabs.net';
const OUT_DIR = GLib.getenv('SSV_SMOKE_OUT');
const SAMPLE_TEXT = 'ScreenVision reads this 2026';

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const report = (name, value) => console.log(`SMOKE ${name} ${JSON.stringify(value)}`);
const check = (name, ok, detail) => report(ok ? `PASS ${name}` : `FAIL ${name}`, detail);

async function saveScreenshot(name) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([OUT_DIR, name]));
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Promise((resolve, reject) => {
        new Shell.Screenshot().screenshot(false, stream, (shooter, result) => {
            try {
                resolve(shooter.screenshot_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    stream.close(null);
}

// Move the selection rectangle as a drag would, without releasing.
function moveSelection(ui, x1, y1, x2, y2) {
    const selector = ui._areaSelector;
    [selector._startX, selector._startY, selector._lastX, selector._lastY] = [x1, y1, x2, y2];
    selector._updateSelectionRect();
}

function menuLabels(live) {
    return live._menu.get_children().map(child => child.label ?? child.text);
}

// Created once, early: key presses sent right after creating a virtual
// device can be dropped before the device is fully set up.
let keyboard = null;

async function pressKeys(keyvals) {
    const now = () => GLib.get_monotonic_time();
    for (const keyval of keyvals)
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
    for (const keyval of [...keyvals].reverse())
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
    await sleep(800);
}

async function run() {
    keyboard = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    await sleep(2500);
    const info = Main.extensionManager.lookup(UUID);
    check('extension enabled', info?.state === 1, info?.error ?? info?.state);
    const ext = () => Main.extensionManager.lookup(UUID).stateObj;

    const label = new St.Label({
        text: SAMPLE_TEXT,
        style: 'font-size: 40px; color: black; background-color: white; padding: 24px;',
    });
    Main.layoutManager.uiGroup.add_child(label);
    label.set_position(300, 300);

    // A QR image (link + Wi-Fi codes) lower on the screen.
    const qrFile = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'qr-codes.png']);
    const qrImage = new St.Widget({
        style: `background-image: url("file://${qrFile}"); background-size: 620px 260px;`,
        width: 620,
        height: 260,
    });
    Main.layoutManager.uiGroup.add_child(qrImage);
    qrImage.set_position(300, 560);
    await sleep(500);

    const ui = Main.screenshotUI;
    await ui.open();
    ui._selectionButton.checked = true;
    const live = () => ext()._live;

    // The whole screen is read in the background right after opening.
    for (let i = 0; i < 50 && live().context.status !== 'ready'; i++)
        await sleep(100);
    check('whole screen read on open', live().context.status === 'ready' && live().context.words.length > 0,
        {status: live().context.status, words: live().context.words.length, codes: live().context.codes.length});

    // Live: while dragging (no release yet) the selection already has its text.
    moveSelection(ui, 280, 280, 1200, 420);
    check('text is live while dragging', live()._selected.text === SAMPLE_TEXT, live()._selected.text);
    check('suggestions shown while dragging', live()._menu.visible, menuLabels(live()));
    check('suggestions offer copy, search and lens',
        ['Copy', 'Search', 'Lens'].every(l => menuLabels(live()).includes(l)), menuLabels(live()));

    // Release: the selection is read again at full detail.
    ui._areaSelector.emit('drag-ended');
    for (let i = 0; i < 30 && !live().context.hasRefined(live().selectionRect(ui)); i++)
        await sleep(100);
    check('sharper read after release', live().context.hasRefined(live().selectionRect(ui)) &&
        live()._selected.text === SAMPLE_TEXT, live()._selected.text);
    check('lens button shown', ext()._lensButton.visible);
    check('qr button in side column', ext()._qrButton.get_parent() === ext()._sideBox);
    await saveScreenshot('live-text.png');

    await ext()._scanQrCode(ui);
    check('qr reports no code', ext()._toast?.text === 'No QR code found in the selection', ext()._toast?.text);

    live()._runAction({kind: 'copy-text', value: live()._selected.text});
    const clip = await new Promise(resolve =>
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => resolve(text)));
    check('copy puts text on clipboard', clip === SAMPLE_TEXT, clip);

    // QR codes are found automatically and turned into suggestions.
    moveSelection(ui, 290, 550, 940, 830);
    check('qr codes detected automatically', live()._selected.codes.length === 2,
        live()._selected.codes.map(c => c.data));
    check('qr suggestions offered', menuLabels(live()).includes('Open example.com') &&
        menuLabels(live()).includes('Copy Wi-Fi password (HomeNet)'), menuLabels(live()));
    await saveScreenshot('live-qr.png');

    ui.close();
    await sleep(800);

    const panelRows = () => ui._panel.get_children().map(child =>
        child === ui._typeButtonContainer ? 'type' : child === ui._bottomRowContainer ? 'bottom' : 'other');

    Main.extensionManager.disableExtension(UUID);
    await sleep(500);
    check('disable restores toolbar', JSON.stringify(panelRows()) === '["type","bottom"]', panelRows());
    check('disable restores open()', !Object.hasOwn(ui, 'open') || ui.open === Object.getPrototypeOf(ui).open);
    check('disable removes lens button', ui._showPointerButtonContainer.get_n_children() === 1);

    Main.extensionManager.enableExtension(UUID);
    await sleep(500);
    check('re-enable works', Main.extensionManager.lookup(UUID).state === 1);

    // Custom shortcut: Print (GNOME's own) registers nothing extra; a new
    // combination is registered and actually opens the screenshot tool.
    // GNOME applies a changed shortcut on its next idle cycle, hence the waits.
    const settings = ext()._settings;
    check('default Print shortcut left to GNOME', !ext()._shortcut.registered);
    await pressKeys([Clutter.KEY_Print]);
    check('Print still opens screenshot tool', ui.visible);
    ui.close();
    await sleep(800);

    settings.set_strv('screenshot-shortcut', ['<Shift><Super>s']);
    check('custom shortcut registered', ext()._shortcut.registered);
    await sleep(300);
    await pressKeys([Clutter.KEY_Super_L, Clutter.KEY_Shift_L, Clutter.KEY_s]);
    check('Super+Shift+S opens screenshot tool', ui.visible);
    ui.close();
    await sleep(800);

    settings.set_strv('screenshot-shortcut', ['<Control><Alt>p']);
    await sleep(300);
    await pressKeys([Clutter.KEY_Control_L, Clutter.KEY_Alt_L, Clutter.KEY_p]);
    check('changing the shortcut takes effect', ui.visible);
    ui.close();
    await sleep(800);

    settings.set_strv('screenshot-shortcut', []);
    check('empty shortcut unregisters', !ext()._shortcut.registered);
    settings.set_strv('screenshot-shortcut', ['<Shift><Super>s']);
    Main.extensionManager.disableExtension(UUID);
    await sleep(300);
    check('disable removes custom shortcut', !Main.wm._allowedKeybindings?.['screenshot-shortcut']);
    Main.extensionManager.enableExtension(UUID);
    await sleep(300);
    settings.reset('screenshot-shortcut');

    ext()._settings.set_boolean('show-qr-button', false);
    check('hiding qr restores toolbar', JSON.stringify(panelRows()) === '["type","bottom"]', panelRows());
    ext()._settings.set_boolean('show-qr-button', true);
    check('showing qr wraps toolbar', JSON.stringify(panelRows()) === '["other"]', panelRows());
}

// GNOME briefly disables and re-enables extensions loaded after one that is
// toggled (including this driver), so make sure the script runs only once.
let started = false;

export default class SmokeDriver extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        run()
            .catch(e => report('FAIL driver crashed', `${e.message}\n${e.stack}`))
            .finally(() => report('done', true));
    }

    disable() {
    }
}
