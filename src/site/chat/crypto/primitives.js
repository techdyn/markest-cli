/**
 * @module chat/crypto/primitives
 * @description The chat's end-to-end encryption, as operations on keys and
 *              bytes - WebCrypto and nothing else, so the same code runs in a
 *              browser and under Node's tests (D-20260923-02).
 *
 *              An account has one identity key pair (ECDH P-256). Its private
 *              half never reaches the site in the clear: it is sealed with a
 *              key derived from the account's chat PIN (PBKDF2-SHA-256) and
 *              only that sealed copy is stored, so a new device can unseal it
 *              and nothing else can. A conversation has a key (AES-256-GCM) for
 *              each of its epochs, sealed for each participant with an
 *              ephemeral ECDH key and HKDF (ECIES), so reading a conversation's
 *              key needs a participant's private key. Messages, their files and
 *              the files' names are sealed with the conversation key.
 *
 *              Every sealed thing carries what it is for as authenticated data
 *              - which conversation, which epoch, whose envelope, whose message
 *              - so the site cannot move one to another place and have it
 *              opened there: it fails to open instead.
 *
 * @input Keys, PINs, text and bytes
 * @output Keys, sealed and opened things (base64 where they travel)
 * @dependencies globalThis.crypto (WebCrypto)
 */

/** The version every sealed thing carries, so a later scheme can tell them apart. */
export const VERSION = 1;

/** OWASP's floor for PBKDF2-HMAC-SHA-256 (2023); stored with each sealed identity so it can rise. */
export const KDF_ITERATIONS = 600000;

const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const IDENTITY_AAD = 'markest-chat-identity-v1';
const ENVELOPE_INFO = 'markest-chat-envelope-v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subtle() {
    return globalThis.crypto.subtle;
}

/** Random bytes. */
export function randomBytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/* ── Base64, for what travels ─────────────────────────────── */

export function toBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let text = '';
    for (let i = 0; i < view.length; i += 0x8000) {
        text += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
    }

    return btoa(text);
}

export function fromBase64(text) {
    const raw = atob(String(text || ''));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
        bytes[i] = raw.charCodeAt(i);
    }

    return bytes;
}

/** The error an opening that fails throws: a wrong PIN, a wrong key, or something altered. */
export class SealBroken extends Error {
    constructor(what) {
        super('Could not open ' + what);
        this.name = 'SealBroken';
    }
}

/* ── The PIN ──────────────────────────────────────────────── */

/**
 * What is wrong with a chat PIN, or null. It protects the one copy of the
 * account's private key that the site keeps, against anyone holding the
 * database, who can guess at it for as long as they like: so at least eight
 * characters with a letter among them, and a number alone needs twelve digits.
 *
 * @returns {null|'short'|'digits'}
 */
export function pinProblem(pin) {
    const value = String(pin || '');
    if ([...value].length < 8) {
        return 'short';
    }
    if (/^\d+$/.test(value) && value.length < 12) {
        return 'digits';
    }

    return null;
}

async function pinKey(pin, salt, iterations) {
    const material = await subtle().importKey('raw', encoder.encode(String(pin).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);

    return subtle().deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/* ── The identity ─────────────────────────────────────────── */

/**
 * A new identity: its key pair, the private half extractable only so that it
 * can be sealed with the PIN, and the public half as it travels.
 */
export async function createIdentity() {
    const pair = await subtle().generateKey(CURVE, true, ['deriveBits']);

    return { privateKey: pair.privateKey, publicKey: await exportPublic(pair.publicKey) };
}

/** A public key as it travels: SPKI, base64. */
export async function exportPublic(publicKey) {
    return toBase64(await subtle().exportKey('spki', publicKey));
}

export async function importPublic(text) {
    return subtle().importKey('spki', fromBase64(text), CURVE, false, []);
}

/**
 * The private key sealed with the PIN, as the site keeps it.
 *
 * @returns {Promise<{version: number, sealed: string, salt: string, iv: string, iterations: number}>}
 */
export async function sealIdentity(privateKey, pin, iterations = KDF_ITERATIONS) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await pinKey(pin, salt, iterations);
    const pkcs8 = await subtle().exportKey('pkcs8', privateKey);
    const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(IDENTITY_AAD) }, key, pkcs8);

    return { version: VERSION, sealed: toBase64(sealed), salt: toBase64(salt), iv: toBase64(iv), iterations };
}

/**
 * The private key, opened with the PIN. Not extractable unless asked - a
 * device keeps it only to use it; changing the PIN asks for it extractable,
 * to seal it again.
 *
 * @throws {SealBroken} for a wrong PIN, or a sealed copy that was altered
 */
export async function openIdentity(stored, pin, { extractable = false } = {}) {
    let pkcs8;
    try {
        const key = await pinKey(pin, fromBase64(stored.salt), Number(stored.iterations) || KDF_ITERATIONS);
        pkcs8 = await subtle().decrypt(
            { name: 'AES-GCM', iv: fromBase64(stored.iv), additionalData: encoder.encode(IDENTITY_AAD) },
            key,
            fromBase64(stored.sealed),
        );
    } catch (error) {
        throw new SealBroken('the identity');
    }

    return subtle().importKey('pkcs8', pkcs8, CURVE, extractable, ['deriveBits']);
}

/* ── A conversation's keys ────────────────────────────────── */

/** What an envelope is for: one participant's copy of one epoch's key of one conversation. */
export function envelopeContext(threadId, epoch, userId) {
    return 'thread:' + threadId + '|epoch:' + Number(epoch) + '|user:' + Number(userId);
}

/** What a message is for: said in one conversation, under one epoch, by one account. */
export function messageContext(threadId, epoch, authorId) {
    return 'thread:' + threadId + '|epoch:' + Number(epoch) + '|author:' + Number(authorId);
}

/** A new conversation key: its raw bytes, to seal for each participant, and the key itself. */
export async function createConversationKey() {
    const raw = randomBytes(32);

    return { raw, key: await conversationKey(raw) };
}

/** The key for raw bytes opened from an envelope. */
export async function conversationKey(raw) {
    return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function envelopeKey(sharedBits, context) {
    const material = await subtle().importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

    return subtle().deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(context), info: encoder.encode(ENVELOPE_INFO) },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/**
 * A conversation key sealed for one participant: an ephemeral key pair, its
 * shared secret with the participant's public key, HKDF, AES-GCM.
 *
 * @returns {Promise<string>} the envelope, as it travels
 */
export async function sealEnvelope(publicKeyText, raw, context) {
    const recipient = await importPublic(publicKeyText);
    const ephemeral = await subtle().generateKey(CURVE, true, ['deriveBits']);
    const shared = await subtle().deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256);
    const key = await envelopeKey(shared, context);
    const iv = randomBytes(12);
    const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, raw);

    return JSON.stringify({
        v: VERSION,
        epk: await exportPublic(ephemeral.publicKey),
        iv: toBase64(iv),
        ct: toBase64(sealed),
    });
}

/**
 * The conversation key's raw bytes, from this participant's envelope.
 *
 * @throws {SealBroken} for another's envelope, one moved from its place, or one altered
 */
export async function openEnvelope(privateKey, envelopeText, context) {
    try {
        const envelope = JSON.parse(envelopeText);
        const ephemeral = await importPublic(envelope.epk);
        const shared = await subtle().deriveBits({ name: 'ECDH', public: ephemeral }, privateKey, 256);
        const key = await envelopeKey(shared, context);
        const raw = await subtle().decrypt(
            { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode(context) },
            key,
            fromBase64(envelope.ct),
        );

        return new Uint8Array(raw);
    } catch (error) {
        throw new SealBroken('the envelope');
    }
}

/* ── What is said ─────────────────────────────────────────── */

/** @returns {Promise<{ct: string, iv: string}>} */
export async function sealText(key, text, context) {
    const iv = randomBytes(12);
    const sealed = await subtle().encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
        key,
        encoder.encode(String(text)),
    );

    return { ct: toBase64(sealed), iv: toBase64(iv) };
}

/** @throws {SealBroken} */
export async function openText(key, sealed, context) {
    try {
        const plain = await subtle().decrypt(
            { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: encoder.encode(context) },
            key,
            fromBase64(sealed.ct),
        );

        return decoder.decode(plain);
    } catch (error) {
        throw new SealBroken('the message');
    }
}

/** A file's bytes sealed: the IV, then what was sealed, as one blob to upload. */
export async function sealBytes(key, bytes, context) {
    const iv = randomBytes(12);
    const sealed = new Uint8Array(await subtle().encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
        key,
        bytes,
    ));
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv, 0);
    out.set(sealed, iv.length);

    return out;
}

/** @throws {SealBroken} */
export async function openBytes(key, blob, context) {
    const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    try {
        const plain = await subtle().decrypt(
            { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(context) },
            key,
            bytes.subarray(12),
        );

        return new Uint8Array(plain);
    } catch (error) {
        throw new SealBroken('the file');
    }
}
