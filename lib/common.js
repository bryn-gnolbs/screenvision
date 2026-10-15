// Helpers shared by the shell side (extension.js, live.js) and the
// preferences window (prefs.js). Only import gi:// modules here: prefs.js runs
// in a separate GTK process and cannot load GNOME Shell's own modules.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');

export const LOG_PREFIX = '[ScreenVision]';

export const SEARCH_ENGINES = [
    {id: 'google', name: 'Google', url: 'https://www.google.com/search?q='},
    {id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q='},
    {id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q='},
    {id: 'kagi', name: 'Kagi', url: 'https://kagi.com/search?q='},
];

export function buildSearchUrl(engineId, query) {
    const engine = SEARCH_ENGINES.find(e => e.id === engineId) ?? SEARCH_ENGINES[0];
    return engine.url + encodeURIComponent(query);
}

export function logError(context, error) {
    console.error(`${LOG_PREFIX} ${context}: ${error?.message ?? error}`);
}

export function hasProgram(name) {
    return GLib.find_program_in_path(name) !== null;
}

/**
 * Run a command without blocking the shell.
 *
 * @param {string[]} argv - program and arguments
 * @param {object} [options]
 * @param {Uint8Array|null} [options.input] - bytes written to the process's stdin
 * @param {Gio.Cancellable|null} [options.cancellable] - kills the process when cancelled
 * @param {Object<string, string>} [options.env] - extra environment variables
 * @returns {Promise<{success: boolean, status: number, stdout: string, stderr: string}>}
 */
export async function runCommand(argv, {input = null, cancellable = null, env = null} = {}) {
    let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
    if (input)
        flags |= Gio.SubprocessFlags.STDIN_PIPE;

    const launcher = new Gio.SubprocessLauncher({flags});
    for (const [name, value] of Object.entries(env ?? {}))
        launcher.setenv(name, value, true);
    const proc = launcher.spawnv(argv);
    const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;

    try {
        const [stdout, stderr] = await proc.communicate_async(
            input ? new GLib.Bytes(input) : null,
            cancellable
        );
        const decoder = new TextDecoder();
        return {
            success: proc.get_successful(),
            status: proc.get_exit_status(),
            stdout: stdout ? decoder.decode(stdout.toArray()) : '',
            stderr: stderr ? decoder.decode(stderr.toArray()) : '',
        };
    } finally {
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
}

/**
 * Write bytes to a file only the current user can read.
 *
 * Files live in $XDG_RUNTIME_DIR (a per-user tmpfs, mode 0700) rather than
 * the shared /tmp, under unguessable names. The caller deletes the file.
 *
 * @param {Uint8Array} bytes - file contents
 * @param {string} suffix - file extension including the dot, e.g. '.png'
 * @returns {string} path of the new file
 */
export function writePrivateTempFile(bytes, suffix) {
    const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'screenvision']);
    GLib.mkdir_with_parents(dir, 0o700);

    const path = GLib.build_filenamev([dir, `${GLib.uuid_string_random()}${suffix}`]);
    GLib.file_set_contents(path, bytes);
    return path;
}

export function deleteFile(path) {
    if (!path)
        return;

    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            logError(`Could not delete ${path}`, e);
    }
}

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Parse an 'r,g,b,a' settings string (components 0..1).
 *
 * @param {string} value - the stored string
 * @param {number[]} fallback - returned when value is malformed
 * @returns {number[]}
 */
export function parseRgbaSetting(value, fallback) {
    const parts = String(value).split(',').map(Number.parseFloat);
    if (parts.length !== 4 || !parts.every(Number.isFinite))
        return fallback;

    return parts.map(part => clamp(part, 0, 1));
}

export function formatRgbaSetting([red, green, blue, alpha]) {
    return [red, green, blue, alpha].map(part => part.toFixed(3)).join(',');
}
