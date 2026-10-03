/**
 * REGRESSION ANCHOR (D-20261002-03): a file of the command's own
 * (cli/store/private-file) is written whole, readable by its owner alone, read
 * back as text or null, and removed saying whether it was there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIfThere, removeIfThere, writePrivate } from '../src/store/private-file.mjs';

test('a file is written whole into a folder of its own, and read back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'markest-private-'));
    const path = join(root, 'deep', 'folder', 'f.txt');
    assert.equal(await readIfThere(path), null);
    await writePrivate(path, 'one');
    await writePrivate(path, 'two');
    assert.equal(await readIfThere(path), 'two');
    assert.deepEqual(await readdir(join(root, 'deep', 'folder')), ['f.txt'], 'nothing left beside it');
    if (process.platform !== 'win32') {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(join(root, 'deep'))).mode & 0o777, 0o700);
    }
    assert.equal(await removeIfThere(path), true);
    assert.equal(await removeIfThere(path), false);
});

test('a file that cannot be read for another reason is not taken for none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'markest-private-'));
    await assert.rejects(readIfThere(root), (error) => error.code === 'EISDIR');
});
