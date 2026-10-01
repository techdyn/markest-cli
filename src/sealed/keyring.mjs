/**
 * @module cli/sealed/keyring
 * @description The keys of artifacts encrypted end to end that this machine
 *              keeps, as the browser that makes or edits one keeps its key
 *              (D-20260930-01): so the owner's later reads and updates need
 *              only the artifact's id. One file, kept by site and by artifact,
 *              in the account's own settings folder - `%APPDATA%\markest` on
 *              Windows, `~/Library/Application Support/markest` on a Mac,
 *              `$XDG_CONFIG_HOME/markest` or `~/.config/markest` elsewhere -
 *              or where MARKEST_KEYRING names. It is written whole, to a file
 *              beside it renamed into place, readable by its owner alone where
 *              the system has such permissions (on Windows the folder's own
 *              protects it). Only a key of the right shape is kept. A key is
 *              never sent anywhere from here, and a listing never shows one.
 *
 * @input The environment and the platform; a site, an artifact's id, a key
 * @output `{ path, get, remember, forget, list }`
 * @dependencies node:fs/promises, node:path, node:os, cli/shared
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { keyBytes } from '../shared.mjs';

export const FILE_NAME = 'keys.json';

/** Where the keys are kept on this machine. */
export function keyringPath(env = {}, platform = process.platform, home = homedir()) {
    if (env.MARKEST_KEYRING) return env.MARKEST_KEYRING;
    if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'markest', FILE_NAME);
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'markest', FILE_NAME);
    return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'markest', FILE_NAME);
}

const empty = () => ({ version: 1, sites: {} });

async function load(path) {
    let text;
    try {
        // Stryker disable next-line StringLiteral: equivalent - JSON.parse reads a buffer as its text
        text = await readFile(path, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return empty();
        throw error;
    }
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Not JSON: refused below with every other store this version does not understand
    }
    // A store this version does not understand is never written over: the keys in it would be lost
    // Stryker disable next-line ConditionalExpression: equivalent - a number or a string has no version 1 either, so it is refused all the same
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.sites || typeof parsed.sites !== 'object' || Array.isArray(parsed.sites)) {
        throw new Error('The key store at ' + path + ' is not one this version of markest understands; nothing was changed in it.');
    }
    return parsed;
}

async function save(path, store) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Stryker disable next-line StringLiteral: equivalent - any name beside it serves, renamed into place
    const temporary = path + '.' + process.pid + '.tmp';
    // Stryker disable next-line ObjectLiteral,StringLiteral: platform - the owner-only mode is checked only where the system has one (not Windows, where these runs are made; the chmod below sets it again); utf8 is writeFile's own default for text
    await writeFile(temporary, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
}

export function openKeyring({ path }) {
    return {
        path,

        /** The key kept for an artifact on a site, or null. */
        async get(site, id) {
            const entry = (await load(path)).sites[site]?.[id];
            return entry && keyBytes(entry.key) !== null ? entry.key : null;
        },

        /** Keep an artifact's key; one that is not a key is refused. */
        async remember(site, id, key, title = null) {
            if (keyBytes(key) === null) throw new Error('That is not an artifact\'s key.');
            const store = await load(path);
            store.sites[site] = { ...(store.sites[site] ?? {}), [id]: { key, title, saved_at: new Date().toISOString() } };
            await save(path, store);
        },

        /** Stop keeping an artifact's key; whether there was one. */
        async forget(site, id) {
            const store = await load(path);
            if (!store.sites[site]?.[id]) return false;
            delete store.sites[site][id];
            if (Object.keys(store.sites[site]).length === 0) delete store.sites[site];
            await save(path, store);
            return true;
        },

        /** The artifacts whose keys are kept - never the keys. */
        async list() {
            const store = await load(path);
            return Object.entries(store.sites).flatMap(([site, entries]) => Object.entries(entries).map(([id, entry]) => ({ site, id, title: entry.title ?? null, saved_at: entry.saved_at ?? null })));
        },
    };
}

/** The key store a run uses. */
export function keyringFor(ctx) {
    return openKeyring({ path: keyringPath(ctx.env ?? {}) });
}
