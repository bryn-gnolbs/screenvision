// Google Lens hand-off.
//
// Lens keeps an uploaded image in the browser session that uploaded it, so
// the browser itself has to send the image (uploading from the shell and
// opening the results link shows an empty image). We serve a one-time page on
// 127.0.0.1 that fetches the image from us and submits it to Lens with the
// browser's own session. Unlike a file in /tmp, this also works for sandboxed
// Snap/Flatpak browsers.
//
// The server only listens on loopback, every URL contains a random token, and
// it shuts down once the image has been fetched (or after a timeout).

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const LENS_UPLOAD_URL = 'https://lens.google.com/v3/upload';
const SERVE_TIMEOUT_SECONDS = 120;
// Leave the page a moment to finish submitting after it fetched the image.
const SHUTDOWN_DELAY_SECONDS = 5;

export class LensLauncher {
    constructor() {
        this._handoffs = new Set();
    }

    destroy() {
        for (const handoff of this._handoffs)
            handoff.stop();
        this._handoffs.clear();
    }

    /**
     * Start serving a page that uploads the image to Google Lens.
     *
     * @param {Uint8Array} pngBytes - the encoded image
     * @param {number} width - image width in pixels
     * @param {number} height - image height in pixels
     * @returns {string} http://127.0.0.1 URL to open in the browser
     */
    serve(pngBytes, width, height) {
        const handoff = new LensHandoff(pngBytes, width, height,
            () => this._handoffs.delete(handoff));
        this._handoffs.add(handoff);
        return handoff.url;
    }
}

class LensHandoff {
    constructor(pngBytes, width, height, onStopped) {
        this._png = pngBytes;
        this._width = width;
        this._height = height;
        this._onStopped = onStopped;
        this._token = GLib.uuid_string_random();
        this._timeoutId = 0;

        this._server = new Soup.Server();
        this._server.add_handler(`/${this._token}`, (_server, message, path) => {
            this._handleRequest(message, path);
        });
        this._server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

        const port = this._server.get_uris()[0].get_port();
        this.url = `http://127.0.0.1:${port}/${this._token}/`;

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SERVE_TIMEOUT_SECONDS, () => {
            this._timeoutId = 0;
            this.stop();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (!this._server)
            return;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._server.disconnect();
        this._server = null;
        this._png = null;
        this._onStopped();
    }

    _handleRequest(message, path) {
        const headers = message.get_response_headers();
        headers.append('Cache-Control', 'no-store');
        // Don't reveal the local URL (and its token) to Google.
        headers.append('Referrer-Policy', 'no-referrer');

        if (message.get_method() !== 'GET') {
            message.set_status(405, null);
            return;
        }

        if (path === `/${this._token}/`) {
            message.set_status(200, null);
            message.set_response('text/html; charset=utf-8', Soup.MemoryUse.COPY,
                new TextEncoder().encode(buildPage(this._width, this._height)));
        } else if (path === `/${this._token}/image.png` && this._png) {
            message.set_status(200, null);
            message.set_response('image/png', Soup.MemoryUse.COPY, this._png);
            this._scheduleShutdown();
        } else {
            message.set_status(404, null);
        }
    }

    _scheduleShutdown() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SHUTDOWN_DELAY_SECONDS, () => {
            this._timeoutId = 0;
            this.stop();
            return GLib.SOURCE_REMOVE;
        });
    }
}

/**
 * The hand-off page: fetch the image from this server, put it in a file
 * input and submit the form to Lens, exactly like a manual upload.
 *
 * @param {number} width - image width in pixels
 * @param {number} height - image height in pixels
 * @returns {string} HTML
 */
export function buildPage(width, height) {
    const dimensions = `${Math.round(width)},${Math.round(height)}`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>ScreenVision → Google Lens</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px system-ui, sans-serif; background: #f6f7fb; color: #202124; }
  @media (prefers-color-scheme: dark) { body { background: #1e1e20; color: #e8e8ea; } }
</style>
</head>
<body>
<p id="status">Sending your screenshot to Google Lens…</p>
<form id="lens" method="POST" enctype="multipart/form-data" hidden>
  <input type="file" name="encoded_image">
  <input type="text" name="processed_image_dimensions" value="${dimensions}">
</form>
<script>
(async () => {
  const status = document.getElementById('status');
  try {
    const response = await fetch('image.png', {cache: 'no-store'});
    if (!response.ok)
      throw new Error('This link has expired. Take the screenshot again.');
    const blob = await response.blob();
    const form = document.getElementById('lens');
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'screenshot.png', {type: 'image/png'}));
    form.elements.encoded_image.files = transfer.files;
    form.action = '${LENS_UPLOAD_URL}?ep=ccm&s=&st=' + Date.now();
    form.submit();
  } catch (error) {
    status.textContent = error.message;
  }
})();
</script>
</body>
</html>`;
}
