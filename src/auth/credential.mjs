/**
 * @module cli/auth/credential
 * @description The credential a run speaks to the site with (D-20261002-04):
 *              the OAuth sign-in kept for the site first, as the account holder
 *              asked; else an API key - MARKEST_API_KEY (or MARKEST_KEY), then
 *              one kept with `markest login --with-key`; else none.
 *              MARKEST_AUTH=key uses only a key, MARKEST_AUTH=oauth only the
 *              sign-in. A sign-in's access token is refreshed a minute before it
 *              lapses, or when the site refuses it, under a lock so two
 *              commands never refresh one sign-in at once; one the site has
 *              ended is forgotten here and said, never swapped for another
 *              credential mid-run. Every token it holds is named for the
 *              messages that must never show one.
 *
 * @input The environment; the site; the run's vault; a fetch
 * @output `{ kind, source, present, scope, bearer(), renew(), secrets() }`, or `{ error }`
 * @dependencies node:path, cli/core/site-args, cli/auth/oauth, cli/auth/sign-in-store,
 *               cli/store/file-lock, cli/store/vault
 */

import { join } from 'node:path';
import { keyFrom } from '../core/site-args.mjs';
import { AuthError, clientIdFor, refreshTokens } from './oauth.mjs';
import { openSignIns } from './sign-in-store.mjs';
import { withLock } from '../store/file-lock.mjs';

/** How long before an access token lapses it is refreshed. */
export const EARLY_MS = 60000;

/** The ways MARKEST_AUTH may choose. */
export const MODES = ['', 'key', 'oauth'];

/** The sign-in record kept from a token response, carried on from the one before. */
export function recordFrom(tokens, previous = {}, now = Date.now) {
    return {
        client_id: previous.client_id ?? null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? previous.refresh_token,
        expires_at: now() + (Number(tokens.expires_in) || 3600) * 1000,
        scope: tokens.scope ?? previous.scope ?? '',
        signed_in_at: previous.signed_in_at ?? new Date(now()).toISOString(),
    };
}

/** No credential: what needs none still runs. */
export const NONE = Object.freeze({
    kind: 'none', source: null, present: false, scope: null,
    bearer: async () => '', renew: async () => false, secrets: () => [],
});

/** An API key, from the environment or kept here. */
export function keyCredential(key, source) {
    return {
        kind: 'key', source, present: true, scope: null, key,
        bearer: async () => key,
        renew: async () => false,
        secrets: () => [key],
    };
}

/** The sign-in, its access token refreshed when it lapses or is refused. */
export function oauthCredential({ site, record, signIns, lockPath, fetch, version, now = Date.now, lock = withLock, warn = () => {} }) {
    let current = record;
    // Called only with a record: the sign-in this run holds, or one found kept
    const lapsing = (one) => !one.access_token || one.expires_at - EARLY_MS <= now();

    async function refresh() {
        await lock(lockPath, async () => {
            // Another command may have refreshed it while this one waited
            const latest = (await signIns.get(site))?.oauth ?? null;
            if (latest && latest.access_token !== current.access_token && !lapsing(latest)) {
                current = latest;
                return;
            }
            let tokens;
            try {
                tokens = await refreshTokens({ site, refreshToken: (latest ?? current).refresh_token, fetch, version });
            } catch (error) {
                if (error instanceof AuthError && error.code === 'invalid_grant') {
                    await signIns.forget(site, 'oauth');
                    throw new AuthError('Your sign-in to ' + site + ' has ended (' + error.message + '). Run markest login to sign in again.', { code: 'invalid_grant', status: 401 });
                }
                throw error;
            }
            current = recordFrom(tokens, latest ?? current, now);
            // The site has already retired the refresh token this replaced: a pair
            // that cannot be kept is still this run's, and said, so the run goes
            // on rather than throw away the one sign-in it holds (found by the
            // review of 2026-10-02)
            try {
                await signIns.putOAuth(site, current);
            } catch (error) {
                warn('markest: the refreshed sign-in could not be kept here (' + error.message + '); this run goes on with it. If a later run says the sign-in has ended, run markest login.\n');
            }
        });
    }

    return {
        kind: 'oauth', source: 'sign-in', present: true,
        get scope() { return current.scope; },
        async bearer() {
            if (lapsing(current)) await refresh();
            return current.access_token;
        },
        async renew() {
            await refresh();
            return true;
        },
        // Redaction passes over one that is not there
        secrets: () => [current.access_token, current.refresh_token],
    };
}

/** The credential a run uses, in the order the account holder chose. */
export async function credentialFor({ env = {}, site, vault, fetch, version, now = Date.now, warn = () => {} }) {
    const mode = env.MARKEST_AUTH ?? '';
    if (!MODES.includes(mode)) return { error: 'MARKEST_AUTH is key or oauth, or not set.' };
    const envKey = keyFrom(env);
    if (mode === 'key' && envKey !== '') return keyCredential(envKey, 'env');

    const signIns = openSignIns({ vault });
    let kept = null;
    try {
        kept = await signIns.get(site);
    } catch (error) {
        // The sign-in cannot be opened: a key that is there still serves, saying why the sign-in did not
        if (mode !== 'oauth' && envKey !== '') {
            warn('markest: the sign-in kept here cannot be opened, so MARKEST_API_KEY is used: ' + error.message + '\n');
            return keyCredential(envKey, 'env');
        }
        throw error;
    }

    if (mode !== 'key' && kept?.oauth?.refresh_token) {
        return oauthCredential({
            site,
            record: { client_id: clientIdFor(site), ...kept.oauth },
            signIns,
            lockPath: join(vault.folder, 'sign-in.lock'),
            fetch,
            version,
            now,
            warn,
        });
    }
    if (mode !== 'oauth') {
        if (envKey !== '') return keyCredential(envKey, 'env');
        if (kept?.key?.key) return keyCredential(kept.key.key, 'stored');
    }
    return NONE;
}
