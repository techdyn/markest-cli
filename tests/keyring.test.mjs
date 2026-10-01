/**
 * REGRESSION ANCHOR (D-20261001-01): the keys this machine keeps for artifacts
 * encrypted end to end (cli/sealed/keyring) - where they live on each system,
 * kept by site and artifact, only a key of the right shape, listed without the
 * keys, written readable by its owner alone, and a store this version does not
 * understand never written over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keyringFor, keyringPath, openKeyring } from '../src/sealed/keyring.mjs';
import { freshKeyring } from './support/cli-harness.mjs';

const KEY_A = 'A'.repeat(42) + 'Q';
const KEY_B = 'B'.repeat(42) + 'g';
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SITE = 'https://marke.st';

test('the keys live in the account\'s own settings folder, or where MARKEST_KEYRING says', () => {
    assert.equal(keyringPath({ MARKEST_KEYRING: '/x/keys.json' }, 'linux', '/home/a'), '/x/keys.json');
    assert.equal(keyringPath({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Roaming', 'markest', 'keys.json'));
    assert.equal(keyringPath({}, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a', 'AppData', 'Roaming', 'markest', 'keys.json'));
    assert.equal(keyringPath({}, 'darwin', '/Users/a'), join('/Users/a', 'Library', 'Application Support', 'markest', 'keys.json'));
    assert.equal(keyringPath({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/a'), join('/cfg', 'markest', 'keys.json'));
    assert.equal(keyringPath({}, 'linux', '/home/a'), join('/home/a', '.config', 'markest', 'keys.json'));
    assert.equal(keyringFor({ env: { MARKEST_KEYRING: '/y.json' } }).path, '/y.json');
});

test('a key is kept by site and artifact, found again, listed without itself, and forgotten', async () => {
    const path = await freshKeyring();
    const keyring = openKeyring({ path });
    assert.equal(await keyring.get(SITE, ID), null, 'nothing yet, and no file needed for that');
    await keyring.remember(SITE, ID, KEY_A, 'Plan');
    await keyring.remember('http://localhost:8002', ID, KEY_B, null);
    assert.equal(await keyring.get(SITE, ID), KEY_A);
    assert.equal(await keyring.get('http://localhost:8002', ID), KEY_B, 'each site its own');
    assert.equal(await keyring.get(SITE, '01BX5ZZKBKACTAV9WEVGEMMVRZ'), null);
    const listed = await keyring.list();
    assert.deepEqual(listed.map(({ saved_at, ...one }) => one), [{ site: SITE, id: ID, title: 'Plan' }, { site: 'http://localhost:8002', id: ID, title: null }]);
    assert.ok(!JSON.stringify(listed).includes(KEY_A), 'a listing never shows a key');
    assert.match(listed[0].saved_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(await keyring.forget(SITE, ID), true);
    assert.equal(await keyring.forget(SITE, ID), false);
    assert.equal(await keyring.get(SITE, ID), null);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8')).sites), ['http://localhost:8002'], 'a site with no keys left is gone');
});

test('only a key of the right shape is kept or handed back', async () => {
    const path = await freshKeyring();
    const keyring = openKeyring({ path });
    await assert.rejects(keyring.remember(SITE, ID, 'short'), /not an artifact's key/);
    await writeFile(path, JSON.stringify({ version: 1, sites: { [SITE]: { [ID]: { key: 'tampered' } } } }));
    assert.equal(await keyring.get(SITE, ID), null);
});

test('a store this version does not understand is refused, never written over', async () => {
    for (const text of ['not json', JSON.stringify({ version: 2, sites: {} }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, sites: [] }), 'null']) {
        const path = await freshKeyring();
        await writeFile(path, text);
        const keyring = openKeyring({ path });
        await assert.rejects(keyring.remember(SITE, ID, KEY_A), /not one this version of markest understands; nothing was changed/, text);
        await assert.rejects(keyring.get(SITE, ID), /understands/);
        assert.equal(await readFile(path, 'utf8'), text, 'left as it was');
    }
});

test('the store is readable by its owner alone where the system has such permissions', { skip: process.platform === 'win32' && 'Windows has no owner-only file modes: the profile folder\'s own permissions protect it' }, async () => {
    const path = await freshKeyring();
    await openKeyring({ path }).remember(SITE, ID, KEY_A);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a site keeps every key it is given, forgetting one keeps the rest, and the store is written as people read it', async () => {
    const path = await freshKeyring();
    const keyring = openKeyring({ path });
    await keyring.remember(SITE, ID, KEY_A, 'One');
    await keyring.remember(SITE, '01BX5ZZKBKACTAV9WEVGEMMVRZ', KEY_B, 'Two');
    assert.equal(await keyring.get(SITE, ID), KEY_A, 'the first is not lost to the second');
    assert.equal(await keyring.forget(SITE, ID), true);
    assert.equal(await keyring.get(SITE, '01BX5ZZKBKACTAV9WEVGEMMVRZ'), KEY_B, 'and the other stays');
    const text = await readFile(path, 'utf8');
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + '\n', 'indented, ending in a newline');
});

test('a store that cannot be read is said so, never taken for an empty one', async () => {
    const folder = await freshKeyring();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(folder);
    await assert.rejects(openKeyring({ path: folder }).get(SITE, ID), (error) => error.code === 'EISDIR');
    for (const text of ['5', '"text"', JSON.stringify({ version: 1, sites: null }), JSON.stringify({ version: 1, sites: 'x' })]) {
        const path = await freshKeyring();
        await writeFile(path, text);
        await assert.rejects(openKeyring({ path }).remember(SITE, ID, KEY_A), (error) => error.message === 'The key store at ' + path + ' is not one this version of markest understands; nothing was changed in it.', text);
    }
});
