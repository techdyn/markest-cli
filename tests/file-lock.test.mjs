/**
 * REGRESSION ANCHOR (D-20261002-04): one command at a time refreshes a sign-in
 * (cli/store/file-lock) - the second waits for the first, a lock a dead command
 * left is taken after a while, and one held too long is said.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../src/store/file-lock.mjs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const folder = () => mkdtemp(join(tmpdir(), 'markest-lock-'));

test('work runs under the lock, which is gone after it, whether the work ends well or not', async () => {
    const where = await folder();
    const path = join(where, 'deep', 'x.lock');
    assert.equal(await withLock(path, async () => (await readdir(join(where, 'deep'))).join()), 'x.lock');
    assert.deepEqual(await readdir(join(where, 'deep')), []);
    await assert.rejects(withLock(path, async () => { throw new Error('inside'); }), /inside/);
    assert.deepEqual(await readdir(join(where, 'deep')), []);
});

test('a second command waits for the first, and runs after it', async (t) => {
    const delays = [];
    const original = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        delays.push(ms);
        return original(callback, ms, ...args);
    });
    const path = join(await folder(), 'x.lock');
    const order = [];
    let release;
    let holding;
    const held = new Promise((resolve) => { holding = resolve; });
    const first = withLock(path, () => new Promise((resolve) => { order.push('first'); release = () => { order.push('first done'); resolve(); }; holding(); }));
    // Only once the first holds it, however slow the machine
    await held;
    // Its own wait between tries, the default
    const second = withLock(path, async () => { order.push('second'); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, ['first']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'first done', 'second']);
    assert.ok(delays.includes(100), 'contention pauses between filesystem attempts');
});

test('a lock left by a command that died is taken; one still held too long is said', async () => {
    const where = await folder();
    const stale = join(where, 'stale.lock');
    await writeFile(stale, '1');
    const old = new Date(Date.now() - 60000);
    await utimes(stale, old, old);
    assert.equal(await withLock(stale, async () => 'ran', { staleMs: 30000 }), 'ran');

    const held = join(where, 'held.lock');
    await writeFile(held, '2');
    let clock = Date.now();
    let waits = 0;
    await assert.rejects(withLock(held, async () => 'never', { waitMs: 1000, now: () => clock, sleep: async () => { waits++; clock += 500; } }), /Another markest command is holding .*held\.lock; try again in a moment\./);
    assert.equal(waits, 3, 'at the boundary it still waits; only past it does it stop');
});

test('a lock is stale only past its time, not at it', async () => {
    const { stat } = await import('node:fs/promises');
    const path = join(await folder(), 'x.lock');
    await writeFile(path, '3');
    const made = (await stat(path)).mtimeMs;
    // A clock that stands still, and a wait already over: one look, and it is said held
    await assert.rejects(withLock(path, async () => 'never', { staleMs: 30000, waitMs: -1, now: () => made + 30000, sleep: async () => {} }), /Another markest command is holding/, 'at its time it is still held');
    assert.equal(await withLock(path, async () => 'ran', { staleMs: 30000, now: () => made + 30001 }), 'ran', 'a moment past it, taken');
});

test('a lock that cannot be made for another reason is said', async () => {
    const where = await folder();
    await writeFile(join(where, 'file'), 'x');
    await assert.rejects(withLock(join(where, 'file', 'x.lock'), async () => 'never'), (error) => ['ENOTDIR', 'EEXIST', 'ENOENT'].includes(error.code));
});

test('a lock removed after the exclusive open fails is retried and acquired', async (t) => {
    const path = join(await folder(), 'gone.lock');
    await writeFile(path, 'another command');
    const original = fs.stat;
    let removed = false;
    const mocked = t.mock.method(fs, 'stat', async (name, ...options) => {
        if (name === path && !removed) {
            removed = true;
            await fs.rm(path);
        }
        return original(name, ...options);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    let waits = 0;
    assert.equal(await withLock(path, async () => 'acquired', { sleep: async () => { waits++; } }), 'acquired');
    assert.equal(removed, true);
    assert.equal(waits, 1, 'the vanished lock is retried without reading its missing timestamp');
    assert.deepEqual(await readdir(join(path, '..')), []);
});

test('a refused exclusive open is reported without treating it as another holder', async (t) => {
    const path = join(await folder(), 'refused.lock');
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const original = fs.open;
    const mocked = t.mock.method(fs, 'open', async (name, ...args) => {
        if (name === path) throw failure;
        return original(name, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(withLock(path, async () => 'never', { waitMs: -1 }), (error) => error === failure);
});

test('a stale lock removed by another command just before cleanup is harmless', async (t) => {
    const path = join(await folder(), 'stale-race.lock');
    await writeFile(path, 'other');
    const old = new Date(Date.now() - 60000);
    await utimes(path, old, old);
    const original = fs.rm;
    let raced = false;
    const mocked = t.mock.method(fs, 'rm', async (name, ...args) => {
        if (name === path && !raced) {
            raced = true;
            await original(name);
        }
        return original(name, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    assert.equal(await withLock(path, async () => 'ran'), 'ran');
    assert.equal(raced, true);
});

test('cleanup succeeds if another command already removed the held lock', async () => {
    const path = join(await folder(), 'removed.lock');
    assert.equal(await withLock(path, async () => { await fs.rm(path); return 'done'; }), 'done');
});
