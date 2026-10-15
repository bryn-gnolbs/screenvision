// The contract every vision provider follows. A provider turns an image into
// recognised words; the screenshot UI (ocr.js) only talks to this interface,
// so Tesseract, a local AI model or a remote AI service are interchangeable.
//
// A provider is an object with:
//
//   id: string                      stable identifier, e.g. 'tesseract'
//   name: string                    human-readable name
//
//   isAvailable(): boolean          cheap, synchronous check that it can run
//                                   (program installed, endpoint configured...)
//
//   prepare(): Promise<void>        optional; called each time the screenshot
//                                   tool opens, e.g. to refresh a language list
//
//   recognize(png, options): Promise<Word[]>
//       png      Uint8Array         PNG-encoded image
//       options.languages           string[] of language codes from settings
//       options.minConfidence       0-100; drop words below this
//       options.cancellable         Gio.Cancellable; abort when cancelled
//
// A Word is {x, y, width, height, text, lineKey} in *image pixel*
// coordinates. Words sharing a lineKey are on the same line, and words are
// returned in reading order.

/**
 * Map words from image pixels to screen (stage) coordinates.
 *
 * @param {Array<object>} words - words from a provider
 * @param {object} transform
 * @param {number} transform.scale - image pixels per stage pixel
 * @param {number} transform.offsetX - stage x of the image's left edge
 * @param {number} transform.offsetY - stage y of the image's top edge
 * @returns {Array<object>} new word objects in stage coordinates
 */
export function wordsToStage(words, {scale, offsetX, offsetY}) {
    return words.map(word => ({
        ...word,
        x: offsetX + word.x / scale,
        y: offsetY + word.y / scale,
        width: word.width / scale,
        height: word.height / scale,
    }));
}
