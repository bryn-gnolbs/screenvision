// Registry of vision providers. To add one (for example an AI model running
// locally or on a server), implement the contract in provider.js and add a
// factory here.

import {TesseractProvider} from './tesseract.js';

const FACTORIES = {
    tesseract: () => new TesseractProvider(),
};

export const DEFAULT_PROVIDER_ID = 'tesseract';

/** @returns {string[]} ids of all known providers */
export function listProviderIds() {
    return Object.keys(FACTORIES);
}

/**
 * Create a provider by id, falling back to the default for unknown ids.
 *
 * @param {string} [id]
 * @returns {object} a provider following lib/vision/provider.js
 */
export function createProvider(id = DEFAULT_PROVIDER_ID) {
    const factory = FACTORIES[id] ?? FACTORIES[DEFAULT_PROVIDER_ID];
    return factory();
}
