/**
 * @module cli/sealed/sealing
 * @description Sealing and opening an artifact's documents on this machine,
 *              exactly as the browser does - the site's own `sealed/seal`, through
 *              the command's one door to it - so the site still never has the
 *              key: each document AES-256-GCM, bound to its path and its type,
 *              which the site cannot tell from ciphertext and so is always sent.
 *              A key is found in a link's fragment - which no request carries -
 *              never in an id. A document that will not open with the key is a
 *              refusal that names no key.
 *
 * @input A key as it travels in a link; documents `{ path, content, contentType }`
 * @output Envelopes with their types; opened text; a new key
 * @dependencies cli/shared, cli/core/command-kit
 */

import { createKey, keyFromInput, keyFromText, openDocument, sealDocument, SealBroken } from '../shared.mjs';
import { Refused } from '../core/command-kit.mjs';

/** A new key: its text, for the link, and the key itself. */
export function newKey() {
    return createKey();
}

/** The key a reference carries in its fragment, or null: an id carries none. */
export function keyIn(reference) {
    // Stryker disable next-line StringLiteral: equivalent - no reference carries no fragment either way
    const text = String(reference ?? '');
    return text.includes('#') ? keyFromInput(text) : null;
}

/** A reference with its fragment - and so any key - taken off, to say it back safely. */
export function withoutKey(reference) {
    return String(reference ?? '').split('#')[0];
}

async function keyOf(keyText) {
    const key = await keyFromText(keyText);
    if (key === null) throw new Refused('That is not an artifact\'s key.');
    return key;
}

/** Every document sealed with the key, its type sent beside it. */
export async function sealAll(keyText, documents) {
    const key = await keyOf(keyText);
    return Promise.all(documents.map(async (doc) => ({
        path: doc.path,
        content: await sealDocument(key, { path: doc.path, contentType: doc.contentType, content: doc.content }),
        content_type: doc.contentType,
        // Stryker disable next-line ConditionalExpression: equivalent - a title undefined is no title once sent
        ...(doc.title !== undefined ? { title: doc.title } : {}),
    })));
}

/** Every document with text opened with the key; one that will not open is a refusal. */
export async function openAll(keyText, documents) {
    const key = await keyOf(keyText);
    const opened = [];
    for (const doc of documents) {
        if (doc.content === null || doc.content === undefined) {
            opened.push(doc);
            continue;
        }
        try {
            opened.push({ ...doc, content: await openDocument(key, { path: doc.path, contentType: doc.contentType, content: doc.content }) });
        } catch (error) {
            // Stryker disable next-line ConditionalExpression: equivalent - opening a document fails only as a broken seal
            if (!(error instanceof SealBroken)) throw error;
            throw new Refused('The key does not open ' + doc.path + ': it is another artifact\'s key, or the document was changed outside a tool that holds the key.');
        }
    }
    return opened;
}
