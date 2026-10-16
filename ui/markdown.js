// The small part of Markdown the assistant writes (docs/BRAIN.md), as Pango
// markup for the bubble: **bold**, *italic*, `code`, fenced code blocks,
// "- " bullets, "1." steps, [links](url) and "#" lines (shown bold). Anything
// else stays as written. It renders text that is still streaming in, so an
// unclosed `code` or **bold** at the end runs to the end of its line, and
// every character keeps the fade of the word it arrived in.
// No GNOME imports, so tests/run.js can check it with plain gjs.

import {escapeMarkup} from './textReveal.js';

const BULLET = /^(\s*)[-*•+]\s+/;
const HEADING = /^#{1,6}\s+/;
const FENCE = /^\s*```/;
// `code` | **bold** | *italic* | [label](url): unclosed code and bold run to the line's end.
const INLINE = /`([^`]*)(?:`|$)|\*\*(.+?)(?:\*\*|$)|(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])|\[([^\]\n]+)\]\(([^)\s]*)\)?/g;

/**
 * Split Markdown into styled pieces. Each piece's `at` is where its text
 * starts in the source; a piece with `literal: false` (a bullet) takes the
 * fade of the source character at `at`.
 *
 * @param {string} source
 * @returns {Array<{text: string, at: number, literal: boolean, bold: boolean,
 *     italic: boolean, code: boolean, link: boolean}>}
 */
export function parseMarkdown(source) {
    const pieces = [];
    const add = (text, at, style = {}, literal = true) => {
        if (text)
            pieces.push({text, at, literal, bold: false, italic: false, code: false, link: false, ...style});
    };
    let inFence = false;
    let position = 0;
    const lines = source.split('\n');
    lines.forEach((line, index) => {
        const at = position;
        position += line.length + 1;
        const newline = index < lines.length - 1;
        if (FENCE.test(line)) {        // the fence line itself is not shown
            inFence = !inFence;
            return;
        }
        if (inFence) {
            add(line + (newline ? '\n' : ''), at, {code: true});
            return;
        }
        let rest = line;
        let offset = 0;
        let style = {};
        const bullet = BULLET.exec(line);
        const heading = HEADING.exec(line);
        if (bullet) {
            add(`${bullet[1]}•  `, at, {}, false);
            offset = bullet[0].length;
        } else if (heading) {
            offset = heading[0].length;
            style = {bold: true};
        }
        rest = line.slice(offset);
        inline(rest, at + offset, style, add);
        if (newline)
            add('\n', at + line.length);
    });
    return pieces;
}

function inline(text, at, style, add) {
    let last = 0;
    INLINE.lastIndex = 0;
    const matches = [...text.matchAll(INLINE)];
    for (const match of matches) {
        if (match[0] === '')
            continue;
        add(text.slice(last, match.index), at + last, style);
        const start = at + match.index;
        if (match[1] !== undefined) {
            add(match[1], start + 1, {...style, code: true});
        } else if (match[2] !== undefined) {
            inline(match[2], start + 2, {...style, bold: true}, add);
        } else if (match[3] !== undefined) {
            inline(match[3], start + 1, {...style, italic: true}, add);
        } else if (match[4] !== undefined) {
            inline(match[4], start + 1, {...style, link: true}, add);
        }
        last = match.index + match[0].length;
    }
    add(text.slice(last), at + last, style);
}

/** The text without its Markdown, for the clipboard (links keep their address). */
export function plainText(source) {
    const linked = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
        label === url ? url : `${label} (${url})`);
    return parseMarkdown(linked).map(piece => piece.literal ? piece.text : piece.text.replace('•  ', '• ')).join('');
}

function wrap(text, piece, alpha) {
    let markup = escapeMarkup(text);
    if (piece.code)
        markup = `<tt>${markup}</tt>`;
    if (piece.bold)
        markup = `<b>${markup}</b>`;
    if (piece.italic)
        markup = `<i>${markup}</i>`;
    if (piece.link)
        markup = `<u>${markup}</u>`;
    return alpha >= 100 ? markup : `<span alpha="${alpha}%">${markup}</span>`;
}

/**
 * Like textReveal's renderTokens, but formatted: markup for the tokens
 * started by `now`, each fading in over fadeMs.
 *
 * @param {Array<{text: string, start: number}>} tokens - start in ms
 * @param {number} now - current time in ms
 * @param {number} fadeMs
 * @returns {{markup: string, done: boolean}}
 */
export function renderMarkdown(tokens, now, fadeMs) {
    let source = '';
    const alphas = [];
    let done = true;
    for (const {text, start} of tokens) {
        if (now < start) {
            done = false;
            break;
        }
        const progress = fadeMs > 0 ? Math.min(1, (now - start) / fadeMs) : 1;
        if (progress < 1)
            done = false;
        const alpha = Math.max(1, Math.round(progress * 100));
        source += text;
        for (let i = 0; i < text.length; i++)
            alphas.push(alpha);
    }

    let markup = '';
    for (const piece of parseMarkdown(source)) {
        if (!piece.literal) {
            markup += wrap(piece.text, piece, alphas[piece.at] ?? 100);
            continue;
        }
        // Runs of characters that share a fade.
        let runStart = 0;
        for (let i = 1; i <= piece.text.length; i++) {
            const alpha = alphas[piece.at + runStart] ?? 100;
            if (i === piece.text.length || (alphas[piece.at + i] ?? 100) !== alpha) {
                markup += wrap(piece.text.slice(runStart, i), piece, alpha);
                runStart = i;
            }
        }
    }
    return {markup, done};
}

/** Markup for finished Markdown (no fade). */
export function markdownMarkup(source) {
    return renderMarkdown([{text: source, start: 0}], 0, 0).markup;
}
