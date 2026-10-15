// Unit tests for the shell-independent helpers. Run with `make test`
// (or `gjs -m tests/run.js`). Exits non-zero if any test fails.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {
    buildSearchUrl, deleteFile, parseRgbaSetting, runCommand, writePrivateTempFile,
} from '../lib/common.js';
import {normalizeLanguageSelection, parseTesseractLanguages, TesseractProvider, trustworthySparseWords} from '../lib/vision/tesseract.js';
import {createProvider, listProviderIds} from '../lib/vision/index.js';
import {wordsToStage} from '../lib/vision/provider.js';
import {planBands, mergeBandWords, recognizeInBands, chooseBandCount} from '../lib/vision/tiling.js';
import {parseZbarXml, scanCodes, codesAvailable} from '../lib/vision/codes.js';
import {ScreenContext} from '../lib/screenContext.js';
import {suggestActions, findUrls, parseWifiCode} from '../lib/intents.js';
import {describeSelection, shorten, fill} from '../lib/narration.js';
import {renderTokens, tokenize} from '../ui/textReveal.js';
import {
    ClickCounter, boundingRect, lineHighlights, lineRange, nearestWord, selectedWords, wordAt,
} from '../lib/textSelection.js';
import {MemoryStore, makeEntry} from '../lib/memory.js';
import {looksRandom, redactText} from '../lib/secrets.js';
import {saveScreenshot, screenshotBaseName} from '../lib/screenshotFile.js';
import GdkPixbuf from 'gi://GdkPixbuf';
import {dropLonelyFragments, hasLettersOrDigits, isPlausibleWord, parseTsv, wordsToText} from '../lib/ocrText.js';
import {interpretKeyPress} from '../lib/shortcutKeys.js';
import {LensLauncher} from '../uploader.js';
import Soup from 'gi://Soup?version=3.0';
import Gdk from 'gi://Gdk?version=4.0';

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function assertEqual(actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`expected ${e}\n         got ${a}`);
}

const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const tsvRow = (block, line, word, left, top, conf, text) =>
    `5\t1\t${block}\t1\t${line}\t${word}\t${left}\t${top}\t40\t20\t${conf}\t${text}`;

test('parseTsv keeps confident words and maps to stage coordinates', () => {
    const tsv = [
        TSV_HEADER,
        '1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t',
        tsvRow(1, 1, 1, 100, 50, 96, 'Hello'),
        tsvRow(1, 1, 2, 150, 50, 3, 'noise'),
    ].join('\n');

    const words = parseTsv(tsv, {scale: 2, offsetX: 10, offsetY: 20, minConfidence: 10});
    assertEqual(words, [{x: 60, y: 45, width: 20, height: 10, text: 'Hello', confidence: 96, lineKey: '1:1:1:1'}]);
});

test('wordsToText joins words per Tesseract line', () => {
    const tsv = [
        TSV_HEADER,
        tsvRow(1, 1, 1, 0, 0, 90, 'first'),
        tsvRow(1, 1, 2, 50, 2, 90, 'line'),
        // Same y as the line above but a different block: a second column.
        tsvRow(2, 1, 1, 400, 0, 90, 'column'),
        tsvRow(1, 2, 1, 0, 40, 90, 'second'),
    ].join('\n');

    assertEqual(wordsToText(parseTsv(tsv)), 'first line\ncolumn\nsecond');
});

test('parseTesseractLanguages hides osd and the header', () => {
    const output = 'List of available languages in "/usr/share/tessdata/" (3):\ndeu\neng\nosd\n';
    assertEqual(parseTesseractLanguages(output), ['deu', 'eng']);
});

test('normalizeLanguageSelection filters and falls back', () => {
    assertEqual(normalizeLanguageSelection(['deu', 'xyz', 'deu', 'bad code'], ['deu', 'eng']), ['deu']);
    assertEqual(normalizeLanguageSelection([], ['deu', 'eng']), ['eng']);
    assertEqual(normalizeLanguageSelection([], ['fra']), ['fra']);
    assertEqual(normalizeLanguageSelection(['fra'], null), ['fra']);
});

test('parseRgbaSetting validates and clamps', () => {
    assertEqual(parseRgbaSetting('0.1,0.2,0.3,2', null), [0.1, 0.2, 0.3, 1]);
    assertEqual(parseRgbaSetting('nonsense', [0, 0, 0, 1]), [0, 0, 0, 1]);
});

test('buildSearchUrl encodes text and falls back to Google', () => {
    assertEqual(buildSearchUrl('duckduckgo', 'a b&c'), 'https://duckduckgo.com/?q=a%20b%26c');
    assertEqual(buildSearchUrl('unknown', 'x'), 'https://www.google.com/search?q=x');
});

test('writePrivateTempFile creates an owner-only file in the runtime dir', () => {
    const path = writePrivateTempFile(new TextEncoder().encode('hi'), '.txt');
    try {
        if (!path.startsWith(GLib.get_user_runtime_dir()))
            throw new Error(`not in runtime dir: ${path}`);
        const [, contents] = GLib.file_get_contents(path);
        assertEqual(new TextDecoder().decode(contents), 'hi');
    } finally {
        deleteFile(path);
    }
    assertEqual(GLib.file_test(path, GLib.FileTest.EXISTS), false);
});

test('runCommand feeds stdin and captures output', async () => {
    const result = await runCommand(['cat'], {input: new TextEncoder().encode('piped')});
    assertEqual([result.success, result.stdout], [true, 'piped']);
});

test('interpretKeyPress records modifier combinations', () => {
    const {SHIFT_MASK, SUPER_MASK, CONTROL_MASK, LOCK_MASK} = Gdk.ModifierType;
    assertEqual(interpretKeyPress(Gdk.KEY_S, 0, SHIFT_MASK | SUPER_MASK),
        {action: 'set', accelerator: '<Shift><Super>s'});
    // Caps Lock must not end up in the shortcut.
    assertEqual(interpretKeyPress(Gdk.KEY_p, 0, CONTROL_MASK | LOCK_MASK),
        {action: 'set', accelerator: '<Control>p'});
    assertEqual(interpretKeyPress(Gdk.KEY_Print, 0, 0), {action: 'set', accelerator: 'Print'});
    assertEqual(interpretKeyPress(Gdk.KEY_F9, 0, 0), {action: 'set', accelerator: 'F9'});
});

test('interpretKeyPress handles waiting, cancelling and typing keys', () => {
    const {SHIFT_MASK, SUPER_MASK} = Gdk.ModifierType;
    assertEqual(interpretKeyPress(Gdk.KEY_Super_L, 0, SUPER_MASK), {action: 'wait'});
    assertEqual(interpretKeyPress(Gdk.KEY_Escape, 0, 0), {action: 'cancel'});
    assertEqual(interpretKeyPress(Gdk.KEY_BackSpace, 0, 0), {action: 'disable'});
    assertEqual(interpretKeyPress(Gdk.KEY_s, 0, 0), {action: 'reject', reason: 'needs-modifier'});
    assertEqual(interpretKeyPress(Gdk.KEY_S, 0, SHIFT_MASK), {action: 'reject', reason: 'needs-modifier'});
});

async function httpGet(session, url) {
    const message = Soup.Message.new('GET', url);
    const body = await new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            try {
                resolve(session.send_and_read_finish(result).toArray());
            } catch (e) {
                reject(e);
            }
        });
    });
    return {status: message.get_status(), body, headers: message.get_response_headers()};
}

const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

test('Lens hand-off serves the page and exact image, then shuts down', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const launcher = new LensLauncher({shutdownDelayMs: 100});
    const url = launcher.serve(png, 640, 480);
    const session = new Soup.Session();

    if (!/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}\/$/.test(url))
        throw new Error(`unexpected URL ${url}`);

    const page = await httpGet(session, url);
    const html = new TextDecoder().decode(page.body);
    assertEqual([page.status, html.includes('name="encoded_image"'), html.includes('value="640,480"'),
        page.headers.get_one('Referrer-Policy')], [200, true, true, 'no-referrer']);

    const wrongToken = await httpGet(session, url.replace(/[0-9a-f-]{36}/, GLib.uuid_string_random()));
    assertEqual(wrongToken.status, 404);

    const image = await httpGet(session, `${url}image.png`);
    assertEqual([image.status, [...image.body]], [200, [...png]]);

    await wait(400);
    assertEqual(launcher._handoffs.size, 0);
    launcher.destroy();
});

test('wordsToStage maps image pixels to the screen', () => {
    const words = [{x: 20, y: 10, width: 40, height: 20, text: 'hi', lineKey: 'a'}];
    assertEqual(wordsToStage(words, {scale: 2, offsetX: 100, offsetY: 50}),
        [{x: 110, y: 55, width: 20, height: 10, text: 'hi', lineKey: 'a'}]);
});

test('vision registry creates providers and falls back to Tesseract', () => {
    assertEqual(listProviderIds().includes('tesseract'), true);
    assertEqual(createProvider('tesseract').id, 'tesseract');
    assertEqual(createProvider('does-not-exist').id, 'tesseract');
});

test('Tesseract provider reads a real image (skipped without tesseract)', async () => {
    const provider = new TesseractProvider();
    if (!provider.isAvailable()) {
        print('     (skipped: tesseract not installed)');
        return;
    }
    await provider.prepare();
    const [testFile] = GLib.filename_from_uri(import.meta.url);
    const path = GLib.build_filenamev([GLib.path_get_dirname(testFile), 'fixtures', 'two-lines.png']);
    const [, png] = GLib.file_get_contents(path);
    const words = await provider.recognize(png, {languages: ['eng'], minConfidence: 10});
    assertEqual(wordsToText(words), 'Hello ScreenVision\nsecond line 42');
});

function fixture(name) {
    const [testFile] = GLib.filename_from_uri(import.meta.url);
    return GLib.build_filenamev([GLib.path_get_dirname(testFile), 'fixtures', name]);
}

test('planBands covers the image with overlapping, non-overlapping cores', () => {
    const plan = planBands(1000, {bands: 4, overlap: 50});
    assertEqual(plan.map(b => [b.coreTop, b.coreBottom]), [[0, 250], [250, 500], [500, 750], [750, 1000]]);
    assertEqual(plan.map(b => [b.top, b.bottom]), [[0, 300], [200, 550], [450, 800], [700, 1000]]);
    assertEqual(planBands(80, {bands: 4, overlap: 50}).length, 1);
    assertEqual(chooseBandCount(1600, 16), 6);
    assertEqual(chooseBandCount(1600, 2), 1);
});

test('mergeBandWords keeps each word once, from the band that owns it', () => {
    const [first, second] = planBands(200, {bands: 2, overlap: 20});
    const word = (y, text) => ({x: 0, y, width: 10, height: 10, text, lineKey: '1:1:1:1'});
    // "edge" sits on the boundary (rows 95-105): both bands see it.
    const merged = mergeBandWords([
        {band: first, words: [word(10, 'top'), word(95, 'edge')]},
        {band: second, words: [word(15, 'edge'), word(60, 'bottom')]},
    ]);
    assertEqual(merged.map(w => [w.text, w.y]), [['top', 10], ['edge', 95], ['bottom', 140]]);
});

test('banded recognition reads a page like a single pass (skipped without tesseract)', async () => {
    const provider = new TesseractProvider();
    if (!provider.isAvailable())
        return;
    await provider.prepare();
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(fixture('page.png'));
    const words = await recognizeInBands(provider, pixbuf,
        {bands: 3, overlap: 48, languages: ['eng'], minConfidence: 10, singleThread: true});
    assertEqual(wordsToText(words), [
        'Invoices are due on Friday', 'Contact billing@example.com today',
        'Portal https://example.com/portal', 'Reference number 48213',
        'Thanks for choosing ScreenVision', 'Settings and privacy options',
    ].join('\n'));
});

test('parseZbarXml reads code content and bounding boxes', () => {
    const xml = "<symbol type='QR-Code' quality='1'><polygon points='+31,+41 +31,+218 +208,+218 +208,+41'/>" +
        '<data><![CDATA[https://example.com]]></data></symbol>';
    assertEqual(parseZbarXml(xml), [{type: 'QR-Code', data: 'https://example.com', x: 31, y: 41, width: 177, height: 177}]);
});

test('scanCodes finds both QR codes in the fixture (skipped without zbar)', async () => {
    if (!codesAvailable())
        return;
    const [, png] = GLib.file_get_contents(fixture('qr-codes.png'));
    const codes = await scanCodes(png);
    assertEqual(codes.map(c => c.data).sort(),
        ['WIFI:S:HomeNet;T:WPA;P:secret123;;', 'https://example.com/qr-test']);
});

test('ScreenContext selects words and codes by their centre', () => {
    const context = new ScreenContext();
    const w = (x, y, text, lineKey) => ({x, y, width: 20, height: 10, text, lineKey});
    context.setScreen({
        words: [w(10, 10, 'inside', 'a'), w(30, 10, 'too', 'a'), w(300, 300, 'outside', 'b')],
        codes: [{data: 'qr', x: 50, y: 50, width: 20, height: 20}],
    });
    const rect = {x: 0, y: 0, width: 100, height: 100};
    assertEqual(context.select(rect).text, 'inside too');
    assertEqual(context.select(rect).codes.map(c => c.data), ['qr']);
    context.setRefined(rect, [w(10, 10, 'sharper', 'z')]);
    assertEqual(context.select(rect).text, 'sharper');
    assertEqual(context.select({...rect, width: 101}).text, 'inside too');
});

test('suggestActions puts specific actions first and always offers Lens', () => {
    const kinds = s => s.map(x => x.kind + (x.detail ? `(${x.detail})` : ''));
    assertEqual(kinds(suggestActions({
        text: 'Docs at https://example.com/docs. Mail me@example.org',
        codes: [{data: String.raw`WIFI:S:HomeNet;T:WPA;P:p\;w;;`}],
    })), ['copy-wifi-password(HomeNet)', 'open-url(example.com)', 'email', 'copy-text', 'search', 'lens']);
    assertEqual(kinds(suggestActions({})), ['lens']);
    assertEqual(findUrls('see www.gnome.org, and http://a.b/c).'), ['https://www.gnome.org', 'http://a.b/c']);
    assertEqual(parseWifiCode(String.raw`WIFI:S:Cafe;T:WPA;P:p\;w;;`), {ssid: 'Cafe', password: 'p;w'});
});

test('hasLettersOrDigits drops symbol-only words', () => {
    assertEqual(['|', '~—', 'é', '42', 'a-b', '…'].map(text => hasLettersOrDigits({text})),
        [false, false, true, true, true, false]);
});

test('describeSelection summarises codes, text and links', () => {
    assertEqual(describeSelection({
        text: 'Portal https://example.com/portal\nSecond line',
        codes: [{data: 'WIFI:S:HomeNet;T:WPA;P:x;;'}],
    }), {
        headline: 'Wi-Fi network “HomeNet” · 2 lines of text · Link to example.com',
        body: 'Portal https://example.com/portal\nSecond line',
        thinking: false,
    });
    assertEqual(describeSelection({text: 'mail me@a.org'}).headline, '1 line of text · Email address');
    assertEqual(describeSelection({}, {reading: true}).thinking, true);
    assertEqual(describeSelection({}).headline, 'No text here');
});

test('shorten cuts at a word boundary and fill replaces placeholders', () => {
    assertEqual(shorten('alpha beta gamma delta', 16), 'alpha beta…');
    assertEqual(shorten('short', 16), 'short');
    assertEqual(fill('%d lines in %s', 3, 'doc'), '3 lines in doc');
});

test('tokenize keeps spacing and renderTokens fades words in order', () => {
    assertEqual(tokenize('Hello  world\nhi'), ['Hello  ', 'world\n', 'hi']);
    const tokens = [{text: 'a<b ', start: 0}, {text: 'c', start: 100}];
    assertEqual(renderTokens(tokens, 50, 100), {markup: '<span alpha="50%">a&lt;b </span>', done: false});
    assertEqual(renderTokens(tokens, 200, 100), {markup: 'a&lt;b c', done: true});
    assertEqual(renderTokens(tokens, 0, 0), {markup: 'a&lt;b ', done: false});
});

test('isPlausibleWord rejects OCR noise but keeps real words', () => {
    assertEqual(['SS', 'Zz', 'sss', '=', '——a', 'a', 'Hi', '000', 'Zs', 'OK'].map(text => isPlausibleWord({text})),
        [false, false, false, false, true, true, true, true, true, true]);
});

test('trustworthySparseWords needs every word and the average to be confident', () => {
    const w = confidence => ({text: 'x', confidence});
    assertEqual(trustworthySparseWords([w(90), w(80), w(40)]).length, 2);
    assertEqual(trustworthySparseWords([w(62), w(65)]).length, 0);
    assertEqual(trustworthySparseWords([w(30)]).length, 0);
});

test('a text-free landscape photo yields no words (skipped without tesseract)', async () => {
    const provider = new TesseractProvider();
    if (!provider.isAvailable())
        return;
    await provider.prepare();
    const [, png] = GLib.file_get_contents(fixture('landscape.png'));
    const words = await provider.recognize(png, {languages: ['eng'], minConfidence: 10});
    assertEqual(words.map(word => word.text), []);
    const adaptive = await provider.recognize(png, {languages: ['eng'], minConfidence: 50, adaptiveThreshold: true});
    assertEqual(adaptive.map(word => word.text), []);
});

test('dropLonelyFragments removes unsure short words alone on a line', () => {
    const w = (text, confidence, lineKey) => ({text, confidence, lineKey});
    assertEqual(dropLonelyFragments([
        w('a', 91, 'l1'), w('wit', 70, 'l2'), w('OK', 96, 'l3'), w('Cancel', 60, 'l4'),
        w('on', 50, 'l5'), w('time', 96, 'l5'),
    ]).map(x => x.text), ['OK', 'Cancel', 'on', 'time']);
});

test('makeEntry collects links, emails and codes from what was seen', () => {
    const entry = makeEntry({
        text: 'Docs at https://example.com/docs, mail team@example.org',
        codes: [{type: 'QR-Code', data: 'https://qr.example/x', x: 1}],
        source: {app: 'Firefox', title: 'Docs'},
        rect: {x: 1.4, y: 2.6, width: 10, height: 20},
        time: new Date('2026-10-15T10:00:00Z'),
    });
    assertEqual([entry.links, entry.emails, entry.codes, entry.rect, entry.time], [
        ['https://qr.example/x', 'https://example.com/docs'], ['team@example.org'],
        [{type: 'QR-Code', data: 'https://qr.example/x'}], {x: 1, y: 3, width: 10, height: 20},
        '2026-10-15T10:00:00.000Z',
    ]);
});

// Fake secrets are split by '{{}}' in the files so secret scanners never see a whole one.
const unsplit = text => text.replaceAll('{{}}', '');
const SECRET_CASES = JSON.parse(unsplit(new TextDecoder().decode(
    GLib.file_get_contents(GLib.build_filenamev([GLib.path_get_dirname(System.programPath),
        'fixtures', 'secret-cases.json']))[1])));

test('redactText hides every shared-case secret and names it', () => {
    for (const {text, secret, label} of SECRET_CASES.hide) {
        const result = redactText(text);
        if (result.text.includes(secret) || !result.text.includes(`[hidden ${label}]`))
            throw new Error(`not hidden: ${JSON.stringify(result.text)}`);
        if (!result.hidden.includes(label))
            throw new Error(`label ${label} missing from ${JSON.stringify(result.hidden)}`);
        assertEqual(redactText(result.text), {text: result.text, hidden: []});
    }
});

test('redactText keeps ordinary text', () => {
    for (const text of SECRET_CASES.keep)
        assertEqual(redactText(text), {text, hidden: []});
    assertEqual([looksRandom('Xq7Lm2Pz9Kd4Wt8Rb3Nv6Hy'), looksRandom('ScreenVisionOverlayController2')], [true, false]);
});

test('makeEntry hides secrets everywhere and drops the screenshot', () => {
    const entry = makeEntry({
        text: 'login https://bryn:S3cretPassw0rd@db.example.com password: hunter2!',
        codes: [{type: 'QR-Code', data: 'WIFI:T:WPA;S:Home;P:pa55word-for-wifi;;'}],
        source: {app: 'Firefox', title: unsplit('Users AVNS{{}}_Fk3mQ9zLx2PwRt7Yv')},
        image: '/home/bryn/Pictures/Screenshots/shot.png',
    });
    const stored = JSON.stringify(entry);
    for (const secret of ['S3cretPassw0rd', 'hunter2!', 'pa55word-for-wifi', unsplit('AVNS{{}}_Fk3mQ9zLx2PwRt7Yv')]) {
        if (stored.includes(secret))
            throw new Error(`${secret} was stored`);
    }
    assertEqual([entry.image, entry.hidden], [null, ['password', 'Wi-Fi password', 'DigitalOcean database password']]);
    assertEqual(makeEntry({text: 'hello', image: '/tmp/a.png'}).image, '/tmp/a.png');
});

test('MemoryStore appends privately, lists and forgets', async () => {
    const dir = GLib.dir_make_tmp('sv-memory-XXXXXX');
    const store = new MemoryStore(GLib.build_filenamev([dir, 'memories']));
    assertEqual(await store.list(), []);
    await store.remember(makeEntry({text: 'first'}));
    await store.remember(makeEntry({text: 'second'}));
    assertEqual((await store.list()).map(e => e.text), ['first', 'second']);

    const info = Gio.File.new_for_path(GLib.build_filenamev([store.directory, 'entries.jsonl']))
        .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    assertEqual((info.get_attribute_uint32('unix::mode') & 0o777).toString(8), '600');

    store.forgetAll();
    assertEqual(await store.list(), []);
});

test('saveScreenshot uses GNOME naming and never overwrites', async () => {
    const dir = GLib.dir_make_tmp('sv-shots-XXXXXX');
    const time = new Date(2026, 9, 15, 18, 22, 1);
    assertEqual(screenshotBaseName(time), 'Screenshot From 2026-10-15 18-22-01');
    const first = await saveScreenshot(new Uint8Array([1, 2, 3]), {dir, time});
    const second = await saveScreenshot(new Uint8Array([4]), {dir, time});
    assertEqual([GLib.path_get_basename(first), GLib.path_get_basename(second)],
        ['Screenshot From 2026-10-15 18-22-01.png', 'Screenshot From 2026-10-15 18-22-01 - 2.png']);
    assertEqual([...GLib.file_get_contents(first)[1]], [1, 2, 3]);
});

// Two lines: "Hello big world" / "second line".
const SEL_WORDS = [
    {x: 10, y: 10, width: 40, height: 12, text: 'Hello', lineKey: 'a'},
    {x: 56, y: 10, width: 24, height: 12, text: 'big', lineKey: 'a'},
    {x: 86, y: 11, width: 40, height: 12, text: 'world', lineKey: 'a'},
    {x: 10, y: 30, width: 50, height: 12, text: 'second', lineKey: 'b'},
    {x: 66, y: 30, width: 30, height: 12, text: 'line', lineKey: 'b'},
];

test('wordAt and nearestWord find words under and near the pointer', () => {
    assertEqual([wordAt(SEL_WORDS, 60, 15), wordAt(SEL_WORDS, 52, 15), wordAt(SEL_WORDS, 200, 15)], [1, 0, -1]);
    // Past the end of the first line, the nearest word is still on that line.
    assertEqual(nearestWord(SEL_WORDS, 200, 16), 2);
    assertEqual(nearestWord(SEL_WORDS, 0, 40), 3);
    assertEqual(nearestWord([], 0, 0), -1);
});

test('selectedWords spans reading order in either direction', () => {
    assertEqual(selectedWords(SEL_WORDS, {anchor: 1, focus: 3}).map(w => w.text), ['big', 'world', 'second']);
    assertEqual(selectedWords(SEL_WORDS, {anchor: 3, focus: 1}).map(w => w.text), ['big', 'world', 'second']);
    assertEqual(lineRange(SEL_WORDS, 1), [0, 2]);
    assertEqual(lineRange(SEL_WORDS, 4), [3, 4]);
});

test('lineHighlights merges a line into one bar; boundingRect covers all', () => {
    assertEqual(lineHighlights(SEL_WORDS.slice(1, 4)), [
        {x: 56, y: 10, width: 70, height: 13}, {x: 10, y: 30, width: 50, height: 12},
    ]);
    assertEqual(boundingRect(SEL_WORDS), {x: 10, y: 10, width: 116, height: 32});
    assertEqual(boundingRect([]), null);
});

test('ClickCounter recognises double and triple clicks', () => {
    const c = new ClickCounter();
    assertEqual([c.press(5, 5, 0), c.press(6, 5, 200), c.press(6, 6, 350), c.press(6, 6, 500)], [1, 2, 3, 3]);
    assertEqual(c.press(6, 6, 2000), 1);
    assertEqual(c.press(50, 6, 2100), 1);
});

test('describeSelection counts words for a text selection', () => {
    assertEqual(describeSelection({text: 'reads this'}, {textSelection: true}).headline, '2 words selected');
    assertEqual(describeSelection({text: 'see https://a.org/x'}, {textSelection: true}).headline,
        '2 words selected · Link to a.org');
});

const loop = new GLib.MainLoop(null, false);
let failures = 0;

(async () => {
    for (const {name, fn} of tests) {
        try {
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failures++;
            print(`FAIL ${name}\n     ${e.message}`);
        }
    }
    print(`\n${tests.length - failures}/${tests.length} passed`);
    loop.quit();
})();

loop.run();
System.exit(failures > 0 ? 1 : 0);
