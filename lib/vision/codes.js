// Finding QR codes and barcodes, with their positions, using zbar's zbarimg.
// A full screen takes well under 100 ms, so ScreenVision scans every screen
// it opens on and offers codes automatically.

import {deleteFile, hasProgram, runCommand, writePrivateTempFile} from '../common.js';

export function codesAvailable() {
    return hasProgram('zbarimg');
}

/**
 * Scan a PNG for codes.
 *
 * @param {Uint8Array} png - the image
 * @param {object} [options]
 * @param {object} [options.cancellable] - Gio.Cancellable
 * @returns {Promise<Array<object>>} codes in image pixels, see parseZbarXml
 */
export async function scanCodes(png, {cancellable = null} = {}) {
    if (!codesAvailable())
        return [];

    // zbarimg only reads files, so use a private temporary one.
    const path = writePrivateTempFile(png, '.png');
    try {
        // Exit status 4 means "no code found", which is not an error.
        const result = await runCommand(['zbarimg', '--quiet', '--xml', path], {cancellable});
        return parseZbarXml(result.stdout);
    } finally {
        deleteFile(path);
    }
}

/**
 * Parse `zbarimg --xml` output.
 *
 * @param {string} xml - zbarimg output
 * @returns {Array<{type: string, data: string, x: number, y: number,
 *   width: number, height: number}>} one entry per code; the box encloses
 *   the code's corner points
 */
export function parseZbarXml(xml) {
    const codes = [];
    const symbolRe = /<symbol type='([^']*)'[^>]*>\s*<polygon points='([^']*)'\s*\/>\s*<data><!\[CDATA\[([\s\S]*?)\]\]><\/data>/g;

    for (const [, type, points, data] of xml.matchAll(symbolRe)) {
        const coords = points.trim().split(/\s+/).map(pair => pair.split(',').map(Number));
        const xs = coords.map(([x]) => x);
        const ys = coords.map(([, y]) => y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        codes.push({type, data, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y});
    }
    return codes;
}
