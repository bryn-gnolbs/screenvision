// Vision provider backed by the Tesseract OCR command-line tool. Runs fully
// on this computer.

import {hasProgram, logError, runCommand} from '../common.js';
import {parseTsv} from '../ocrText.js';

export const DEFAULT_OCR_LANGUAGES = ['eng'];

// 'osd' is Tesseract's orientation/script detector, not a readable language.
const HIDDEN_LANGUAGES = new Set(['osd']);
const LANGUAGE_CODE_RE = /^[A-Za-z0-9_]+$/;

// Page segmentation modes, tried in order until one finds words. Automatic
// layout (3) handles text on mixed backgrounds and keeps reading order;
// sparse text (11) catches scattered labels that 3 sometimes misses.
const PAGE_MODES = ['3', '11'];

export class TesseractProvider {
    constructor() {
        this.id = 'tesseract';
        this.name = 'Tesseract';
        // Large images are faster split into bands read in parallel (tiling.js).
        this.prefersBands = true;
        this._installedLanguages = Promise.resolve(null);
    }

    isAvailable() {
        return hasProgram('tesseract');
    }

    /** Language packs can be installed while the shell runs, so re-check. */
    prepare() {
        this._installedLanguages = listTesseractLanguages();
        return this._installedLanguages.then(() => {});
    }

    /**
     * @param {Uint8Array} png - the image
     * @param {object} [options] - see provider.js; additionally:
     * @param {boolean} [options.singleThread] - limit Tesseract to one thread,
     *   for running several recognitions in parallel (see tiling.js)
     * @param {boolean} [options.adaptiveThreshold] - use local (Sauvola)
     *   thresholding. Needed for whole screens, where light and dark areas
     *   mix and a single global threshold loses text.
     */
    async recognize(png, {
        languages = [], minConfidence = 0, cancellable = null,
        singleThread = false, adaptiveThreshold = false,
    } = {}) {
        const extra = adaptiveThreshold ? ['-c', 'thresholding_method=2'] : [];
        const selected = normalizeLanguageSelection(languages, await this._installedLanguages);

        for (const pageMode of PAGE_MODES) {
            const result = await runCommand(
                ['tesseract', 'stdin', 'stdout', '-l', selected.join('+'), '--psm', pageMode, ...extra, 'tsv'],
                {input: png, cancellable, env: singleThread ? {OMP_THREAD_LIMIT: '1'} : null});

            if (!result.success)
                throw new Error(result.stderr.trim() || `tesseract exited with ${result.status}`);

            const words = parseTsv(result.stdout, {minConfidence});
            if (words.length > 0)
                return words;
        }
        return [];
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
        if (inList && LANGUAGE_CODE_RE.test(line) && !HIDDEN_LANGUAGES.has(line))
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
