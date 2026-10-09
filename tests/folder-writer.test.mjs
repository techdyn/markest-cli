/**
 * Regression test: an artifact's documents written into a
 * folder (cli/reading/folder-writer). A path comes from the site, so it is held
 * to the site's rules and to the folder: nothing lands outside it or goes
 * through a link, nothing already there is replaced without force, and one bad
 * path means nothing is written at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeFor, writeDocuments } from '../src/reading/folder-writer.mjs';

const fresh = () => mkdtemp(join(tmpdir(), 'markest-pull-'));

test('a path is the site\'s kind, and lands inside the folder', async () => {
    const root = await fresh();
    assert.equal(placeFor(root, 'docs/a.md').target, join(root, 'docs', 'a.md'));
    assert.equal(placeFor(root, ' a.md ').target, join(root, 'a.md'), 'trimmed, as the site trims it');
    for (const [path, error] of [['../x.md', 'traversal'], ['docs/../../x.md', 'traversal'], ['/etc/passwd', 'absolute'], ['a\\b.md', 'backslash'], ['', 'empty'],
        ['a//b.md', 'empty_segment'], ['./a.md', 'empty_segment'], ['a:b.md', 'forbidden_chars'], ['a\u0000.md', 'forbidden_chars']]) {
        assert.equal(placeFor(root, path).error, error, JSON.stringify(path));
    }
});

test('every document is written at its path, folders made as needed', async () => {
    const root = await fresh();
    const outcome = await writeDocuments(root, [{ path: 'README.md', content: '# Hi\n' }, { path: 'docs/deep/setup.md', content: 'ü\n' }]);
    assert.deepEqual(outcome, { written: ['README.md', 'docs/deep/setup.md'], refused: [] });
    assert.equal(await readFile(join(root, 'docs', 'deep', 'setup.md'), 'utf8'), 'ü\n');
});

test('one bad path, and nothing is written at all', async () => {
    const root = await fresh();
    const outcome = await writeDocuments(root, [{ path: 'good.md', content: 'x' }, { path: '../escape.md', content: 'x' }]);
    assert.deepEqual(outcome, { written: [], refused: [{ path: '../escape.md', reason: 'traversal' }] });
    assert.deepEqual(await readdir(root), []);
});

test('a file already there is left alone unless forced; what is not a file never is', async () => {
    const root = await fresh();
    await writeFile(join(root, 'a.md'), 'mine');
    await mkdir(join(root, 'dir.md'));
    assert.deepEqual((await writeDocuments(root, [{ path: 'a.md', content: 'theirs' }])).refused, [{ path: 'a.md', reason: 'exists' }]);
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), 'mine');
    assert.deepEqual((await writeDocuments(root, [{ path: 'a.md', content: 'theirs' }], { force: true })).written, ['a.md']);
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), 'theirs');
    assert.deepEqual((await writeDocuments(root, [{ path: 'dir.md', content: 'x' }], { force: true })).refused, [{ path: 'dir.md', reason: 'not_a_file' }]);
});

test('a folder on the way that is a link is never gone through', async () => {
    const root = await fresh();
    const elsewhere = await fresh();
    // A junction on Windows, which needs no leave; a symbolic link elsewhere
    await symlink(elsewhere, join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(join(root, 'real', 'deep'), { recursive: true });
    const outcome = await writeDocuments(root, [{ path: 'docs/setup.md', content: 'x' }, { path: 'real/deep/fine.md', content: 'x' }], { force: true });
    assert.deepEqual(outcome, { written: [], refused: [{ path: 'docs/setup.md', reason: 'through_link' }] });
    assert.deepEqual(await readdir(elsewhere), [], 'nothing written through it');
    assert.deepEqual((await writeDocuments(root, [{ path: 'real/deep/fine.md', content: 'x' }])).written, ['real/deep/fine.md'], 'a real folder is fine');
});

test('a link in the place of a document is never written through', async (t) => {
    const root = await fresh();
    const elsewhere = await fresh();
    await writeFile(join(elsewhere, 'target.md'), 'outside');
    try {
        await symlink(join(elsewhere, 'target.md'), join(root, 'file.md'));
    } catch (error) {
        // Windows makes a link to a file only for an administrator or in developer mode
        t.skip('this machine makes no link to a file: ' + error.code);
        return;
    }
    const swapped = await writeDocuments(root, [{ path: 'file.md', content: 'x' }], { force: true });
    assert.deepEqual(swapped.refused, [{ path: 'file.md', reason: 'not_a_file' }]);
    assert.equal(await readFile(join(elsewhere, 'target.md'), 'utf8'), 'outside');
});
