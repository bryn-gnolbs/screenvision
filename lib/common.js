// Helpers shared by the shell side (extension.js, ocr.js) and the
// preferences window (prefs.js). Only import gi:// modules here: prefs.js runs
// in a separate GTK process and cannot load GNOME Shell's own modules.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');

export const LOG_PREFIX = '[ScreenVision]';

export const DEFAULT_OCR_LANGUAGES = ['eng'];

// 'osd' is Tesseract's orientation/script detector, not a readable language.
const HIDDEN_TESSERACT_LANGUAGES = new Set(['osd']);
const LANGUAGE_CODE_RE = /^[A-Za-z0-9_]+$/;

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
 * @returns {Promise<{success: boolean, status: number, stdout: string, stderr: string}>}
 */
export async function runCommand(argv, {input = null, cancellable = null} = {}) {
    let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
    if (input)
        flags |= Gio.SubprocessFlags.STDIN_PIPE;

    const proc = Gio.Subprocess.new(argv, flags);
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

/**
 * Parse `tesseract --list-langs`. Tesseract 5 prints to stdout, older
 * versions to stderr, so callers pass both.
 *
 * @param {string} output - combined command output
 * @returns {string[]} sorted language codes
 */
export function parseTesseractLanguages(output) {
    const languages = [];
    let inList = false;

    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('List of available languages')) {
            inList = true;
            continue;
        }
        if (inList && LANGUAGE_CODE_RE.test(line) && !HIDDEN_TESSERACT_LANGUAGES.has(line))
            languages.push(line);
    }

    return [...new Set(languages)].sort();
}

/**
 * Ask Tesseract which languages it has data for. This honours
 * TESSDATA_PREFIX and distro-specific tessdata locations.
 *
 * @returns {Promise<string[]>} installed language codes, empty if unavailable
 */
export async function listTesseractLanguages() {
    if (!hasProgram('tesseract'))
        return [];

    try {
        const {stdout, stderr} = await runCommand(['tesseract', '--list-langs']);
        return parseTesseractLanguages(`${stdout}\n${stderr}`);
    } catch (e) {
        logError('Listing Tesseract languages failed', e);
        return [];
    }
}

/**
 * Clean up the user's language choice: drop invalid or uninstalled codes and
 * duplicates, and always return at least one language.
 *
 * @param {string[]} languages - codes from settings
 * @param {string[]|null} installed - codes Tesseract has, or null if unknown
 * @returns {string[]}
 */
export function normalizeLanguageSelection(languages, installed = null) {
    const available = installed?.length > 0 ? new Set(installed) : null;
    const result = [];

    for (const language of Array.isArray(languages) ? languages : []) {
        const code = String(language).trim();
        if (!LANGUAGE_CODE_RE.test(code) || result.includes(code))
            continue;
        if (available && !available.has(code))
            continue;
        result.push(code);
    }

    if (result.length > 0)
        return result;

    const fallback = DEFAULT_OCR_LANGUAGES.find(code => !available || available.has(code));
    if (fallback)
        return [fallback];

    return available ? [installed[0]] : [...DEFAULT_OCR_LANGUAGES];
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
