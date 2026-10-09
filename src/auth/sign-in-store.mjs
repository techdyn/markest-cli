/**
 * @module cli/auth/sign-in-store
 * @description What this machine keeps of each site it is signed in to, in the
 *              command's vault (`sign-in.vault`): the OAuth
 *              sign-in - its tokens, when the access token lapses, what it was
 *              allowed, when it was made - and an API key kept with
 *              `markest login --with-key`. Nothing here opens the vault, or asks
 *              the secret store for its key, unless there is a sign-in file to
 *              open; the file goes once no site is left in it.
 *
 * @input A run's vault; a site
 * @output `{ get(site), putOAuth(site, record), putKey(site, key), forget(site, what), store() }`
 * @dependencies None
 */

const empty = () => ({ version: 1, sites: {} });

function understood(parsed) {
    // Anything but an object of version 1 - null, a number, a list - has no version 1
    if (parsed?.version !== 1 || !parsed.sites || typeof parsed.sites !== 'object' || Array.isArray(parsed.sites)) {
        throw new Error('The sign-in kept on this machine is not one this version of markest understands; nothing was changed in it.');
    }
    return parsed;
}

export function openSignIns({ vault }) {
    async function load() {
        const opened = await vault.open();
        return { opened, kept: understood((await opened.read('sign-in')) ?? empty()) };
    }

    async function save(opened, kept) {
        if (Object.keys(kept.sites).length === 0) await opened.remove('sign-in');
        else await opened.write('sign-in', kept);
    }

    return {
        /** What is kept for a site, or null; the vault is opened only when there is a file to open. */
        async get(site) {
            const opened = await vault.open();
            if (!(await opened.exists('sign-in'))) return null;
            return (await load()).kept.sites[site] ?? null;
        },

        /** Keep a site's OAuth sign-in, beside any key kept for it. */
        async putOAuth(site, record) {
            const { opened, kept } = await load();
            kept.sites[site] = { ...(kept.sites[site] ?? {}), oauth: record };
            await save(opened, kept);
        },

        /** Keep an API key for a site, beside any sign-in. */
        async putKey(site, key) {
            const { opened, kept } = await load();
            kept.sites[site] = { ...(kept.sites[site] ?? {}), key: { key, saved_at: new Date().toISOString() } };
            await save(opened, kept);
        },

        /** Forget a site's sign-in, its key, or both; what was there to forget. */
        async forget(site, what = 'all') {
            // With no file there is nothing to read, and no key is asked for that
            const { opened, kept } = await load();
            const entry = kept.sites[site];
            if (!entry) return [];
            const parts = (what === 'all' ? ['oauth', 'key'] : [what]).filter((part) => entry[part] !== undefined);
            for (const part of parts) delete entry[part];
            if (Object.keys(entry).length === 0) delete kept.sites[site];
            if (parts.length > 0) await save(opened, kept);
            return parts;
        },

        /** The secret store the vault's key is kept in, as `markest status` names it. */
        async store() {
            return (await vault.open()).store;
        },
    };
}
