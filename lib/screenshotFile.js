// Saving a screenshot to ~/Pictures/Screenshots the way GNOME does
// ("Screenshot From 2026-10-15 18-22-01.png"), without touching the
// clipboard. Honours GNOME's "disable save to disk" lockdown setting.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'create_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

export function screenshotsDir() {
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir();
    return GLib.build_filenamev([pictures, 'Screenshots']);
}

export function saveToDiskAllowed() {
    try {
        const lockdown = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});
        return !lockdown.get_boolean('disable-save-to-disk');
    } catch (_e) {
        return true;
    }
}

/** "Screenshot From 2026-10-15 18-22-01" for a given time. */
export function screenshotBaseName(date) {
    const pad = n => String(n).padStart(2, '0');
    return `Screenshot From ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * Save PNG bytes as a new screenshot file.
 *
 * @param {Uint8Array} png - the image
 * @param {object} [options]
 * @param {string} [options.dir] - folder (default ~/Pictures/Screenshots)
 * @param {Date} [options.time] - used for the file name
 * @returns {Promise<string|null>} the path, or null when saving is disabled
 */
export async function saveScreenshot(png, {dir = screenshotsDir(), time = new Date()} = {}) {
    if (!saveToDiskAllowed())
        return null;

    GLib.mkdir_with_parents(dir, 0o755);
    const base = screenshotBaseName(time);
    const bytes = new GLib.Bytes(png);

    // Never overwrite: add " - 2", " - 3"... like GNOME does.
    for (let n = 1; n < 1000; n++) {
        const name = n === 1 ? `${base}.png` : `${base} - ${n}.png`;
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
        try {
            const stream = await file.create_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            await stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null);
            await stream.close_async(GLib.PRIORITY_DEFAULT, null);
            return file.get_path();
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
    }
    throw new Error('Could not find a free file name for the screenshot');
}
