// ScreenVision's memory: a private, local log of what the user chose to
// remember (Enter in the overlay). Each entry records what was seen - text,
// links, emails, codes, where it came from - plus the saved image. Later the
// assistant (and its semantic database) ingests this log; until then it is
// simply kept, never sent anywhere.
//
// Stored as JSON Lines in $XDG_DATA_HOME/screenvision/memories/entries.jsonl,
// in a directory only the user can read.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {findEmails, findUrls, isWebUrl} from './intents.js';

Gio._promisify(Gio.File.prototype, 'append_to_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const ENTRIES_FILE = 'entries.jsonl';

export function defaultMemoryDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'screenvision', 'memories']);
}

/**
 * Build a memory entry from what was selected.
 *
 * @param {object} what
 * @param {string} [what.text] - recognised text
 * @param {Array<{type: string, data: string}>} [what.codes] - QR/barcodes
 * @param {string|null} [what.image] - path of the saved screenshot
 * @param {{app: string, title: string}|null} [what.source] - focused window
 * @param {{x: number, y: number, width: number, height: number}} [what.rect]
 * @param {Date} [what.time]
 * @returns {object}
 */
export function makeEntry({text = '', codes = [], image = null, source = null, rect = null, time = new Date()}) {
    const codeLinks = codes.map(code => code.data).filter(isWebUrl);
    return {
        id: GLib.uuid_string_random(),
        time: time.toISOString(),
        text,
        links: [...new Set([...codeLinks, ...findUrls(text)])],
        emails: findEmails(text),
        codes: codes.map(({type, data}) => ({type, data})),
        image,
        source,
        rect: rect && {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
        },
    };
}

export class MemoryStore {
    /** @param {string} [dir] - where to keep the log (tests use a temp dir) */
    constructor(dir = defaultMemoryDir()) {
        this._dir = dir;
    }

    get directory() {
        return this._dir;
    }

    /**
     * Append an entry to the log.
     *
     * @param {object} entry - from makeEntry()
     * @returns {Promise<object>} the entry
     */
    async remember(entry) {
        GLib.mkdir_with_parents(this._dir, 0o700);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, ENTRIES_FILE]));
        const stream = await file.append_to_async(Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, null);
        const line = new TextEncoder().encode(`${JSON.stringify(entry)}\n`);
        await stream.write_bytes_async(new GLib.Bytes(line), GLib.PRIORITY_DEFAULT, null);
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
        return entry;
    }

    /** @returns {Promise<object[]>} all entries, oldest first */
    async list() {
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, ENTRIES_FILE]));
        let contents;
        try {
            [contents] = await file.load_contents_async(null);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return [];
            throw e;
        }

        return new TextDecoder().decode(contents).split('\n').filter(Boolean).flatMap(line => {
            try {
                return [JSON.parse(line)];
            } catch (_e) {
                return [];
            }
        });
    }

    /**
     * Forget everything: delete the log. Saved screenshots in the user's
     * Pictures folder are ordinary files and are left alone.
     */
    forgetAll() {
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, ENTRIES_FILE]));
        try {
            file.delete(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
        }
    }
}
