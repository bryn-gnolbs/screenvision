// Turning Tesseract's TSV output into word boxes and plain text. Pure
// JavaScript with no imports, so tests/run.js can exercise it under plain gjs.

// TSV columns: level page_num block_num par_num line_num word_num
//              left top width height conf text
const WORD_LEVEL = 5;

/**
 * Parse Tesseract TSV into word boxes in stage coordinates.
 *
 * @param {string} tsv - output of `tesseract ... tsv`
 * @param {object} options
 * @param {number} options.scale - OCR-image pixels per stage pixel
 * @param {number} options.offsetX - stage x of the OCR image's left edge
 * @param {number} options.offsetY - stage y of the OCR image's top edge
 * @param {number} options.minConfidence - words below this (0-100) are dropped
 * @returns {Array<{x: number, y: number, width: number, height: number,
 *   text: string, lineKey: string}>} words in Tesseract's reading order
 */
export function parseTsv(tsv, {scale = 1, offsetX = 0, offsetY = 0, minConfidence = 0} = {}) {
    const words = [];

    for (const line of tsv.split('\n').slice(1)) {
        const columns = line.trimEnd().split('\t');
        if (columns.length < 12)
            continue;

        const level = Number.parseInt(columns[0], 10);
        const confidence = Number.parseFloat(columns[10]);
        const text = columns.slice(11).join('\t').trim();
        if (level !== WORD_LEVEL || !text || confidence < minConfidence)
            continue;

        const [left, top, width, height] = columns.slice(6, 10).map(n => Number.parseInt(n, 10));
        words.push({
            x: offsetX + left / scale,
            y: offsetY + top / scale,
            width: width / scale,
            height: height / scale,
            text,
            // Words sharing block, paragraph and line numbers sit on one line.
            lineKey: columns.slice(1, 5).join(':'),
        });
    }

    return words;
}

/**
 * True if a word contains at least one letter or digit. Used to drop the
 * symbol-only "words" OCR finds in icons and wallpapers.
 *
 * @param {{text: string}} word
 * @returns {boolean}
 */
export function hasLettersOrDigits({text}) {
    return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Join words into text: spaces within a line, newlines between lines.
 *
 * Tesseract already emits words in reading order, so this keeps that order
 * instead of guessing line breaks from box positions.
 *
 * @param {Array<{text: string, lineKey: string}>} words - from parseTsv
 * @returns {string}
 */
export function wordsToText(words) {
    const lines = [];
    let currentKey = null;

    for (const word of words) {
        if (word.lineKey !== currentKey) {
            lines.push([]);
            currentKey = word.lineKey;
        }
        lines[lines.length - 1].push(word.text);
    }

    return lines.map(line => line.join(' ')).join('\n');
}
