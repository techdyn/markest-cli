/**
 * @module sealed/seal
 * @description Sealing an artifact's documents in the browser.
 *
 *              An artifact sealed in the browser has one key, 256 random bits,
 *              made in the browser of whoever creates it and never sent to the
 *              site: it travels in the fragment of the artifact's link, which a
 *              browser never sends. Each document is sealed with it,
 *              AES-256-GCM, and what reaches the site is an envelope -
 *              `MKSEAL1:` then the IV and the ciphertext, each base64 - which
 *              is all the site stores and all it can hand back.
 *
 *              Each envelope carries as authenticated data the document's path
 *              and type, so the site cannot move one document's text to another
 *              path, or have markdown drawn as a page, and have it opened: it
 *              fails to open instead. The key is written base64url, 43
 *              characters, so it sits in a link without escaping.
 *
 *              WebCrypto and nothing else, so the same code runs in a browser
 *              and under Node's tests.
 *
 * @input A key, a document's path, type and text
 * @output Keys as text, envelopes, opened text
 * @dependencies globalThis.crypto (WebCrypto), chat/crypto/primitives
 */

import { randomBytes, toBase64, fromBase64, SealBroken } from '../chat/crypto/primitives.js';

export { SealBroken };

/** What every envelope starts with; the site checks it (App\Service\Sealed\SealedEnvelope). */
export const PREFIX = 'MKSEAL1:';

const AAD = 'markest-sealed-v1';

/** The same shape SealedEnvelope accepts: a 12-byte IV, then whole base64 of at least the 16-byte tag. */
const ENVELOPE = /^MKSEAL1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/;

/** The ciphertext's base64 is whole quads, and at least the tag: 16 bytes are 24 characters. */
function wholeCipher(text) {
    const cipher = text.length - PREFIX.length - 17;
    return cipher % 4 === 0 && cipher >= 24;
}

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subtle() {
    return globalThis.crypto.subtle;
}

/** What a document's envelope is bound to. */
export function context(path, contentType) {
    return AAD + '|' + String(contentType) + '|' + String(path);
}

/** Whether a document's stored text is an envelope. */
export function isEnvelope(text) {
    return typeof text === 'string' && ENVELOPE.test(text) && wholeCipher(text);
}

/** A key's bytes as they travel in a link. */
export function keyText(raw) {
    return toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A key's bytes from the text in a link, or null for anything that is not one. */
export function keyBytes(text) {
    const value = String(text ?? '').trim();
    if (!KEY_TEXT.test(value)) return null;
    const bytes = fromBase64(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
    return bytes.length === 32 ? bytes : null;
}

/** The key for its bytes. */
export async function importKey(raw) {
    return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** A new key: its text, for the link, and the key itself. */
export async function createKey() {
    const raw = randomBytes(32);
    return { text: keyText(raw), key: await importKey(raw) };
}

/** The key a link's text names, or null. */
export async function keyFromText(text) {
    const raw = keyBytes(text);
    return raw === null ? null : importKey(raw);
}

/**
 * A document's text sealed.
 *
 * @param {{path: string, contentType: string, content: string}} doc
 * @returns {Promise<string>} the envelope
 */
export async function sealDocument(key, doc) {
    const iv = randomBytes(12);
    const sealed = await subtle().encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(context(doc.path, doc.contentType)) },
        key,
        encoder.encode(String(doc.content ?? '')),
    );
    return PREFIX + toBase64(iv) + ':' + toBase64(sealed);
}

/**
 * A document's text, from its envelope.
 *
 * @param {{path: string, contentType: string, content: string}} doc its content is the envelope
 * @throws {SealBroken} for another key, an envelope moved to another path or type, or one altered
 */
export async function openDocument(key, doc) {
    if (!isEnvelope(doc.content)) throw new SealBroken('the document');
    const [iv, ct] = doc.content.slice(PREFIX.length).split(':');
    try {
        const plain = await subtle().decrypt(
            { name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(context(doc.path, doc.contentType)) },
            key,
            fromBase64(ct),
        );
        return decoder.decode(plain);
    } catch (error) {
        throw new SealBroken('the document');
    }
}

/**
 * Every document sealed, in order, each keeping its path, title and type.
 *
 * @param {{path: string, title?: string, contentType: string, content: string}[]} documents
 */
export async function sealAll(key, documents) {
    return Promise.all((documents || []).map(async (doc) => ({ ...doc, content: await sealDocument(key, doc) })));
}

/**
 * Every document opened, in order.
 *
 * @throws {SealBroken} when any one does not open with this key
 */
export async function openAll(key, documents) {
    return Promise.all((documents || []).map(async (doc) => ({ ...doc, content: await openDocument(key, doc) })));
}
