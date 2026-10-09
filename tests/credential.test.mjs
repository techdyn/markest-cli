/**
 * Regression test: the credential a run uses
 * (cli/auth/credential) - the sign-in first, then MARKEST_API_KEY, then a kept
 * key, MARKEST_AUTH choosing one; an access token refreshed before it lapses
 * or when refused, once, under a lock, taking another command's fresh tokens
 * rather than spending the refresh token twice; a sign-in the site ended
 * forgotten and said; a sign-in that cannot be opened giving way to a key
 * that is there, saying why.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EARLY_MS, NONE, credentialFor, keyCredential, recordFrom } from '../src/auth/credential.mjs';
import { openSignIns } from '../src/auth/sign-in-store.mjs';
import { VaultLocked } from '../src/store/vault.mjs';
import { freshHome, testVault } from './support/cli-harness.mjs';

const SITE = 'https://marke.st';
const KEY = 'mk_live_' + 'ef56'.repeat(12);
const NOW = 1_800_000_000_000;

const fresh = (n, expiresIn = 3600) => ({ access_token: 'eyJ' + n, refresh_token: 'r' + n, expires_at: NOW + expiresIn * 1000, scope: 'pastes.read pastes.write', signed_in_at: '2026-10-02T09:00:00.000Z' });

/** A token endpoint that rotates: each refresh token once. */
function tokenEndpoint() {
    const calls = [];
    let n = 100;
    const fetch = async (url, init) => {
        const form = new URLSearchParams(init.body);
        calls.push(form);
        if (form.get('refresh_token') === 'dead') return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'This connection was ended.' }), { status: 400 });
        n++;
        return new Response(JSON.stringify({ access_token: 'eyJ' + n, refresh_token: 'r' + n, expires_in: 3600, scope: 'pastes.read pastes.write' }), { status: 200 });
    };
    return { fetch, calls };
}

async function signedIn(record = fresh(1), key = null) {
    const home = await freshHome();
    const vault = testVault(home);
    const signIns = openSignIns({ vault });
    if (record) await signIns.putOAuth(SITE, record);
    if (key) await signIns.putKey(SITE, key);
    return { home, vault, signIns };
}

test('a token response is kept with when it lapses, carrying on what it does not say', () => {
    const before = { client_id: 'c', refresh_token: 'old', scope: 'pastes.read', signed_in_at: 'then' };
    assert.deepEqual(recordFrom({ access_token: 'a', expires_in: 60 }, before, () => NOW), { client_id: 'c', access_token: 'a', refresh_token: 'old', expires_at: NOW + 60000, scope: 'pastes.read', signed_in_at: 'then' });
    assert.deepEqual(recordFrom({ access_token: 'a', refresh_token: 'new', scope: 's' }, {}, () => NOW), { client_id: null, access_token: 'a', refresh_token: 'new', expires_at: NOW + 3600000, scope: 's', signed_in_at: new Date(NOW).toISOString() });
    assert.equal(recordFrom({ access_token: 'a' }, {}, () => NOW).scope, '');
});

test('no credential, and a key, are what they say', async () => {
    assert.deepEqual([NONE.kind, NONE.present, await NONE.bearer(), await NONE.renew(), NONE.secrets()], ['none', false, '', false, []]);
    const key = keyCredential(KEY, 'env');
    assert.deepEqual([key.kind, key.source, key.present, await key.bearer(), await key.renew(), key.secrets(), key.scope], ['key', 'env', true, KEY, false, [KEY], null]);
});

test('the sign-in first, then MARKEST_API_KEY, then a kept key; MARKEST_AUTH chooses one', async () => {
    const both = await signedIn(fresh(1), KEY + 'k');
    const signedInFirst = await credentialFor({ env: { MARKEST_API_KEY: KEY }, site: SITE, vault: both.vault, now: () => NOW });
    assert.deepEqual([signedInFirst.kind, signedInFirst.source, signedInFirst.scope], ['oauth', 'sign-in', 'pastes.read pastes.write']);
    assert.equal((await credentialFor({ env: { MARKEST_API_KEY: KEY, MARKEST_AUTH: 'key' }, site: SITE, vault: both.vault })).source, 'env');
    assert.equal((await credentialFor({ env: { MARKEST_AUTH: 'key' }, site: SITE, vault: both.vault })).key, KEY + 'k', 'a kept key where the environment has none');
    assert.equal((await credentialFor({ env: { MARKEST_KEY: KEY, MARKEST_AUTH: 'oauth' }, site: SITE, vault: both.vault })).kind, 'oauth');

    const keyOnly = await signedIn(null, KEY + 'k');
    assert.equal((await credentialFor({ env: { MARKEST_API_KEY: KEY }, site: SITE, vault: keyOnly.vault })).key, KEY, 'the environment\'s key before a kept one');
    assert.equal((await credentialFor({ env: {}, site: SITE, vault: keyOnly.vault })).source, 'stored');
    assert.equal((await credentialFor({ env: { MARKEST_AUTH: 'oauth' }, site: SITE, vault: keyOnly.vault })).kind, 'none');
    assert.equal((await credentialFor({ env: {}, site: 'https://elsewhere.example', vault: both.vault })).kind, 'none', 'each site its own');
    assert.equal((await credentialFor({ env: {}, site: SITE, vault: testVault(await freshHome()) })).kind, 'none');
    assert.deepEqual(await credentialFor({ env: { MARKEST_AUTH: 'yes' }, site: SITE, vault: both.vault }), { error: 'MARKEST_AUTH is key or oauth, or not set.' });

    const noRefresh = await signedIn({ access_token: 'eyJx', expires_at: NOW + 999999 });
    assert.equal((await credentialFor({ env: {}, site: SITE, vault: noRefresh.vault })).kind, 'none', 'a sign-in with no refresh token is none');
});

test('a fresh access token is used as it is; one about to lapse is refreshed first, and kept', async () => {
    const { vault } = await signedIn(fresh(1, 3600));
    const site = tokenEndpoint();
    const auth = await credentialFor({ env: {}, site: SITE, vault, fetch: site.fetch, now: () => NOW });
    assert.equal(await auth.bearer(), 'eyJ1');
    assert.equal(site.calls.length, 0);
    assert.deepEqual(auth.secrets(), ['eyJ1', 'r1']);

    const lapsing = await signedIn(fresh(1, (EARLY_MS - 1000) / 1000));
    const soon = await credentialFor({ env: {}, site: SITE, vault: lapsing.vault, fetch: site.fetch, now: () => NOW });
    assert.equal(await soon.bearer(), 'eyJ101');
    assert.equal(site.calls.at(-1).get('refresh_token'), 'r1');
    assert.equal(site.calls.at(-1).get('grant_type'), 'refresh_token');
    const kept = (await lapsing.signIns.get(SITE)).oauth;
    assert.deepEqual([kept.access_token, kept.refresh_token, kept.signed_in_at, kept.expires_at], ['eyJ101', 'r101', '2026-10-02T09:00:00.000Z', NOW + 3600000]);
    assert.equal(await soon.bearer(), 'eyJ101', 'and used as it is after');
    assert.equal(site.calls.length, 1);
});

test('a refused token is refreshed; one another command refreshed meanwhile is taken, not refreshed twice', async () => {
    const { vault, signIns } = await signedIn(fresh(1));
    const site = tokenEndpoint();
    const auth = await credentialFor({ env: {}, site: SITE, vault, fetch: site.fetch, now: () => NOW });
    assert.equal(await auth.renew(), true);
    assert.equal(await auth.bearer(), 'eyJ101');

    // Another command's refresh, kept while this one held the old tokens
    const other = await credentialFor({ env: {}, site: SITE, vault: testVault(vault.folder), fetch: site.fetch, now: () => NOW });
    await signIns.putOAuth(SITE, fresh(7));
    assert.equal(await other.renew(), true);
    assert.equal(await other.bearer(), 'eyJ7', 'the tokens it found');
    assert.equal(site.calls.length, 1, 'no second refresh');
});

test('a sign-in the site has ended is forgotten here, and said', async () => {
    const { vault, signIns } = await signedIn({ ...fresh(1), refresh_token: 'dead' });
    const auth = await credentialFor({ env: {}, site: SITE, vault, fetch: tokenEndpoint().fetch, now: () => NOW });
    await assert.rejects(auth.renew(), (error) => error.code === 'invalid_grant' && error.status === 401 && error.message === 'Your sign-in to https://marke.st has ended (This connection was ended.). Run markest login to sign in again.');
    assert.equal(await signIns.get(SITE), null);
});

test('a refresh the site cannot answer is passed on, and the sign-in kept', async () => {
    const { vault, signIns } = await signedIn(fresh(1, 1));
    const down = async () => new Response('busy', { status: 503 });
    const auth = await credentialFor({ env: {}, site: SITE, vault, fetch: down, now: () => NOW });
    await assert.rejects(auth.bearer(), /HTTP 503/);
    assert.equal((await signIns.get(SITE)).oauth.refresh_token, 'r1');
});

test('a sign-in that cannot be opened gives way to a key that is there, saying why; with none, it is said', async () => {
    const locked = { folder: await freshHome(), open: async () => ({ exists: async () => true, read: async () => { throw new VaultLocked('The file x cannot be opened.'); } }) };
    const said = [];
    const auth = await credentialFor({ env: { MARKEST_API_KEY: KEY }, site: SITE, vault: locked, warn: (text) => said.push(text) });
    assert.equal(auth.key, KEY);
    assert.deepEqual(said, ['markest: the sign-in kept here cannot be opened, so MARKEST_API_KEY is used: The file x cannot be opened.\n']);
    await assert.rejects(credentialFor({ env: {}, site: SITE, vault: locked }), VaultLocked);
    await assert.rejects(credentialFor({ env: { MARKEST_API_KEY: KEY, MARKEST_AUTH: 'oauth' }, site: SITE, vault: locked }), VaultLocked);
    assert.equal((await credentialFor({ env: { MARKEST_API_KEY: KEY, MARKEST_AUTH: 'key' }, site: SITE, vault: locked })).key, KEY, 'a key alone is never held up by the vault');
    assert.equal((await credentialFor({ env: { MARKEST_API_KEY: KEY }, site: SITE, vault: locked })).key, KEY, 'a caller without a warning sink still gets its fallback');
});

test('a token about to lapse that another command already refreshed is taken as it found it', async () => {
    const { vault, signIns } = await signedIn(fresh(1, 1));
    const site = tokenEndpoint();
    const auth = await credentialFor({ env: {}, site: SITE, vault, fetch: site.fetch, now: () => NOW });
    await signIns.putOAuth(SITE, fresh(9));
    assert.equal(await auth.bearer(), 'eyJ9');
    assert.equal(site.calls.length, 0);
});

test('a refreshed pair that cannot be kept is still this run\'s, and said (found by the review of 2026-10-02)', async () => {
    const { vault } = await signedIn(fresh(1, 1));
    const site = tokenEndpoint();
    const said = [];
    const auth = await credentialFor({ env: {}, site: SITE, vault, fetch: site.fetch, now: () => NOW, warn: (text) => said.push(text) });
    // The vault's write of the sign-in fails, as a full disk or a locked file makes it
    const opened = await vault.open();
    const write = opened.write;
    opened.write = async (kind, value) => { if (kind === 'sign-in') throw new Error('disk full'); return write(kind, value); };
    try {
        assert.equal(await auth.bearer(), 'eyJ101', 'the new token, though it could not be kept');
        assert.equal(await auth.bearer(), 'eyJ101', 'and kept for the rest of the run');
        assert.equal(site.calls.length, 1);
        assert.deepEqual(said, ['markest: the refreshed sign-in could not be kept here (disk full); this run goes on with it. If a later run says the sign-in has ended, run markest login.\n']);
    } finally {
        opened.write = write;
    }
});

test('a token is refreshed from the minute before it lapses, not a moment later; one with no access token at once', async () => {
    const site = tokenEndpoint();
    const atTheMinute = await signedIn({ ...fresh(1), expires_at: NOW + EARLY_MS });
    assert.equal(await (await credentialFor({ env: {}, site: SITE, vault: atTheMinute.vault, fetch: site.fetch, now: () => NOW })).bearer(), 'eyJ101');
    const justBefore = await signedIn({ ...fresh(1), expires_at: NOW + EARLY_MS + 1 });
    assert.equal(await (await credentialFor({ env: {}, site: SITE, vault: justBefore.vault, fetch: site.fetch, now: () => NOW })).bearer(), 'eyJ1');
    const noToken = await signedIn({ ...fresh(1), access_token: '' });
    assert.equal(await (await credentialFor({ env: {}, site: SITE, vault: noToken.vault, fetch: site.fetch, now: () => NOW })).bearer(), 'eyJ102');
});

test('a sign-in forgotten by another command while this one refreshed is refreshed from what this one holds', async () => {
    const { vault, signIns } = await signedIn(fresh(1, 1));
    const site = tokenEndpoint();
    const auth = await credentialFor({ env: {}, site: SITE, vault, fetch: site.fetch, now: () => NOW });
    await signIns.forget(SITE);
    assert.equal(await auth.bearer(), 'eyJ101');
    assert.equal(site.calls[0].get('refresh_token'), 'r1', 'the refresh token this run held');
    assert.equal((await signIns.get(SITE)).oauth.signed_in_at, '2026-10-02T09:00:00.000Z', 'kept again, carrying on what it held');
});

test('MARKEST_AUTH=key with a key never opens the vault, and a sign-in that cannot be opened gives way to the environment\'s key', async () => {
    const locked = { folder: await freshHome(), open: async () => ({ exists: async () => true, read: async () => { throw new VaultLocked('locked'); } }) };
    const said = [];
    const keyOnly = await credentialFor({ env: { MARKEST_API_KEY: KEY, MARKEST_AUTH: 'key' }, site: SITE, vault: locked, warn: (text) => said.push(text) });
    assert.deepEqual([keyOnly.source, said], ['env', []], 'not even a warning: the vault was never asked');
    const fallback = await credentialFor({ env: { MARKEST_API_KEY: KEY }, site: SITE, vault: locked, warn: (text) => said.push(text) });
    assert.equal(fallback.source, 'env');
});
