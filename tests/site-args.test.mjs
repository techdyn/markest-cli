/**
 * What every command reads the same way: the site, the key, an artifact's id,
 * and its own flags beside the ones every command takes (cli/core/site-args);
 * and the tool run as a program.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GLOBAL_FLAGS, keyFrom, pasteIdFrom, readFlags, siteFrom, siteUrl, visibilityFrom, DEFAULT_URL } from '../src/core/site-args.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

test('an artifact is named by its id or any of its addresses', () => {
    assert.equal(pasteIdFrom(ID.toLowerCase()), ID);
    assert.equal(pasteIdFrom('  ' + ID + '  '), ID, 'spaces around it do not matter');
    for (const address of ['https://marke.st/p/' + ID, 'https://marke.st/p/' + ID + '/docs/a.md?exp=1&sig=2', 'https://marke.st/r/' + ID + '/a.md',
        'https://marke.st/embed/' + ID, 'https://marke.st/api/v1/pastes/' + ID, 'https://marke.st/h/' + ID + '/a.html', 'https://marke.st/api/p/' + ID + '/doc',
        'https://marke.st/app/artifacts/' + ID + '/edit', 'https://marke.st/p/' + ID + '/README.md#key=abc']) {
        assert.equal(pasteIdFrom(address), ID, address);
    }
    assert.equal(pasteIdFrom('https://marke.st/u/' + ID), null, 'only a segment that names an artifact');
    assert.equal(pasteIdFrom('https://marke.st/p/' + ID.slice(1)), null, 'only a whole id');
    assert.equal(pasteIdFrom('https://marke.st/p'), null);
    assert.equal(pasteIdFrom('https://marke.st/api/' + ID), null, 'api is no route of its own');
    assert.equal(pasteIdFrom('https://marke.st//p//' + ID), null, 'an empty segment between is no id');
    assert.equal(pasteIdFrom('x' + ID), null);
    assert.equal(pasteIdFrom(null), null);
});

test('the site is https, or http to this machine alone', () => {
    assert.equal(siteUrl('http://[::1]:8000/x').url, 'http://[::1]:8000');
    assert.equal(siteUrl('http://127.0.0.1').url, 'http://127.0.0.1');
    assert.equal(siteUrl('http://localhost:8002/').url, 'http://localhost:8002');
    assert.equal(siteUrl('https://example.test/a/b').url, 'https://example.test', 'its origin, no trailing slash');
    assert.match(siteUrl('http://marke.st').error, /https/);
    assert.match(siteUrl('ftp://127.0.0.1').error, /https/);
    assert.match(siteUrl('not a url').error, /not a URL/);
    assert.equal(siteFrom({}, {}).url, DEFAULT_URL);
    assert.equal(siteFrom({}, { MARKEST_URL: 'http://localhost:8002' }).url, 'http://localhost:8002');
    assert.equal(siteFrom({ url: 'https://a.test' }, { MARKEST_URL: 'https://b.test' }).url, 'https://a.test', 'the flag wins');
});

test('the key comes from the environment alone', () => {
    assert.equal(keyFrom({ MARKEST_KEY: 'old', MARKEST_API_KEY: 'new' }), 'new');
    assert.equal(keyFrom({ MARKEST_KEY: 'old' }), 'old');
    assert.equal(keyFrom({}), '');
    assert.equal(keyFrom(), '');
    assert.ok(!('key' in GLOBAL_FLAGS), 'never a flag');
    assert.match(readFlags(['--key', 'x']).usageError, /--key/);
});

test('a command reads its own flags beside every command\'s', () => {
    const read = readFlags(['a', '--json', '--title', 'T', '--url', 'https://x.test', '-h'], { title: { type: 'string' } });
    assert.deepEqual(read.positionals, ['a']);
    assert.equal(read.values.title, 'T');
    assert.equal(read.values.json, true);
    assert.equal(read.values.url, 'https://x.test');
    assert.equal(read.values.help, true);
    assert.match(readFlags(['--title', 'T']).usageError, /--title/, 'another command\'s flag is unknown here');
    assert.deepEqual(visibilityFrom(undefined), { visibility: null });
    assert.deepEqual(visibilityFrom(null), { visibility: null });
    assert.deepEqual(visibilityFrom('private'), { visibility: 'private' });
    assert.match(visibilityFrom('secret').usageError, /--visibility is one of public, unlisted, private/);
    assert.match(visibilityFrom('public', ['unlisted', 'private'], '--sealed').usageError, /--sealed is one of unlisted, private/);
});

test('run as a program it prints its version and its help, and nothing on stderr', () => {
    const entry = fileURLToPath(new URL('../bin/markest.mjs', import.meta.url));
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const out = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, version + '\n');
    assert.equal(out.stderr, '');
    const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /\n {2}publish +Publish a folder/);
    assert.equal(help.stderr, '');
});
