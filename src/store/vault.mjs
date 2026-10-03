/**
 * @module cli/store/vault
 * @description The command's files of secrets - its sign-in, the keys of
 *              artifacts encrypted end to end - each sealed with AES-256-GCM
 *              under one random key that only the system's secret store holds
 *              (D-20261002-03), so a copy of the settings folder opens nothing.
 *              Each file is bound to what it is (`sign-in`, `keys`), so one
 *              cannot be passed off as the other. The key is made the first
 *              time something is written, and read once a run. A file whose
 *              key is gone - the store emptied, the account's password reset by
 *              an administrator - is said to be unopenable, never overwritten.
 *
 * @input The settings folder and its secret store
 * @output `{ store, read(kind), write(kind, value), remove(kind), exists(kind), ensureKey() }`;
 *         `vaultFor(ctx)`, the run's vault opened when first used; VaultLocked
 * @dependencies node:crypto, node:path, cli/store/private-file, cli/store/settings-folder,
 *               cli/store/secret-store
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readIfThere, removeIfThere, writePrivate } from './private-file.mjs';
import { settingsFolder } from './settings-folder.mjs';
import { secretStoreFor } from './secret-store.mjs';

const VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KINDS = new Set(['sign-in', 'keys']);

/** A file of the vault that cannot be opened: its key is gone, or it is not one of ours. */
export class VaultLocked extends Error {}

/** Why a file of the vault cannot be opened, and what may open it again. */
export function lockedFile(where) {
    return new VaultLocked('The file ' + where + ' cannot be opened: the key that opens it is not in this machine\'s secret store any more. Nothing was changed in it. If the store is locked, unlock it and try again; if the file was kept with MARKEST_SECRET_STORE=file, set that again.');
}

/** The file a kind is kept in. */
export function vaultFile(folder, kind) {
    if (!KINDS.has(kind)) throw new Error('No vault file ' + kind);
    return join(folder, kind + '.vault');
}

const additional = (kind) => Buffer.from('markest-vault-v' + VERSION + ':' + kind);

/** A value sealed under the key, bound to its kind. */
export function seal(key, kind, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(additional(kind));
    const sealed = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { version: VERSION, kind, iv: iv.toString('base64'), data: sealed.toString('base64') };
}

/** The value a sealed file holds, or a VaultLocked when this key does not open it as this kind. */
export function unseal(key, kind, file, where) {
    const locked = lockedFile(where);
    if (!file || file.version !== VERSION || file.kind !== kind || typeof file.iv !== 'string' || typeof file.data !== 'string') throw locked;
    const sealed = Buffer.from(file.data, 'base64');
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent - a shorter text has no whole tag, and the decipher refuses it all the same
    if (sealed.length < 16) throw locked;
    try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(file.iv, 'base64'));
        decipher.setAAD(additional(kind));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        const text = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf8');
        return JSON.parse(text);
    } catch {
        throw locked;
    }
}

export function openVault({ folder, store }) {
    let key = null;

    /**
     * The key, from the store once a run; made and kept there when there is
     * none and one is to be written - but never while a file of the vault is
     * there, which a new key would leave unopenable for good: a store that is
     * only locked, or answers nothing, is not an empty one (found by the review
     * of 2026-10-02).
     */
    async function keyFor({ make }) {
        if (key !== null) return key;
        const kept = await store.read();
        if (kept !== null && kept.length === 32) {
            key = kept;
            return key;
        }
        if (!make) return null;
        for (const kind of KINDS) {
            if ((await readIfThere(vaultFile(folder, kind))) !== null) throw lockedFile(vaultFile(folder, kind));
        }
        const made = randomBytes(32);
        await store.write(made);
        key = made;
        return key;
    }

    async function fileOf(kind) {
        const text = await readIfThere(vaultFile(folder, kind));
        if (text === null) return null;
        try {
            return JSON.parse(text);
        } catch {
            return {};
        }
    }

    return {
        store,
        folder,

        /** Whether a kind's file is there, without opening it. */
        async exists(kind) {
            return (await readIfThere(vaultFile(folder, kind))) !== null;
        },

        /** What a kind's file holds, or null when there is none. */
        async read(kind) {
            const file = await fileOf(kind);
            if (file === null) return null;
            const opening = await keyFor({ make: false });
            if (opening === null) throw lockedFile(vaultFile(folder, kind));
            return unseal(opening, kind, file, vaultFile(folder, kind));
        },

        /** Keep a value, sealed, as a kind's file; the key is made if there is none. */
        async write(kind, value) {
            // A file there that this key cannot open is never written over: what it holds would be lost
            if ((await fileOf(kind)) !== null) await this.read(kind);
            const sealing = await keyFor({ make: true });
            await writePrivate(vaultFile(folder, kind), JSON.stringify(seal(sealing, kind, value)) + '\n');
        },

        /** A kind's file gone; whether it was there. */
        remove(kind) {
            return removeIfThere(vaultFile(folder, kind));
        },

        /** Make sure there is a key to write with, so a store that cannot be used says so before anything is asked. */
        async ensureKey() {
            await keyFor({ make: true });
        },
    };
}

/**
 * The vault a run keeps its secrets in: its settings folder, its secret store
 * chosen the first time it is opened, and opened once however often asked.
 * Kept in the plain file because `--insecure-storage` chose it once, every
 * save says so (`warn`); MARKEST_SECRET_STORE=file is a choice made again on
 * every run - a container's, a test's - and is not reminded.
 */
export function vaultFor({ env = {}, platform = process.platform, run, warn = () => {} } = {}) {
    const folder = settingsFolder(env, platform);
    let opening = null;
    const remind = (store, kind) => {
        if (!store.secure && env.MARKEST_SECRET_STORE !== 'file') warn('markest: ' + vaultFile(folder, kind) + ' is opened by ' + store.label + '.\n');
    };
    return {
        folder,
        open() {
            opening ??= secretStoreFor({ env, platform, folder, ...(run ? { run } : {}) }).then((store) => {
                const vault = openVault({ folder, store });
                const write = vault.write.bind(vault);
                vault.write = async (kind, value) => {
                    await write(kind, value);
                    remind(store, kind);
                };
                return vault;
            });
            return opening;
        },
    };
}
