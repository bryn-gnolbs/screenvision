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

export function isSelectionMode(ui) {
    return Boolean(ui?._selectionButton?.checked);
}
