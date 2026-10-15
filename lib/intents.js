// Guessing what the user wants to do with what they selected. This is the
// rule-based stand-in for the assistant: it looks at the selected text and
// codes and suggests actions, most specific first. The UI turns each
// suggestion into a button; labels are added there so they can be translated.

const MAX_LINKS = 2;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// Characters that usually end a sentence rather than belong to a link.
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/;

/**
 * @typedef {object} Suggestion
 * @property {string} kind - 'open-url' | 'copy-wifi-password' | 'copy-code' |
 *   'email' | 'copy-text' | 'search' | 'lens'
 * @property {string} [value] - URL, text or address the action uses
 * @property {string} [detail] - short context for the label (host, network...)
 */

/**
 * Suggest actions for a selection.
 *
 * @param {object} selection
 * @param {string} [selection.text] - recognised text
 * @param {Array<{data: string}>} [selection.codes] - QR codes and barcodes
 * @returns {Suggestion[]}
 */
export function suggestActions({text = '', codes = []} = {}) {
    const suggestions = [];
    const seen = new Set();
    const add = suggestion => {
        const key = `${suggestion.kind}:${suggestion.value ?? ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            suggestions.push(suggestion);
        }
    };

    for (const code of codes) {
        const wifi = parseWifiCode(code.data);
        if (isWebUrl(code.data))
            add({kind: 'open-url', value: code.data, detail: hostOf(code.data)});
        else if (wifi?.password)
            add({kind: 'copy-wifi-password', value: wifi.password, detail: wifi.ssid});
        else
            add({kind: 'copy-code', value: code.data});
    }

    for (const url of findUrls(text).slice(0, MAX_LINKS))
        add({kind: 'open-url', value: url, detail: hostOf(url)});

    const email = findEmails(text)[0];
    if (email)
        add({kind: 'email', value: email});

    if (text.trim()) {
        add({kind: 'copy-text', value: text});
        add({kind: 'search', value: text});
    }

    add({kind: 'lens'});
    return suggestions;
}

/** Links in text, normalised to https:// and without trailing punctuation. */
export function findUrls(text) {
    const urls = [];
    for (const match of text.matchAll(URL_RE)) {
        let url = match[0].replace(TRAILING_PUNCTUATION_RE, '');
        if (url.toLowerCase().startsWith('www.'))
            url = `https://${url}`;
        if (!urls.includes(url))
            urls.push(url);
    }
    return urls;
}

export function findEmails(text) {
    return [...new Set(text.match(EMAIL_RE) ?? [])];
}

export function isWebUrl(value) {
    return /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * Parse a Wi-Fi QR code ("WIFI:S:<ssid>;T:<type>;P:<password>;;").
 *
 * @param {string} data - code content
 * @returns {{ssid: string, password: string}|null}
 */
export function parseWifiCode(data) {
    if (!/^WIFI:/i.test(data))
        return null;

    const fields = {};
    // Fields are KEY:value; separated by unescaped semicolons.
    for (const [, key, value] of data.slice(5).matchAll(/([A-Z]):((?:\\.|[^;])*);/gi))
        fields[key.toUpperCase()] = value.replace(/\\(.)/g, '$1');

    return {ssid: fields.S ?? '', password: fields.P ?? ''};
}

function hostOf(url) {
    const match = url.match(/^https?:\/\/([^/?#:]+)/i);
    return match ? match[1].replace(/^www\./i, '') : url;
}
