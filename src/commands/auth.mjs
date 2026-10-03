/**
 * @module cli/commands/auth
 * @description `markest login`, `markest logout` and `markest status`
 *              (D-20261002-04). Signing in is OAuth by default: the browser on
 *              this machine, the code handed back to a port here; where no
 *              browser opens - over SSH, or a Linux with no display - or with
 *              `--device`, a code its person types at the site. An API key can
 *              be kept instead (`--with-key`, read from stdin, checked with the
 *              site first). Whatever is kept goes into the vault the system's
 *              secret store opens; where there is none, signing in is refused
 *              unless `--insecure-storage` chooses a file only the account can
 *              read. Signing out ends the sign-in on the site and forgets it
 *              here. `status` says which credential runs use, and where it is
 *              kept, never showing it.
 *
 * @input The commands' flags; a run's context; stdin for --with-key
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/output, cli/core/api-client, cli/auth/oauth,
 *               cli/auth/loopback, cli/auth/browser, cli/auth/credential, cli/auth/sign-in-store,
 *               cli/store/vault, cli/store/secret-store
 */

import { answer, readAll, Refused, when } from '../core/command-kit.mjs';
import { printable } from '../core/output.mjs';
import { createClient } from '../core/api-client.mjs';
import { AuthError, authorizeUrl, clientIdFor, exchangeCode, newState, pkce, pollDevice, revoke, startDevice } from '../auth/oauth.mjs';
import { listen } from '../auth/loopback.mjs';
import { canOpenBrowser, openBrowser } from '../auth/browser.mjs';
import { credentialFor, recordFrom } from '../auth/credential.mjs';
import { openSignIns } from '../auth/sign-in-store.mjs';
import { openVault, VaultLocked } from '../store/vault.mjs';
import { choosePlainFile, fileStore, SecretStoreUnavailable } from '../store/secret-store.mjs';

const KEY_SHAPE = /^mk_[a-z]+_[0-9a-f]{16,}$/;

/** What a sign-in allows, in words. */
export function allowed(scope) {
    // A sign-in with no scope said is one allowed nothing: String(null) holds neither word
    const scopes = String(scope).split(' ');
    const words = [scopes.includes('pastes.read') && 'read', scopes.includes('pastes.write') && 'write'].filter(Boolean);
    return words.length > 0 ? words.join(' and ') : 'nothing';
}

/** A refusal from signing in, said as the command's own. */
const refusing = (work) => work().catch((error) => {
    throw error instanceof AuthError || error instanceof SecretStoreUnavailable ? new Refused(error.message) : error;
});

/**
 * The vault this sign-in is kept in: the run's, once its store can keep a key;
 * else the plain file, when --insecure-storage chose it, said so.
 */
async function vaultForSigningIn(ctx) {
    const opened = await ctx.vault.open();
    try {
        await opened.ensureKey();
        return opened;
    } catch (error) {
        if (!(error instanceof SecretStoreUnavailable)) throw error;
        if (!ctx.insecureStorage) {
            throw new Refused(error.message + ' Nothing was kept. Set MARKEST_API_KEY instead, or run markest login --insecure-storage to keep the sign-in in a file only your account can read.');
        }
        const plain = openVault({ folder: ctx.vault.folder, store: fileStore(ctx.vault.folder) });
        await plain.ensureKey();
        // Kept for later runs, which would otherwise look in the system's store again
        await choosePlainFile(ctx.vault.folder);
        ctx.stderr.write('markest: no secure store can be used here, so the sign-in is kept in ' + plain.store.label + '.\n');
        return plain;
    }
}

/** The browser on this machine, and the code it hands back to a port here. */
async function signInWithBrowser(ctx) {
    const { verifier, challenge } = pkce();
    const state = newState();
    const listener = listen({ state, issuer: ctx.baseUrl, ...(ctx.waitMs ? { timeoutMs: ctx.waitMs } : {}) });
    const { redirectUri } = await listener.ready;
    const url = authorizeUrl({ site: ctx.baseUrl, redirectUri, state, challenge });
    ctx.stderr.write('Opening your browser to sign in to ' + ctx.baseUrl + '.\nIf it does not open, go to:\n\n  ' + url + '\n\n');
    // Stryker disable next-line LogicalOperator,ArrowFunction,ObjectLiteral: platform - a mutant here would open the account holder's own browser from a test, which hands in its own
    await (ctx.browser ?? ((address) => openBrowser(address, { env: ctx.env })))(url);
    const back = await listener.answer;
    if (back.error) throw new Refused(back.error);
    return { tokens: await exchangeCode({ site: ctx.baseUrl, code: back.code, verifier, redirectUri, fetch: ctx.fetch, version: ctx.version }), via: 'browser' };
}

/** A code its person types at the site, where no browser opens here. */
async function signInWithCode(ctx) {
    const device = await startDevice({ site: ctx.baseUrl, fetch: ctx.fetch, version: ctx.version });
    ctx.stderr.write('To sign in, open this page on any device:\n\n  ' + device.verification_uri + '\n\nand enter the code\n\n  ' + device.user_code
        + '\n\nIt expires in ' + Math.round((Number(device.expires_in) || 600) / 60) + ' minutes. Enter it only at ' + ctx.baseUrl + ', and only if you started this.\n');
    return { tokens: await pollDevice({ site: ctx.baseUrl, device, fetch: ctx.fetch, version: ctx.version, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) }), via: 'code' };
}

const login = {
    name: 'login',
    summary: 'Sign in to Markest (in the browser, or with a code)',
    usage: 'markest login [--device] [--with-key] [--insecure-storage]',
    help: `Sign in to Markest, so the other commands act as your account.

Usage:
  markest login                  Sign in in your browser
  markest login --device         Sign in with a code you type at marke.st on
                                 any device (chosen by itself over SSH)
  markest login --with-key       Keep an API key instead, read from stdin:
                                 markest login --with-key < key.txt

You choose what to allow on the site: reading, writing, or both. The sign-in
is kept in your system's secret store - the Keychain, the Secret Service, or
Windows' Data Protection API - and refreshed by itself; markest logout ends it.
Where there is no secure store, --insecure-storage keeps it in a file only
your account can read.

Runs use the sign-in first, then MARKEST_API_KEY, then a kept key;
MARKEST_AUTH=key or MARKEST_AUTH=oauth uses only that one.
`,
    flags: { device: { type: 'boolean' }, 'with-key': { type: 'boolean' }, 'insecure-storage': { type: 'boolean' } },
    parse(values, positionals) {
        if (positionals.length > 0) return { usageError: 'markest login takes no arguments: ' + login.usage };
        if (values.device && values['with-key']) return { usageError: 'Sign in with a code or keep a key, one at a time' };
        return { device: Boolean(values.device), withKey: Boolean(values['with-key']), insecureStorage: Boolean(values['insecure-storage']) };
    },
    credential: false,
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        return answer(ctx, () => refusing(async () => {
            if (ctx.withKey) {
                const key = (await readAll(ctx.stdin)).trim();
                if (!KEY_SHAPE.test(key)) throw new Refused('Pipe an API key from your account settings on stdin: markest login --with-key < key.txt');
                // Asked of the site first, so a wrong key is never kept
                await createClient({ baseUrl: ctx.baseUrl, key, fetch: ctx.fetch, version: ctx.version }).request('GET', '/api/v1/pastes', { query: { limit: '1' }, idempotent: true });
                const vault = await vaultForSigningIn(ctx);
                await openSignIns({ vault: { folder: ctx.vault.folder, open: async () => vault } }).putKey(ctx.baseUrl, key);
                return { site: ctx.baseUrl, signed_in: true, method: 'key', kept_in: vault.store.label };
            }
            const vault = await vaultForSigningIn(ctx);
            const signIns = openSignIns({ vault: { folder: ctx.vault.folder, open: async () => vault } });
            // Stryker disable next-line ArrowFunction: equivalent - a sign-in that cannot be read is no sign-in to end, null or undefined alike
            const before = await signIns.get(ctx.baseUrl).catch(() => null);
            const byCode = ctx.device || !canOpenBrowser(ctx.env);
            const { tokens, via } = byCode ? await signInWithCode(ctx) : await signInWithBrowser(ctx);
            const record = recordFrom(tokens, { client_id: clientIdFor(ctx.baseUrl) });
            await signIns.putOAuth(ctx.baseUrl, record);
            // The sign-in this one replaces is ended on the site, not left to lapse
            if (before?.oauth?.refresh_token) await revoke({ site: ctx.baseUrl, token: before.oauth.refresh_token, fetch: ctx.fetch, version: ctx.version }).catch(() => {});
            return { site: ctx.baseUrl, signed_in: true, method: 'oauth', via, scope: record.scope, kept_in: vault.store.label };
        }), (done) => (done.method === 'key'
            ? 'Kept your API key for ' + done.site + ', in ' + done.kept_in + '.\n'
            : 'Signed in to ' + done.site + ': ' + allowed(done.scope) + '. Kept in ' + done.kept_in + '.\n'));
    },
};

const logout = {
    name: 'logout',
    summary: 'Sign out: end the sign-in on the site and forget it here',
    usage: 'markest logout',
    help: `Sign out of Markest: the sign-in is ended on the site - its tokens stop
working everywhere - and forgotten here, with any API key kept with
markest login --with-key. MARKEST_API_KEY is yours to unset.

Usage:
  markest logout
`,
    flags: {},
    parse(values, positionals) {
        return positionals.length > 0 ? { usageError: 'markest logout takes no arguments' } : {};
    },
    credential: false,
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        return answer(ctx, async () => {
            const signIns = openSignIns({ vault: ctx.vault });
            let kept;
            try {
                kept = await signIns.get(ctx.baseUrl);
            } catch (error) {
                if (!(error instanceof VaultLocked)) throw error;
                // What cannot be opened cannot be used: the file goes, and the grant lapses on the site by itself
                await (await ctx.vault.open()).remove('sign-in');
                return { site: ctx.baseUrl, signed_out: true, ended_on_site: false, note: 'The sign-in kept here could not be opened, so it was removed; on the site it lapses by itself within 30 days, or disconnect it in your account settings.' };
            }
            if (kept === null) return { site: ctx.baseUrl, signed_out: false };
            let ended = null;
            let note = null;
            if (kept.oauth?.refresh_token) {
                try {
                    await revoke({ site: ctx.baseUrl, token: kept.oauth.refresh_token, fetch: ctx.fetch, version: ctx.version });
                    ended = true;
                } catch (error) {
                    ended = false;
                    note = 'The site could not be told (' + error.message + '); the sign-in lapses there by itself within 30 days, or disconnect it in your account settings.';
                }
            }
            await signIns.forget(ctx.baseUrl);
            return { site: ctx.baseUrl, signed_out: true, ended_on_site: ended, ...(note ? { note } : {}) };
        }, (done) => {
            if (!done.signed_out) return 'Not signed in to ' + done.site + '.\n';
            return 'Signed out of ' + done.site + '.\n' + (done.note ? printable(done.note) + '\n' : '');
        });
    },
};

const status = {
    name: 'status',
    summary: 'Which credential runs use, and where it is kept',
    usage: 'markest status',
    help: `Say which credential the other commands use for this site - your sign-in,
MARKEST_API_KEY, or a key kept here - what it allows, and where it is kept.
Nothing secret is shown.

Usage:
  markest status
`,
    flags: {},
    parse(values, positionals) {
        return positionals.length > 0 ? { usageError: 'markest status takes no arguments' } : {};
    },
    credential: false,
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        return answer(ctx, async () => {
            const result = { site: ctx.baseUrl, using: null, source: null, scope: null, signed_in_at: null, kept_in: null, secure: null };
            let auth;
            try {
                auth = await credentialFor({ env: ctx.env, site: ctx.baseUrl, vault: ctx.vault, fetch: ctx.fetch, version: ctx.version });
            } catch (error) {
                throw new Refused('The sign-in kept here cannot be opened: ' + error.message + ' Run markest logout, then markest login.');
            }
            if (auth.error) throw new Refused(auth.error);
            result.using = auth.kind === 'none' ? null : auth.kind;
            result.source = auth.source;
            // A key's scope, and no credential's, is null
            result.scope = auth.scope;
            const kept = await openSignIns({ vault: ctx.vault }).get(ctx.baseUrl);
            if (kept !== null) {
                const store = (await ctx.vault.open()).store;
                result.kept_in = store.label;
                result.secure = store.secure;
                result.signed_in_at = kept.oauth?.signed_in_at ?? null;
            }
            return result;
        }, (found) => {
            const using = {
                oauth: 'your sign-in (' + allowed(found.scope) + ')' + (found.signed_in_at ? ', since ' + when(found.signed_in_at) + ' UTC' : ''),
                env: 'the API key in MARKEST_API_KEY',
                stored: 'the API key kept with markest login --with-key',
            }[found.using === 'oauth' ? 'oauth' : found.source];
            return 'Site:     ' + found.site + '\n'
                + 'Using:    ' + (using ?? 'nothing - run markest login, or set MARKEST_API_KEY') + '\n'
                + (found.kept_in ? 'Kept in:  ' + found.kept_in + '\n' : '');
        });
    },
};

export const commands = [login, logout, status];
