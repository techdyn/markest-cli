/**
 * REGRESSION ANCHOR (D-20261002-03, D-20261002-04): what this machine keeps of
 * each site it is signed in to (cli/auth/sign-in-store) - in the vault, by
 * site, a sign-in beside a kept key, the vault opened only when there is a
 * file, and the file gone once no site is left.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openSignIns } from '../src/auth/sign-in-store.mjs';
import { freshHome, testVault } from './support/cli-harness.mjs';

const SITE = 'https://marke.st';
const OTHER = 'http://127.0.0.1:8002';
const RECORD = { access_token: 'eyJ.a.b', refresh_token: 'r#1 kept', expires_at: 1, scope: 'pastes.read', signed_in_at: '2026-10-02T09:00:00.000Z' };

test('a sign-in and a key are kept by site, side by side, and forgotten apart or together', async () => {
    const home = await freshHome();
    const signIns = openSignIns({ vault: testVault(home) });
    assert.equal(await signIns.get(SITE), null);
    assert.deepEqual(await signIns.forget(SITE), [], 'nothing to forget, and no file made for that');
    assert.deepEqual(await readdir(home), []);

    await signIns.putOAuth(SITE, RECORD);
    await signIns.putKey(SITE, 'mk_live_x');
    await signIns.putOAuth(OTHER, { ...RECORD, refresh_token: 'r2' });
    const kept = await signIns.get(SITE);
    assert.deepEqual(kept.oauth, RECORD);
    assert.equal(kept.key.key, 'mk_live_x');
    assert.match(kept.key.saved_at, /^\d{4}-/);
    assert.equal((await signIns.get(OTHER)).oauth.refresh_token, 'r2', 'each site its own');
    assert.ok(!(await readFile(join(home, 'sign-in.vault'), 'utf8')).includes('r#1 kept'), 'sealed: looked for with characters base64 never holds, so no ciphertext matches it by chance');

    assert.deepEqual(await signIns.forget(SITE, 'key'), ['key']);
    assert.deepEqual(Object.keys(await signIns.get(SITE)), ['oauth']);
    assert.deepEqual(await signIns.forget(SITE, 'key'), [], 'already gone');
    assert.deepEqual(await signIns.forget(SITE), ['oauth']);
    assert.equal(await signIns.get(SITE), null);
    assert.deepEqual(await signIns.forget(OTHER, 'oauth'), ['oauth']);
    assert.ok(!(await readdir(home)).includes('sign-in.vault'), 'no site left: the file is gone');
});

test('the vault is not opened, nor its key asked for, when there is no sign-in file', async () => {
    const home = await freshHome();
    let reads = 0;
    const vault = { folder: home, open: async () => ({ exists: async () => false, read: async () => { reads++; return null; } }) };
    assert.equal(await openSignIns({ vault }).get(SITE), null);
    assert.equal(reads, 0);
});

test('a sign-in this version does not understand is refused, never written over', async () => {
    const home = await freshHome();
    const vault = testVault(home);
    await (await vault.open()).write('sign-in', { version: 2, sites: {} });
    const before = await readFile(join(home, 'sign-in.vault'), 'utf8');
    for (const work of [(s) => s.get(SITE), (s) => s.putKey(SITE, 'k'), (s) => s.forget(SITE)]) {
        await assert.rejects(work(openSignIns({ vault })), /not one this version of markest understands; nothing was changed/);
    }
    assert.equal(await readFile(join(home, 'sign-in.vault'), 'utf8'), before);
    for (const value of [[], 5, { version: 1 }, { version: 1, sites: [] }, { version: 1, sites: 'x' }]) {
        const fresh = testVault(await freshHome());
        await (await fresh.open()).write('sign-in', value);
        await assert.rejects(openSignIns({ vault: fresh }).get(SITE), /understands/, JSON.stringify(value));
    }
});

test('the store the vault\'s key is in is named, for status to say', async () => {
    const store = await openSignIns({ vault: testVault(await freshHome()) }).store();
    assert.equal(store.kind, 'file');
    assert.equal(store.secure, false);
});

test('a sign-in kept after a key keeps the key, and forgetting what is not there writes nothing', async () => {
    const home = await freshHome();
    const signIns = openSignIns({ vault: testVault(home) });
    await signIns.putKey(SITE, 'mk_live_kept');
    await signIns.putOAuth(SITE, RECORD);
    const kept = await signIns.get(SITE);
    assert.equal(kept.key.key, 'mk_live_kept', 'the key is not lost to the sign-in');
    assert.deepEqual(kept.oauth, RECORD);

    await signIns.putOAuth(OTHER, RECORD);
    const before = await readFile(join(home, 'sign-in.vault'), 'utf8');
    assert.deepEqual(await signIns.forget('https://never.example'), [], 'a site not kept, beside others that are');
    assert.deepEqual(await signIns.forget(OTHER, 'key'), [], 'a part not kept');
    assert.equal(await readFile(join(home, 'sign-in.vault'), 'utf8'), before, 'nothing was written for either');
});
