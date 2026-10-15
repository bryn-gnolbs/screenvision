// Google Lens upload. The image is POSTed directly from the shell and Lens
// answers with a redirect to the results page, which we open in the browser.
// Nothing is written to disk, and it works with sandboxed (Snap/Flatpak)
// browsers that cannot read files in /tmp.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const UPLOAD_URL = 'https://lens.google.com/v3/upload';
const ALLOWED_RESULT_HOSTS = new Set(['www.google.com', 'lens.google.com']);

export class LensUploader {
    constructor() {
        this._session = new Soup.Session({timeout: 30});
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    /**
     * Upload a PNG to Google Lens.
     *
     * @param {Uint8Array} pngBytes - the encoded image
     * @param {number} width - image width in pixels
     * @param {number} height - image height in pixels
     * @param {import('gi://Gio').Cancellable|null} [cancellable]
     * @returns {Promise<string>} URL of the Lens results page
     */
    async upload(pngBytes, width, height, cancellable = null) {
        const multipart = new Soup.Multipart('multipart/form-data');
        multipart.append_form_file('encoded_image', 'image.png', 'image/png',
            new GLib.Bytes(pngBytes));
        multipart.append_form_string('processed_image_dimensions', `${width},${height}`);

        const url = `${UPLOAD_URL}?ep=ccm&s=&st=${Date.now()}`;
        const message = Soup.Message.new_from_multipart(url, multipart);
        // We want the redirect target itself, not the page behind it.
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);

        await new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });

        const status = message.get_status();
        const location = message.get_response_headers().get_one('Location');
        if (status < 300 || status >= 400 || !location)
            throw new Error(`Google Lens answered HTTP ${status} without a results link`);

        const resultUri = message.get_uri().parse_relative(location, GLib.UriFlags.NONE);
        if (resultUri.get_scheme() !== 'https' || !ALLOWED_RESULT_HOSTS.has(resultUri.get_host()))
            throw new Error(`Unexpected Google Lens redirect to ${resultUri.get_host()}`);

        return resultUri.to_string();
    }
}
