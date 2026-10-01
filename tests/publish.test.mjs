/**
 * What `markest publish` is asked (cli/commands/publish).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, needsKey, command } from '../src/commands/publish.mjs';
import { readFlags } from '../src/core/site-args.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './support/cli-harness.mjs';
import { startFakeMarkest } from './support/fake-markest.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const asked = (argv) => {
    const { values, positionals } = readFlags(argv, command.flags);
    return parse(values, positionals);
};

test('every flag is read', () => {
    assert.deepEqual(asked(['docs', '--title', 'T', '--visibility', 'private', '--default', 'a.md', '--update', ID, '--prune',
        '--ignore', '*.log', '--ignore', 'tmp/', '--allow-file', 'x.json', '--include-output', '--dry-run', '--json']), {
        folder: 'docs',
        options: { title: 'T', visibility: 'private', defaultPath: 'a.md', update: ID, prune: true, ignore: ['*.log', 'tmp/'], allowFiles: ['x.json'], includeOutput: true, dryRun: true, json: true, sealed: false, updateKey: null },
    });
    assert.deepEqual(asked(['docs']).options, {
        title: null, visibility: null, defaultPath: null, update: null, prune: false, ignore: [], allowFiles: [], includeOutput: false, dryRun: false, json: false, sealed: false, updateKey: null,
    });
    assert.equal(asked(['d', '--update', 'https://marke.st/p/' + ID]).options.update, ID, 'an address names it too');
});

test('--sealed is never public, and an update\'s link brings its key', () => {
    const KEY_TEXT = 'A'.repeat(43);
    assert.equal(asked(['d', '--sealed']).options.sealed, true);
    assert.equal(asked(['d', '--sealed', '--visibility', 'private']).options.visibility, 'private');
    assert.match(asked(['d', '--sealed', '--visibility', 'public']).usageError, /never public/);
    const update = asked(['d', '--update', 'https://marke.st/p/' + ID + '/a.md#key=' + KEY_TEXT]).options;
    assert.equal(update.update, ID);
    assert.equal(update.updateKey, KEY_TEXT);
    assert.equal(asked(['d', '--update', ID]).options.updateKey, null, 'an id carries no key');
    assert.equal(asked(['d', '--update', 'https://marke.st/p/' + ID + '#key=short']).options.updateKey, null, 'nor does a fragment that is not one');
});

test('what cannot be done as asked is a usage error', () => {
    assert.match(asked([]).usageError, /Name the folder/);
    assert.equal(asked(['a', 'b', 'c']).usageError, 'One folder at a time; also given: b c');
    assert.match(asked(['d', '--visibility', 'secret']).usageError, /--visibility/);
    assert.match(asked(['d', '--prune']).usageError, /--update/);
    assert.match(asked(['d', '--update', 'nonsense']).usageError, /--update/);
});

test('only a dry run of a new artifact goes without a key', () => {
    assert.equal(needsKey(asked(['d'])), true);
    assert.equal(needsKey(asked(['d', '--dry-run'])), false);
    assert.equal(needsKey(asked(['d', '--dry-run', '--update', ID])), true, 'an update\'s dry run reads the artifact');
});

test('a folder that is not there is said so, and nothing is sent', async () => {
    const missing = await run(['publish', 'no/such/folder']);
    assert.equal(missing.code, 2);
    assert.equal(missing.stderr, 'markest: no/such/folder is not a folder.\n');
    assert.match((await run(['publish'])).stderr, /Name the folder/);
});

test('a site that asks to wait is said to, in seconds, and the publish goes on', async () => {
    const site = await startFakeMarkest();
    const folder = await mkdtemp(join(tmpdir(), 'markest-publish-'));
    try {
        await writeFile(join(folder, 'README.md'), '# Hi\n');
        site.answerOnce((one) => one.method === 'POST' && one.path === '/api/v1/pastes', (req, res) => {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
            res.end('{"error":"Slow down."}');
        });
        const out = await run(['publish', folder, '--url', site.url]);
        assert.equal(out.code, 0, out.stderr);
        assert.ok(out.stderr.includes('The site asked to wait (429); trying again in 1 s.\n'), out.stderr);
        assert.equal(site.pastes.size, 1);
    } finally {
        await site.close();
        await rm(folder, { recursive: true, force: true });
    }
});
