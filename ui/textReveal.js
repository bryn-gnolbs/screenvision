// Pure helpers for the bubble's streaming text: split text into words and
// render the words revealed so far as Pango markup with per-word fade.
// No GNOME imports, so tests/run.js can check it with plain gjs.

/**
 * Split text into tokens that keep their whitespace, so the original spacing
 * and line breaks survive: "Hello  world\nhi" -> ["Hello  ", "world\n", "hi"].
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
    return text.match(/\S+\s*|\s+/g) ?? [];
}

export function escapeMarkup(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Markup for tokens at a moment in time. Each token starts fading in at its
 * own start time; tokens that haven't started yet are left out, so the text
 * grows like someone typing.
 *
 * @param {Array<{text: string, start: number}>} tokens - start in ms
 * @param {number} now - current time in ms
 * @param {number} fadeMs - how long one token takes to fade in
 * @returns {{markup: string, done: boolean}}
 */
export function renderTokens(tokens, now, fadeMs) {
    let markup = '';
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
        markup += alpha >= 100
            ? escapeMarkup(text)
            : `<span alpha="${alpha}%">${escapeMarkup(text)}</span>`;
    }
    return {markup, done};
}
