// Unit tests for the shell-independent helpers. Run with `make test`
// (or `gjs -m tests/run.js`). Exits non-zero if any test fails.

import GLib from 'gi://GLib';
import System from 'system';

import {
    buildSearchUrl, deleteFile, parseRgbaSetting, runCommand, writePrivateTempFile,
} from '../lib/common.js';
import {normalizeLanguageSelection, parseTesseractLanguages, TesseractProvider} from '../lib/vision/tesseract.js';
import {createProvider, listProviderIds} from '../lib/vision/index.js';
import {wordsToStage} from '../lib/vision/provider.js';
import {parseTsv, wordsToText} from '../lib/ocrText.js';
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
    assertEqual(words, [{x: 60, y: 45, width: 20, height: 10, text: 'Hello', lineKey: '1:1:1:1'}]);
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
