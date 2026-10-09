/**
 * Regression test: the command's files of secrets
 * (cli/store/vault) - sealed with AES-256-GCM under one key only the secret
 * store holds, each bound to what it is, the key made on the first write and
 * read once a run, and a file whose key is gone said to be unopenable and never
 * written over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultLocked, openVault, seal, unseal, vaultFile } from '../src/store/vault.mjs';

/** A secret store in memory, counting its reads and writes. */
function memoryStore(kept = null) {
    const store = {
        kind: 'memory', secure: true, label: 'memory', kept, reads: 0, writes: 0,
        async read() { store.reads++; return store.kept; },
        async write(bytes) { store.writes++; store.kept = Buffer.from(bytes); },
        async forget() { store.kept = null; return true; },
    };
    return store;
}

const folder = () => mkdtemp(join(tmpdir(), 'markest-vault-'));
const SECRET = { sites: { 'https://marke.st': { access_token: 'eyJ.secret.token' } } };

test('a kind\'s file lives in the settings folder, and there are two kinds', () => {
    assert.equal(vaultFile('/m', 'sign-in'), join('/m', 'sign-in.vault'));
    assert.equal(vaultFile('/m', 'keys'), join('/m', 'keys.vault'));
    assert.throws(() => vaultFile('/m', '../x'), /No vault file/);
});

test('a value is sealed, holds nothing in the clear, and opens again', async () => {
    const where = await folder();
    const store = memoryStore();
    const vault = openVault({ folder: where, store });
    assert.equal(await vault.exists('sign-in'), false);
    assert.equal(await vault.read('sign-in'), null, 'nothing, and no key needed for that');
    assert.equal(store.writes, 0);

    await vault.write('sign-in', SECRET);
    assert.equal(store.writes, 1, 'the key made on the first write');
    assert.equal(store.kept.length, 32);
    const onDisk = await readFile(vaultFile(where, 'sign-in'), 'utf8');
    assert.ok(!onDisk.includes('secret') && !onDisk.includes('marke.st'), 'nothing in the clear');
    assert.deepEqual(Object.keys(JSON.parse(onDisk)), ['version', 'kind', 'iv', 'data']);
    assert.deepEqual(await vault.read('sign-in'), SECRET);
    assert.equal(await vault.exists('sign-in'), true);

    await vault.write('keys', { a: 1 });
    assert.equal(store.writes, 1, 'one key for every file');
    assert.equal(store.reads, 1, 'and read from the store once a run');
    const again = openVault({ folder: where, store });
    assert.deepEqual(await again.read('keys'), { a: 1 });
    assert.equal(await again.remove('keys'), true);
    assert.equal(await again.remove('keys'), false);
    assert.equal(await again.read('keys'), null);
});

test('a file is bound to what it is: the sign-in cannot be passed off as the keys', async () => {
    const where = await folder();
    const vault = openVault({ folder: where, store: memoryStore() });
    await vault.write('sign-in', SECRET);
    await writeFile(vaultFile(where, 'keys'), await readFile(vaultFile(where, 'sign-in'), 'utf8'));
    await assert.rejects(vault.read('keys'), VaultLocked);
    const file = JSON.parse(await readFile(vaultFile(where, 'sign-in'), 'utf8'));
    await writeFile(vaultFile(where, 'keys'), JSON.stringify({ ...file, kind: 'keys' }));
    await assert.rejects(vault.read('keys'), VaultLocked, 'relabelled, its bound kind still refuses it');
});

test('a file whose key is gone is said to be unopenable, and never written over', async () => {
    const where = await folder();
    await openVault({ folder: where, store: memoryStore() }).write('keys', { kept: true });
    const before = await readFile(vaultFile(where, 'keys'), 'utf8');

    const emptied = memoryStore();
    const vault = openVault({ folder: where, store: emptied });
    await assert.rejects(vault.read('keys'), (error) => error instanceof VaultLocked && error.message.includes('not in this machine\'s secret store any more') && error.message.includes(vaultFile(where, 'keys')));
    await assert.rejects(vault.write('keys', { kept: false }), VaultLocked);
    assert.equal(await readFile(vaultFile(where, 'keys'), 'utf8'), before, 'what it holds is not lost');
    assert.equal(emptied.writes, 0, 'and no new key was made over it');

    const other = openVault({ folder: where, store: memoryStore(Buffer.alloc(32, 9)) });
    await assert.rejects(other.read('keys'), VaultLocked, 'another key opens nothing');
    const short = openVault({ folder: where, store: memoryStore(Buffer.alloc(16, 9)) });
    await assert.rejects(short.read('keys'), VaultLocked, 'a key of the wrong length is no key');
});

test('a file that is not one of ours is refused, whatever it holds', async () => {
    const key = Buffer.alloc(32, 3);
    const good = seal(key, 'keys', { x: 1 });
    assert.deepEqual(unseal(key, 'keys', good, 'f'), { x: 1 });
    for (const file of [null, {}, { ...good, version: 2 }, { ...good, kind: 'sign-in' }, { ...good, iv: 7 }, { ...good, data: null }, { ...good, data: 'AAAA' }, { ...good, data: good.data.slice(0, -4) + 'AAA=' }]) {
        assert.throws(() => unseal(key, 'keys', file, 'f'), VaultLocked, JSON.stringify(file));
    }
    const where = await folder();
    await writeFile(vaultFile(where, 'keys'), 'not json');
    await assert.rejects(openVault({ folder: where, store: memoryStore(key) }).read('keys'), VaultLocked);
});

test('a key the store cannot keep stops the first write, before anything is written', async () => {
    const where = await folder();
    const store = { async read() { return null; }, async write() { throw new Error('no store'); } };
    const vault = openVault({ folder: where, store });
    await assert.rejects(vault.ensureKey(), /no store/);
    await assert.rejects(vault.write('keys', {}), /no store/);
    assert.equal(await vault.exists('keys'), false);
});

test('ensureKey makes the key once, and finds it after', async () => {
    const store = memoryStore();
    const vault = openVault({ folder: await folder(), store });
    await vault.ensureKey();
    await vault.ensureKey();
    assert.equal(store.writes, 1);
    assert.equal(vault.store, store);
});

test('a run\'s vault is opened once, in its settings folder, with the store chosen for it', async () => {
    const { vaultFor } = await import('../src/store/vault.mjs');
    const home = await folder();
    const vault = vaultFor({ env: { MARKEST_HOME: home, MARKEST_SECRET_STORE: 'file' } });
    assert.equal(vault.folder, home);
    const opened = await vault.open();
    assert.equal(await vault.open(), opened, 'opened once however often asked');
    assert.equal(opened.store.kind, 'file');
    await assert.rejects(vaultFor({ env: { MARKEST_HOME: home, MARKEST_SECRET_STORE: 'dpapi' } }).open(), /MARKEST_SECRET_STORE is file, or not set/);
});

test('kept in the plain file because --insecure-storage chose it, every save says so; MARKEST_SECRET_STORE=file is not reminded', async () => {
    const { vaultFor } = await import('../src/store/vault.mjs');
    const { PLAIN_KEY_FILE, choosePlainFile } = await import('../src/store/secret-store.mjs');
    const home = await folder();
    await writeFile(join(home, PLAIN_KEY_FILE), Buffer.alloc(32, 5).toString('base64') + '\n');
    await choosePlainFile(home);
    const said = [];
    const chosen = vaultFor({ env: { MARKEST_HOME: home }, warn: (text) => said.push(text) });
    await (await chosen.open()).write('keys', { a: 1 });
    await (await chosen.open()).write('sign-in', { b: 2 });
    assert.deepEqual(said, [
        'markest: ' + join(home, 'keys.vault') + ' is opened by a file only your account can read (' + join(home, PLAIN_KEY_FILE) + '), not a secure store.\n',
        'markest: ' + join(home, 'sign-in.vault') + ' is opened by a file only your account can read (' + join(home, PLAIN_KEY_FILE) + '), not a secure store.\n',
    ]);
    assert.deepEqual(await (await chosen.open()).read('keys'), { a: 1 }, 'and what it saved reads back');
    const asked = [];
    const each = vaultFor({ env: { MARKEST_HOME: home, MARKEST_SECRET_STORE: 'file' }, warn: (text) => asked.push(text) });
    await (await each.open()).write('keys', { a: 2 });
    assert.deepEqual(asked, []);
});

test('no new key is made while a file of the vault is there: a store that answers nothing may only be locked (found by the review of 2026-10-02)', async () => {
    const where = await folder();
    await openVault({ folder: where, store: memoryStore() }).write('keys', { kept: 'only here' });
    const answersNothing = memoryStore();
    const vault = openVault({ folder: where, store: answersNothing });
    await assert.rejects(vault.ensureKey(), (error) => error instanceof VaultLocked && error.message.includes(vaultFile(where, 'keys')) && error.message.includes('If the store is locked, unlock it and try again'));
    await assert.rejects(vault.write('sign-in', { token: 'x' }), VaultLocked, 'not for another kind either');
    assert.equal(answersNothing.writes, 0, 'the key the keys need is never replaced');
    assert.equal(await vault.exists('sign-in'), false);
});
