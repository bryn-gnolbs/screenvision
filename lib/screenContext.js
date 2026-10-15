// Everything ScreenVision knows about the screen currently shown in the
// overlay: recognised words and codes, in screen (stage) coordinates. The UI
// asks it what lies inside the selection on every mouse movement, so lookups
// are plain in-memory filtering. Later this is what the assistant receives.

import {wordsToText} from './ocrText.js';

export class ScreenContext {
    constructor() {
        this.clear();
    }

    clear() {
        /** 'empty' | 'reading' | 'ready' */
        this.status = 'empty';
        this.words = [];
        this.codes = [];
        this._refined = null;
    }

    /** Store the result of reading the whole screen. */
    setScreen({words = [], codes = []}) {
        this.words = words;
        this.codes = codes;
        this.status = 'ready';
    }

    /**
     * Store a sharper reading of one selection. It replaces the whole-screen
     * words (and, if any were found close up, codes) for exactly that
     * rectangle.
     */
    setRefined(rect, words, codes = []) {
        this._refined = {key: rectKey(rect), words, codes};
    }

    /** True if a sharper reading exists for exactly this rectangle. */
    hasRefined(rect) {
        return this._refined?.key === rectKey(rect);
    }

    /**
     * What lies inside a rectangle.
     *
     * @param {{x: number, y: number, width: number, height: number}} rect
     * @returns {{words: Array<object>, codes: Array<object>, text: string}}
     */
    select(rect) {
        const refined = this.hasRefined(rect) ? this._refined : null;
        const words = refined ? refined.words : this.words.filter(word => centreInside(word, rect));
        const codes = refined?.codes.length > 0
            ? refined.codes
            : this.codes.filter(code => centreInside(code, rect));
        return {words, codes, text: wordsToText(words)};
    }
}

export function rectKey(rect) {
    if (!rect)
        return null;
    return [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(':');
}

function centreInside(box, rect) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    return cx >= rect.x && cx <= rect.x + rect.width &&
        cy >= rect.y && cy <= rect.y + rect.height;
}
