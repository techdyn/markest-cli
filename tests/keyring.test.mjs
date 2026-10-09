/**
 * Regression test: the keys this machine
 * keeps for artifacts encrypted end to end (cli/sealed/keyring) - kept by site
 * and artifact in the vault, sealed, only a key of the right shape, listed
 * without the keys; the keys an earlier version kept in the clear moved into
 * the vault and that file removed once the vault holds them; where no secure
 * store can be used, the old file still read and forgotten from, but no key
 * ever written in the clear; and a store this version does not understand
 * never written over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LEGACY_FILE, keyringFor, openKeyring } from '../src/sealed/keyring.mjs';
import { openVault, vaultFile } from '../src/store/vault.mjs';
import { SecretStoreUnavailable } from '../src/store/secret-store.mjs';
import { freshHome, homeEnv, testKeyring } from './support/cli-harness.mjs';

const KEY_A = 'A'.repeat(42) + 'Q';
const KEY_B = 'B'.repeat(42) + 'g';
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const SITE = 'https://marke.st';

/** A vault whose secret store cannot be used, as on a server with no keyring. */
function noStore(folder) {
    const store = {
        kind: 'secret-service', secure: true, label: 'none',
        async read() { return null; },
        async write() { throw new SecretStoreUnavailable('The Secret Service cannot be used here (it is not installed).'); },
        async forget() { return false; },
    };
    return openKeyring({ vault: { folder, open: async () => openVault({ folder, store }) } });
}

test('the keys are kept in the run\'s own vault, in its settings folder', async () => {
    const home = await freshHome();
    const keyring = keyringFor({ env: homeEnv(home) });
    assert.equal(keyring.path, join(home, 'keys.vault'));
    const shared = { folder: home, open: () => { throw new Error('opened'); } };
    assert.equal(keyringFor({ vault: shared, env: {} }).path, join(home, 'keys.vault'), 'the vault its context already opened');
    assert.equal(keyringFor({ vault: shared }).path, join(home, 'keys.vault'), 'and a context with no environment, as a tool\'s may be');
});

test('a key is kept by site and artifact, sealed, found again, listed without itself, and forgotten', async () => {
    const home = await freshHome();
    const keyring = testKeyring(home);
    assert.equal(await keyring.get(SITE, ID), null, 'nothing yet, and no file needed for that');
    await keyring.remember(SITE, ID, KEY_A, 'Plan');
    await keyring.remember('http://localhost:8002', ID, KEY_B, null);
    assert.ok(!(await readFile(vaultFile(home, 'keys'), 'utf8')).includes(KEY_A), 'sealed, never in the clear');
    assert.equal(await keyring.get(SITE, ID), KEY_A);
    assert.equal(await keyring.get('http://localhost:8002', ID), KEY_B, 'each site its own');
    assert.equal(await keyring.get(SITE, OTHER), null);
    const listed = await keyring.list();
    assert.deepEqual(listed.map(({ saved_at, ...one }) => one), [{ site: SITE, id: ID, title: 'Plan' }, { site: 'http://localhost:8002', id: ID, title: null }]);
    assert.ok(!JSON.stringify(listed).includes(KEY_A), 'a listing never shows a key');
    assert.match(listed[0].saved_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(await keyring.forget(SITE, ID), true);
    assert.equal(await keyring.forget(SITE, ID), false);
    assert.equal(await keyring.get(SITE, ID), null);
    const kept = await (await testKeyring(home).list());
    assert.deepEqual(kept.map((one) => one.site), ['http://localhost:8002'], 'a site with no keys left is gone');
});

test('only a key of the right shape is kept or handed back', async () => {
    const home = await freshHome();
    const keyring = testKeyring(home);
    await assert.rejects(keyring.remember(SITE, ID, 'short'), /not an artifact's key/);
    const vault = await (await import('./support/cli-harness.mjs')).testVault(home).open();
    await vault.write('keys', { version: 1, sites: { [SITE]: { [ID]: { key: 'tampered' } } } });
    assert.equal(await keyring.get(SITE, ID), null);
});

test('a site keeps every key it is given, and forgetting one keeps the rest', async () => {
    const keyring = testKeyring(await freshHome());
    await keyring.remember(SITE, ID, KEY_A, 'One');
    await keyring.remember(SITE, OTHER, KEY_B, 'Two');
    assert.equal(await keyring.get(SITE, ID), KEY_A, 'the first is not lost to the second');
    assert.equal(await keyring.forget(SITE, ID), true);
    assert.equal(await keyring.get(SITE, OTHER), KEY_B, 'and the other stays');
});

test('the keys an earlier version kept in the clear move into the vault, and that file goes', async () => {
    const home = await freshHome();
    const legacy = join(home, LEGACY_FILE);
    await writeFile(legacy, JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A, title: 'Old', saved_at: '2026-10-01T00:00:00.000Z' } } } }, null, 2) + '\n');
    const keyring = testKeyring(home);
    await keyring.remember(SITE, OTHER, KEY_B, 'New');
    assert.equal(await keyring.get(SITE, ID), KEY_A, 'the old key kept');
    assert.equal(await keyring.get(SITE, OTHER), KEY_B);
    await assert.rejects(readFile(legacy), { code: 'ENOENT' }, 'the file in the clear removed');
    assert.ok(!(await readFile(vaultFile(home, 'keys'), 'utf8')).includes(KEY_A));
    assert.deepEqual((await testKeyring(home).list()).map((one) => [one.id, one.title, one.saved_at]), [[ID, 'Old', '2026-10-01T00:00:00.000Z'], [OTHER, 'New', (await keyring.list())[1].saved_at]]);
});

test('where both hold a key for one artifact, the vault\'s is kept', async () => {
    const home = await freshHome();
    await testKeyring(home).remember(SITE, ID, KEY_B, 'Vault');
    await writeFile(join(home, LEGACY_FILE), JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A } } } }));
    assert.equal(await testKeyring(home).get(SITE, ID), KEY_B);
    await assert.rejects(readFile(join(home, LEGACY_FILE)), { code: 'ENOENT' });
});

test('with no secure store, the old file is read and forgotten from, and no key is written in the clear', async () => {
    const home = await freshHome();
    const legacy = join(home, LEGACY_FILE);
    const before = JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A, title: 'Old' }, [OTHER]: { key: KEY_B } } } }, null, 2) + '\n';
    await writeFile(legacy, before);
    const keyring = noStore(home);
    assert.equal(await keyring.get(SITE, ID), KEY_A, 'still read');
    assert.equal((await keyring.list()).length, 2);
    await assert.rejects(keyring.remember(SITE, '01CX5ZZKBKACTAV9WEVGEMMVRZ', KEY_A), (error) => error instanceof SecretStoreUnavailable && /No secure store can keep keys on this machine\. The key was not kept; the link holds it\. .*--insecure-storage.*MARKEST_SECRET_STORE=file/.test(error.message));
    assert.equal(await readFile(legacy, 'utf8'), before, 'nothing added to it');
    assert.equal(await keyring.forget(SITE, OTHER), true, 'a key can still be forgotten from it');
    assert.equal(await keyring.get(SITE, OTHER), null);
    assert.ok(!(await readFile(legacy, 'utf8')).includes(KEY_B));
});

test('with no secure store and nothing kept before, keeping a key is refused, saying why', async () => {
    const home = await freshHome();
    await assert.rejects(noStore(home).remember(SITE, ID, KEY_A), (error) => error instanceof SecretStoreUnavailable && error.message.startsWith('The Secret Service cannot be used here (it is not installed). The key was not kept'));
    assert.equal(await noStore(home).get(SITE, ID), null);
    assert.equal(await noStore(home).forget(SITE, ID), false);
});

test('a store this version does not understand is refused, never written over', async () => {
    for (const text of ['not json', JSON.stringify({ version: 2, sites: {} }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, sites: [] }), 'null', '5', '"text"', JSON.stringify({ version: 1, sites: null })]) {
        const home = await freshHome();
        const legacy = join(home, LEGACY_FILE);
        await writeFile(legacy, text);
        const keyring = testKeyring(home);
        await assert.rejects(keyring.remember(SITE, ID, KEY_A), (error) => error.message === 'The key store at ' + legacy + ' is not one this version of markest understands; nothing was changed in it.', text);
        await assert.rejects(keyring.get(SITE, ID), /understands/);
        assert.equal(await readFile(legacy, 'utf8'), text, 'left as it was');
    }
    const home = await freshHome();
    const vault = await (await import('./support/cli-harness.mjs')).testVault(home).open();
    await vault.write('keys', { version: 3 });
    await assert.rejects(testKeyring(home).get(SITE, ID), (error) => error.message === 'The key store at ' + vaultFile(home, 'keys') + ' is not one this version of markest understands; nothing was changed in it.');
});

test('a store that cannot be read is said so, never taken for an empty one', async () => {
    const home = await freshHome();
    await mkdir(join(home, LEGACY_FILE));
    await assert.rejects(testKeyring(home).get(SITE, ID), (error) => error.code === 'EISDIR');
});

test('keys 0.2.0 kept where MARKEST_KEYRING said move into the vault too (found by the review of 2026-10-02)', async () => {
    const home = await freshHome();
    const elsewhere = join(await freshHome(), 'my-keys.json');
    await writeFile(elsewhere, JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A, title: 'Kept elsewhere' } } } }));
    const keyring = keyringFor({ env: homeEnv(home, { MARKEST_KEYRING: elsewhere }) });
    assert.equal(await keyring.get(SITE, ID), KEY_A);
    await assert.rejects(readFile(elsewhere), { code: 'ENOENT' }, 'moved, and the file in the clear removed');
    assert.equal(await testKeyring(home).get(SITE, ID), KEY_A, 'into the vault of the folder the run keeps');
});

test('the old file and the vault holding one site for different artifacts are merged, every key kept', async () => {
    const home = await freshHome();
    await testKeyring(home).remember(SITE, OTHER, KEY_B, 'In the vault');
    await writeFile(join(home, LEGACY_FILE), JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A, title: 'In the old file' } } } }));
    const keyring = testKeyring(home);
    assert.equal(await keyring.get(SITE, ID), KEY_A);
    assert.equal(await keyring.get(SITE, OTHER), KEY_B);
});

test('a vault that does not give back what the old file held leaves the old file where it is', async () => {
    const home = await freshHome();
    const legacy = join(home, LEGACY_FILE);
    const before = JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A } } } });
    await writeFile(legacy, before);
    // A vault whose writes come to nothing, as a store that took the key and lost the file would
    const forgetful = { folder: home, open: async () => ({ read: async () => null, write: async () => {}, exists: async () => false }) };
    assert.equal(await openKeyring({ vault: forgetful }).get(SITE, ID), KEY_A);
    assert.equal(await readFile(legacy, 'utf8'), before, 'not removed: the vault never held its keys');
});

test('a fault other than no secure store is passed on, never taken for one', async () => {
    const home = await freshHome();
    await writeFile(join(home, LEGACY_FILE), JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A } } } }));
    const broken = { folder: home, open: async () => ({ read: async () => null, write: async () => { throw new Error('the disk is full'); }, exists: async () => false }) };
    await assert.rejects(openKeyring({ vault: broken }).get(SITE, ID), /the disk is full/);
});

test('the old file, forgotten from with no secure store, is written as people read it', async () => {
    const home = await freshHome();
    const legacy = join(home, LEGACY_FILE);
    await writeFile(legacy, JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: KEY_A }, [OTHER]: { key: KEY_B } } } }));
    await noStore(home).forget(SITE, OTHER);
    const text = await readFile(legacy, 'utf8');
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + '\n', 'indented, ending in a newline');
});

test('a site with no keys left is gone from the vault', async () => {
    const home = await freshHome();
    const keyring = testKeyring(home);
    await keyring.remember(SITE, ID, KEY_A);
    await keyring.remember('http://localhost:8002', ID, KEY_B);
    await keyring.forget(SITE, ID);
    const { testVault } = await import('./support/cli-harness.mjs');
    assert.deepEqual(Object.keys((await (await testVault(home).open()).read('keys')).sites), ['http://localhost:8002']);
});
