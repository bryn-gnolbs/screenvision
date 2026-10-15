// What ScreenVision says about a selection: a short headline describing what
// it understood, and the text itself as the body. This is the rule-based
// stand-in for the assistant's voice; the bubble (ui/bubble.js) displays it.
//
// Translatable strings go through the `_` function passed in, so this module
// stays free of GNOME imports and can be unit-tested.

import {findEmails, findUrls, parseWifiCode, isWebUrl} from './intents.js';

const MAX_BODY_CHARS = 280;

/** Fill %s / %d placeholders in order (String.prototype.format is shell-only). */
export function fill(template, ...values) {
    let index = 0;
    return template.replace(/%[sd]/g, () => String(values[index++] ?? ''));
}

/**
 * Describe a selection.
 *
 * @param {object} selection - from ScreenContext.select()
 * @param {string} selection.text
 * @param {Array<{data: string}>} selection.codes
 * @param {object} [options]
 * @param {boolean} [options.reading] - the screen is still being read
 * @param {boolean} [options.textSelection] - the user selected words (Live
 *   Text), so count words instead of lines
 * @param {function(string): string} [options._] - gettext
 * @returns {{headline: string, body: string, thinking: boolean}}
 */
export function describeSelection({text = '', codes = []} = {}, {reading = false, textSelection = false, _ = s => s} = {}) {
    const parts = [];

    for (const code of codes) {
        const wifi = parseWifiCode(code.data);
        if (wifi)
            parts.push(wifi.ssid ? fill(_('Wi-Fi network “%s”'), wifi.ssid) : _('Wi-Fi code'));
        else if (isWebUrl(code.data))
            parts.push(fill(_('QR code for %s'), hostOf(code.data)));
        else
            parts.push(_('QR code'));
    }

    const trimmed = text.trim();
    if (trimmed) {
        if (textSelection) {
            const words = trimmed.split(/\s+/).length;
            parts.push(words === 1 ? _('1 word selected') : fill(_('%d words selected'), words));
        } else {
            const lines = trimmed.split('\n').filter(line => line.trim()).length;
            parts.push(lines === 1 ? _('1 line of text') : fill(_('%d lines of text'), lines));
        }

        const url = findUrls(trimmed)[0];
        if (url)
            parts.push(fill(_('Link to %s'), hostOf(url)));
        else if (findEmails(trimmed).length > 0)
            parts.push(_('Email address'));
    }

    if (parts.length === 0) {
        return reading
            ? {headline: _('Reading the screen'), body: '', thinking: true}
            : {headline: _('No text here'), body: _('Try Lens to search for what’s in the picture.'), thinking: false};
    }

    return {headline: parts.join(' · '), body: shorten(trimmed), thinking: false};
}

/** Cut long text at a word boundary, with an ellipsis. */
export function shorten(text, max = MAX_BODY_CHARS) {
    if (text.length <= max)
        return text;
    const cut = text.slice(0, max);
    const lastSpace = cut.search(/\s\S*$/);
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function hostOf(url) {
    const match = url.match(/^https?:\/\/([^/?#:]+)/i);
    return match ? match[1].replace(/^www\./i, '') : url;
}
