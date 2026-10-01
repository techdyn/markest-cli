/**
 * @module sealed/key-place
 * @description Where the key of an artifact sealed in the browser is found and
 *              kept (D-20260930-01): in its link's fragment (`#key=…`), which
 *              no browser sends to the site; in this tab's session storage,
 *              once a reader has opened it here, so moving between its
 *              documents does not lose it; and, for whoever made it or edits
 *              it, in this browser's local storage. A new artifact's key waits
 *              in the pending slot until the page it is saved into takes it.
 *              A storage that refuses keeps nothing. Pure.
 *
 * @input A link, a fragment or a key, a storage
 * @output The key's text, or the link carrying it
 * @dependencies sealed/seal
 */

import { keyBytes } from './seal.js';

/** The fragment's name: `#key=…`. */
export const FRAGMENT = 'key';

const PREFIX = 'markest:sealed-key:';
const PENDING = 'markest:sealed-pending';

/** How long a new artifact's key waits for the page it was saved into. */
export const PENDING_MS = 10 * 60 * 1000;

/** The key a fragment carries, or null. */
export function keyFromHash(hash) {
    const value = String(hash ?? '').replace(/^#/, '');
    for (const part of value.split('&')) {
        const [name, ...rest] = part.split('=');
        if (name === FRAGMENT) {
            const text = rest.join('=');
            return keyBytes(text) === null ? null : text;
        }
    }
    return null;
}

/** The key in something pasted: a whole link, a fragment, or the key alone. */
export function keyFromInput(input) {
    const value = String(input ?? '').trim();
    if (value === '') return null;
    const hash = value.indexOf('#');
    if (hash >= 0) return keyFromHash(value.slice(hash));
    return keyBytes(value) === null ? null : value;
}

/** A link carrying the key in its fragment, in place of any fragment it had. */
export function linkWithKey(url, text) {
    const base = String(url ?? '').split('#')[0];
    return base + '#' + FRAGMENT + '=' + text;
}

function read(storage, name) {
    try {
        return storage ? storage.getItem(name) : null;
    } catch (error) {
        return null;
    }
}

function write(storage, name, value) {
    try {
        if (!storage) return false;
        if (value === null) storage.removeItem(name);
        else storage.setItem(name, value);
        return true;
    } catch (error) {
        return false;
    }
}

/** Keep an artifact's key. */
export function remember(storage, pasteId, text) {
    return Boolean(pasteId) && keyBytes(text) !== null && write(storage, PREFIX + pasteId, text);
}

/** An artifact's kept key, or null. */
export function recall(storage, pasteId) {
    const text = pasteId ? read(storage, PREFIX + pasteId) : null;
    return keyBytes(text) === null ? null : text;
}

/** Forget an artifact's key: it did not open it. */
export function forget(storage, pasteId) {
    if (pasteId) write(storage, PREFIX + pasteId, null);
}

/** A new artifact's key, until the page it is saved into takes it. */
export function holdPending(storage, text, now) {
    return keyBytes(text) !== null && write(storage, PENDING, JSON.stringify({ key: text, at: now }));
}

/** The key a new artifact is waiting to be given, taken once; null when none, or too old. */
export function takePending(storage, now) {
    const raw = read(storage, PENDING);
    write(storage, PENDING, null);
    try {
        const held = JSON.parse(raw || 'null');
        return held && keyBytes(held.key) !== null && now - held.at >= 0 && now - held.at <= PENDING_MS ? held.key : null;
    } catch (error) {
        return null;
    }
}
