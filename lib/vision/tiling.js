// Reading a whole screen quickly: split the image into horizontal bands that
// overlap a little, recognise them in parallel, then merge the results.
//
// Each band "owns" a core strip of rows. A word is kept only from the band
// whose core contains the word's vertical centre, so words in the overlap are
// not counted twice, and words crossing a band edge are still read whole by
// the band that owns them.

/**
 * Plan the bands for an image.
 *
 * @param {number} height - image height in pixels
 * @param {object} options
 * @param {number} options.bands - how many bands (at least 1)
 * @param {number} options.overlap - extra rows read above and below each core
 * @returns {Array<{top: number, bottom: number, coreTop: number, coreBottom: number}>}
 *   top/bottom are the rows to read; coreTop/coreBottom the rows the band owns
 */
export function planBands(height, {bands, overlap}) {
    const count = Math.max(1, Math.min(bands, Math.floor(height / Math.max(1, overlap * 2)) || 1));
    const coreHeight = Math.ceil(height / count);
    const plan = [];

    for (let i = 0; i < count; i++) {
        const coreTop = i * coreHeight;
        const coreBottom = Math.min(height, (i + 1) * coreHeight);
        plan.push({
            top: Math.max(0, coreTop - overlap),
            bottom: Math.min(height, coreBottom + overlap),
            coreTop,
            coreBottom,
        });
    }
    return plan;
}

/**
 * Merge per-band words into one list in image coordinates.
 *
 * @param {Array<{band: object, words: Array<object>}>} results - in band order
 * @returns {Array<object>} words in reading order, duplicates removed
 */
export function mergeBandWords(results) {
    const merged = [];

    results.forEach(({band, words}, index) => {
        for (const word of words) {
            const y = word.y + band.top;
            const centre = y + word.height / 2;
            if (centre < band.coreTop || centre >= band.coreBottom)
                continue;
            merged.push({...word, y, lineKey: `b${index}:${word.lineKey}`});
        }
    });
    return merged;
}

/**
 * Recognise a large image band by band, in parallel.
 *
 * @param {object} provider - a vision provider (lib/vision/provider.js)
 * @param {object} pixbuf - the whole image (GdkPixbuf.Pixbuf)
 * @param {object} options - passed to provider.recognize(), plus:
 * @param {number} [options.bands] - number of bands
 * @param {number} [options.overlap] - overlap in pixels
 * @returns {Promise<Array<object>>} words in image coordinates
 */
export async function recognizeInBands(provider, pixbuf, {bands = 4, overlap = 64, ...options} = {}) {
    const width = pixbuf.get_width();
    const plan = planBands(pixbuf.get_height(), {bands, overlap});

    const results = await Promise.all(plan.map(async band => {
        const slice = pixbuf.new_subpixbuf(0, band.top, width, band.bottom - band.top);
        const [, png] = slice.save_to_bufferv('png', [], []);
        return {band, words: await provider.recognize(png, options)};
    }));

    return mergeBandWords(results);
}

/**
 * Pick a sensible band count: roughly one band per 300 rows, limited by the
 * number of CPU cores.
 *
 * @param {number} height - image height in pixels
 * @param {number} cores - available processors
 * @returns {number}
 */
export function chooseBandCount(height, cores) {
    return Math.max(1, Math.min(8, Math.ceil(height / 300), Math.floor(cores / 2)));
}
