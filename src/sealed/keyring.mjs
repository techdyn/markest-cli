/**
 * @module cli/sealed/keyring
 * @description The keys of artifacts encrypted end to end that this machine
 *              keeps, as the browser that makes or edits one keeps its key
 *              (D-20260930-01): so the owner's later reads and updates need
 *              only the artifact's id. Kept by site and by artifact in the
 *              command's vault (`keys.vault`, D-20261002-03), sealed under the
 *              key the system's secret store holds, so a copy of the settings
 *              folder opens no artifact. Only a key of the right shape is kept;
 *              a key is never sent anywhere from here, and a listing never
 *              shows one.
 *
 *              The keys an earlier version kept in the clear (`keys.json`, or
 *              the file MARKEST_KEYRING named) move into the vault the first
 *              time the store is used, and that file
 *              is removed once the vault reads back what it held. Where no
 *              secure store can be used, the old file is still read and a key
 *              can still be forgotten from it, but no key is written in the
 *              clear: keeping one is refused, saying why.
 *
 * @input A run's context (its vault, or its environment); a site, an artifact's id, a key
 * @output `{ path, get, remember, forget, list }`
 * @dependencies node:path, cli/shared, cli/store/vault, cli/store/secret-store, cli/store/private-file
 */

import { join } from 'node:path';
import { keyBytes } from '../shared.mjs';
import { vaultFile, vaultFor } from '../store/vault.mjs';
import { SecretStoreUnavailable } from '../store/secret-store.mjs';
import { readIfThere, removeIfThere, writePrivate } from '../store/private-file.mjs';

/** The file an earlier version kept keys in, in the clear. */
export const LEGACY_FILE = 'keys.json';

const empty = () => ({ version: 1, sites: {} });

/** A store this version understands, or a refusal that changes nothing. */
function understood(parsed, where) {
    // A store this version does not understand is never written over: the keys in it would be lost
    // Stryker disable next-line ConditionalExpression: equivalent - a number or a string has no version 1 either, so it is refused all the same
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.sites || typeof parsed.sites !== 'object' || Array.isArray(parsed.sites)) {
        throw new Error('The key store at ' + where + ' is not one this version of markest understands; nothing was changed in it.');
    }
    return parsed;
}

function parsedLegacy(text, where) {
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Not JSON: refused below with every other store this version does not understand
    }
    return understood(parsed, where);
}

/** Every key of both, the vault's where both keep one. */
function merged(legacy, kept) {
    const sites = { ...legacy.sites };
    for (const [site, entries] of Object.entries(kept.sites)) sites[site] = { ...(sites[site] ?? {}), ...entries };
    return { version: 1, sites };
}

export function openKeyring({ vault, legacyPath = join(vault.folder, LEGACY_FILE) }) {

    /** The keys, with the old file's moved into the vault; or the old file alone where the vault cannot be written. */
    async function load() {
        const opened = await vault.open();
        const kept = understood((await opened.read('keys')) ?? empty(), vaultFile(vault.folder, 'keys'));
        const legacyText = await readIfThere(legacyPath);
        if (legacyText === null) return { store: kept, plain: false };
        const legacy = parsedLegacy(legacyText, legacyPath);
        const both = merged(legacy, kept);
        try {
            await opened.write('keys', both);
        } catch (error) {
            if (!(error instanceof SecretStoreUnavailable)) throw error;
            return { store: both, plain: true };
        }
        // Removed only once the vault gives back every key the old file held
        if (JSON.stringify(await opened.read('keys')) === JSON.stringify(both)) await removeIfThere(legacyPath);
        return { store: both, plain: false };
    }

    async function save({ store, plain }) {
        if (plain) {
            await writePrivate(legacyPath, JSON.stringify(store, null, 2) + '\n');
            return;
        }
        await (await vault.open()).write('keys', store);
    }

    return {
        path: vaultFile(vault.folder, 'keys'),

        /** The key kept for an artifact on a site, or null. */
        async get(site, id) {
            const entry = (await load()).store.sites[site]?.[id];
            return entry && keyBytes(entry.key) !== null ? entry.key : null;
        },

        /** Keep an artifact's key, sealed in the vault; one that is not a key is refused, and so is keeping one in the clear. */
        async remember(site, id, key, title = null) {
            if (keyBytes(key) === null) throw new Error('That is not an artifact\'s key.');
            const loaded = await load();
            const refused = (why) => new SecretStoreUnavailable(why + ' The key was not kept; the link holds it. To keep keys in a file only you can read, run markest login --insecure-storage, or set MARKEST_SECRET_STORE=file.');
            if (loaded.plain) throw refused('No secure store can keep keys on this machine.');
            loaded.store.sites[site] = { ...(loaded.store.sites[site] ?? {}), [id]: { key, title, saved_at: new Date().toISOString() } };
            try {
                await save(loaded);
            } catch (error) {
                throw error instanceof SecretStoreUnavailable ? refused(error.message) : error;
            }
        },

        /** Stop keeping an artifact's key; whether there was one. */
        async forget(site, id) {
            const loaded = await load();
            if (!loaded.store.sites[site]?.[id]) return false;
            delete loaded.store.sites[site][id];
            if (Object.keys(loaded.store.sites[site]).length === 0) delete loaded.store.sites[site];
            await save(loaded);
            return true;
        },

        /** The artifacts whose keys are kept - never the keys. */
        async list() {
            const { store } = await load();
            return Object.entries(store.sites).flatMap(([site, entries]) => Object.entries(entries).map(([id, entry]) => ({ site, id, title: entry.title ?? null, saved_at: entry.saved_at ?? null })));
        },
    };
}

/** The key store a run uses: its own vault, the one its context already opened when there is one. */
export function keyringFor(ctx) {
    const vault = ctx.vault ?? vaultFor(ctx);
    // 0.2.0 kept them where MARKEST_KEYRING said, when it said: moved from there as from the folder
    // (found by the review of 2026-10-02)
    const named = ctx.env?.MARKEST_KEYRING;
    return openKeyring(named ? { vault, legacyPath: named } : { vault });
}
