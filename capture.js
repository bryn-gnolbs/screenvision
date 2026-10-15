// Grabbing pixels from the screenshot UI. Every feature (OCR, QR, Lens) works
// on the same frozen frame the screenshot tool already took, so we never take
// a second screenshot.

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

/**
 * Encode the current selection (or the whole screen/window, depending on the
 * screenshot UI's mode) as a PNG.
 *
 * @param {object} ui - Main.screenshotUI
 * @returns {Promise<{pixbuf: object, png: Uint8Array}|null>} null when nothing
 *   is selected
 */
export async function captureSelection(ui) {
    const geometry = ui._getSelectedGeometry(true);
    if (!geometry || geometry[2] <= 0 || geometry[3] <= 0)
        return null;
    return captureGeometry(ui, geometry);
}

/**
 * Encode any rectangle of the frozen frame (screen/stage coordinates) as a
 * PNG, e.g. the area around a text selection.
 *
 * @param {object} ui - Main.screenshotUI
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @returns {Promise<{pixbuf: object, png: Uint8Array}|null>}
 */
export function captureRect(ui, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0)
        return Promise.resolve(null);
    const s = ui._scale;
    return captureGeometry(ui, [
        Math.round(rect.x * s), Math.round(rect.y * s),
        Math.round(rect.width * s), Math.round(rect.height * s),
    ]);
}

async function captureGeometry(ui, geometry) {
    const texture = ui._stageScreenshot?.get_content()?.get_texture();
    if (!texture)
        throw new Error('The screenshot UI has no frozen frame');

    const [x, y, width, height] = geometry;
    const stream = Gio.MemoryOutputStream.new_resizable();
    const pixbuf = await Shell.Screenshot.composite_to_stream(
        texture,
        x, y, width, height,
        ui._scale,
        null, 0, 0, 1,
        stream
    );
    stream.close(null);

    return {pixbuf, png: stream.steal_as_bytes().toArray()};
}

/**
 * Encode the entire frozen frame (every monitor) as a PNG, at full
 * resolution.
 *
 * @param {object} ui - Main.screenshotUI
 * @returns {Promise<{pixbuf: object, png: Uint8Array}>}
 */
export async function captureScreen(ui) {
    const texture = ui._stageScreenshot?.get_content()?.get_texture();
    if (!texture)
        throw new Error('The screenshot UI has no frozen frame');

    const stream = Gio.MemoryOutputStream.new_resizable();
    const pixbuf = await Shell.Screenshot.composite_to_stream(
        texture,
        0, 0, texture.get_width(), texture.get_height(),
        ui._scale,
        null, 0, 0, 1,
        stream
    );
    stream.close(null);

    return {pixbuf, png: stream.steal_as_bytes().toArray()};
}

export function isSelectionMode(ui) {
    return Boolean(ui?._selectionButton?.checked);
}
