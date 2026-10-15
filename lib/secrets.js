// Keep passwords and keys out of the memory log.
//
// Before an entry is written, every secret in what was seen is replaced by a
// short label such as "[hidden DigitalOcean database password]": the memory
// still says what was on screen, and a search for "database password" still
// finds it, but the value itself is gone. An entry that had a secret keeps no
// reference to its screenshot, which shows the same thing (the screenshot
// itself is an ordinary file in Pictures/Screenshots, like any other).
//
// Three kinds of rule, most precise first:
//   1. known key formats (GitHub, AWS, DigitalOcean, private key blocks, JWTs...);
//   2. a value after a label: "password: hunter2", "api_key=...", passwords in
//      links (scheme://user:password@host), secret link parameters (?token=...),
//      Wi-Fi QR codes;
//   3. anything that looks random enough to be a generated secret (long, mixed
//      case and digits, high entropy).
// A short password with no label ("hunter2" alone) cannot be told from a word.
//
// The agent applies the same rules to everything it stores
// (genolabs-os: agent/src/genolabs_agent/redact.py); tests/fixtures/secret-cases.json
// is the shared set of examples both are tested against. Change them together.

// 1. Known formats: [label, pattern]. The whole match is hidden.
const KNOWN = [
    ['private key', /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g],
    ['DigitalOcean database password', /\bAVNS_[A-Za-z0-9_-]{8,}/g],
    ['DigitalOcean token', /\bdo[opr]_v1_[a-f0-9]{64}\b/g],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
    ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
    ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
    ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
    ['Stripe key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35,}/g],
    ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
    ['Tailscale key', /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/g],
    ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
    ['PyPI token', /\bpypi-[A-Za-z0-9_-]{50,}/g],
    ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/g],
    ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
    ['access token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

// 2. Values after a label: the 'value' group is hidden, the label stays.
const LABELS = 'password|passwd|passcode|passphrase|pass phrase|pwd|pin|secret|client secret|' +
    'api[ _-]?key|access[ _-]?key|secret[ _-]?key|private[ _-]?key|' +
    '(?:access|auth|bearer|refresh|api)?[ _-]?token';
const LABELLED_RULES = [
    ['password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?<value>[^\s@/]+)@/gi],
    ['Wi-Fi password', /\bWIFI:(?:[^;]*;)*?P:(?<value>(?:\\.|[^;\\])+)/gi],
    ['secret', /[?&#](?:[a-z0-9_-]*(?:token|secret|password|passwd|signature|credential)|key|api_?key|sig|auth|pwd)=(?<value>[^&#\s]{4,})/gi],
    ['token', /\b(?:bearer|basic)\s+(?<value>[A-Za-z0-9._~+/=-]{16,})/gi],
    [null, new RegExp(`\\b(?:[a-z0-9]+[_-])*(?:${LABELS})\\b\\s*[:=]\\s*(?<value>[^\\s,;]{4,})`, 'gi')],
];
const MASK = new Set('•*●·.-_x');

// 3. Random-looking: long, all three character classes, and classes switching
// often (random text switches ~60% of the time, CamelCase words ~20%).
const TOKEN = /(?<![A-Za-z0-9_+=/-])[A-Za-z0-9_+=-]{20,}(?![A-Za-z0-9_+=/-])/g;
const MIN_ENTROPY = 3.9;   // bits per character
const MIN_SWITCHES = 0.35;

function charClass(c) {
    if (/[A-Z]/.test(c))
        return 'u';
    if (/[a-z]/.test(c))
        return 'l';
    return /[0-9]/.test(c) ? 'd' : 's';
}

/**
 * @param {string} token
 * @returns {boolean} whether it looks like a generated secret
 */
export function looksRandom(token) {
    const classes = [...token].map(charClass);
    const count = k => classes.filter(c => c === k).length;
    if (Math.min(count('u'), count('l'), count('d')) < 2)
        return false;
    let switches = 0;
    for (let i = 1; i < classes.length; i++)
        switches += classes[i] !== classes[i - 1] ? 1 : 0;
    const counts = new Map();
    for (const c of token)
        counts.set(c, (counts.get(c) ?? 0) + 1);
    let entropy = 0;
    for (const n of counts.values())
        entropy -= n / token.length * Math.log2(n / token.length);
    return switches / (token.length - 1) >= MIN_SWITCHES && entropy >= MIN_ENTROPY;
}

function labelFor(whole) {
    const word = whole.split(/[:=]/)[0].trim().toLowerCase();
    if (word.endsWith('pin'))
        return 'PIN';
    if (word.includes('pass') || word.includes('pwd'))
        return 'password';
    if (word.includes('key'))
        return 'key';
    return word.includes('token') ? 'token' : 'secret';
}

/**
 * Hide every secret in a text.
 *
 * @param {string} text
 * @returns {{text: string, hidden: string[]}} the cleaned text and what was hidden
 */
export function redactText(text) {
    const hidden = [];
    if (!text)
        return {text, hidden};

    for (const [label, pattern] of KNOWN) {
        text = text.replace(pattern, () => {
            hidden.push(label);
            return `[hidden ${label}]`;
        });
    }

    for (const [label, pattern] of LABELLED_RULES) {
        text = text.replace(pattern, (...args) => {
            const whole = args[0];
            const {value} = args.at(-1);
            if (value.startsWith('[hidden') || [...value].every(c => MASK.has(c)))
                return whole;   // already hidden, or masked on screen
            const name = label ?? labelFor(whole);
            hidden.push(name);
            // The value ends the match (or comes just before its '@').
            const at = whole.lastIndexOf(value);
            return `${whole.slice(0, at)}[hidden ${name}]${whole.slice(at + value.length)}`;
        });
    }

    text = text.replace(TOKEN, token => {
        if (!looksRandom(token))
            return token;
        hidden.push('secret');
        return '[hidden secret]';
    });
    return {text, hidden};
}
