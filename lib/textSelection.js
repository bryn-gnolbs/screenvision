// Live Text-style selection of recognised words: hit-testing, ranges in
// reading order, whole lines, and the shapes to highlight. Pure JavaScript,
// unit-tested in tests/run.js.
//
// Words are {x, y, width, height, text, lineKey} in screen coordinates and
// arrive in reading order, so a selection is simply a range of indices.

// Extra pixels around a word that still count as "on" it.
const HIT_PADDING = 3;
// Vertical distance counts more than horizontal when finding the nearest
// word, so dragging past the end of a line stays on that line.
const VERTICAL_WEIGHT = 3;
// Presses closer together than this (ms, px) count as double/triple clicks.
const MULTI_CLICK_MS = 400;
const MULTI_CLICK_DISTANCE = 6;

/** Index of the word under a point, or -1. */
export function wordAt(words, x, y, padding = HIT_PADDING) {
    return words.findIndex(w => x >= w.x - padding && x <= w.x + w.width + padding &&
        y >= w.y - padding && y <= w.y + w.height + padding);
}

/** Index of the word closest to a point (preferring the same line), or -1. */
export function nearestWord(words, x, y) {
    let best = -1;
    let bestDistance = Infinity;
    words.forEach((w, i) => {
        const dx = Math.max(w.x - x, 0, x - (w.x + w.width));
        const dy = Math.max(w.y - y, 0, y - (w.y + w.height));
        const distance = dx + dy * VERTICAL_WEIGHT;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    });
    return best;
}

/** [start, end] indices of the whole line containing word i. */
export function lineRange(words, i) {
    const key = words[i]?.lineKey;
    let start = i;
    let end = i;
    while (start > 0 && words[start - 1].lineKey === key)
        start--;
    while (end < words.length - 1 && words[end + 1].lineKey === key)
        end++;
    return [start, end];
}

/**
 * The words between two indices (either order), inclusive.
 *
 * @param {object[]} words
 * @param {{anchor: number, focus: number}} selection
 * @returns {object[]}
 */
export function selectedWords(words, {anchor, focus}) {
    if (anchor < 0 || focus < 0)
        return [];
    return words.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1);
}

/** One rectangle per line covering the selected words on it (for highlighting). */
export function lineHighlights(words) {
    const lines = new Map();
    for (const w of words) {
        const r = lines.get(w.lineKey);
        if (!r) {
            lines.set(w.lineKey, {x: w.x, y: w.y, right: w.x + w.width, bottom: w.y + w.height});
        } else {
            r.x = Math.min(r.x, w.x);
            r.y = Math.min(r.y, w.y);
            r.right = Math.max(r.right, w.x + w.width);
            r.bottom = Math.max(r.bottom, w.y + w.height);
        }
    }
    return [...lines.values()].map(r => ({x: r.x, y: r.y, width: r.right - r.x, height: r.bottom - r.y}));
}

/** The rectangle around some words, or null. */
export function boundingRect(words) {
    if (words.length === 0)
        return null;
    const x = Math.min(...words.map(w => w.x));
    const y = Math.min(...words.map(w => w.y));
    const right = Math.max(...words.map(w => w.x + w.width));
    const bottom = Math.max(...words.map(w => w.y + w.height));
    return {x, y, width: right - x, height: bottom - y};
}

/**
 * Counts quick repeated presses in one place: 1 = click, 2 = double, 3 = triple.
 */
export class ClickCounter {
    constructor() {
        this._last = null;
        this._count = 0;
    }

    /** Register a press at (x, y) at time ms; returns the click count. */
    press(x, y, ms) {
        const last = this._last;
        const close = last && ms - last.ms <= MULTI_CLICK_MS &&
            Math.abs(x - last.x) <= MULTI_CLICK_DISTANCE && Math.abs(y - last.y) <= MULTI_CLICK_DISTANCE;
        this._count = close ? Math.min(this._count + 1, 3) : 1;
        this._last = {x, y, ms};
        return this._count;
    }
}
