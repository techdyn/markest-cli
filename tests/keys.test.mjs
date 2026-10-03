/**
 * `markest keys` (cli/commands/keys): what this machine keeps, listed without a
 * key; a key kept from a link only once it has opened the artifact; one forgotten.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshHome, KEY, run, testKeyring } from './support/cli-harness.mjs';
import { newKey, sealAll } from '../src/sealed/sealing.mjs';

test('keys lists the artifacts whose keys are kept, never a key', async () => {
    const path = await freshHome();
    const env = { MARKEST_HOME: path };
    assert.equal((await run(['keys'], env)).stdout, 'No keys are kept on this machine.\n');
    const { text } = await newKey();
    await testKeyring(path).remember('https://marke.st', '01ARZ3NDEKTSV4RRFFQ69G5FAV', text, 'Plan');
    const out = await run(['keys'], env);
    assert.match(out.stdout, /^ID +SITE +KEPT \(UTC\) +TITLE\n01ARZ3NDEKTSV4RRFFQ69G5FAV +https:\/\/marke\.st +\d{4}-\d\d-\d\d \d\d:\d\d +Plan\n$/);
    assert.match(out.stderr, /Kept in /);
    assert.ok(!out.stdout.includes(text) && !out.stderr.includes(text));
    const json = JSON.parse((await run(['keys', '--json'], env)).stdout);
    assert.equal(json.path, join(path, 'keys.vault'));
    assert.ok(!JSON.stringify(json).includes(text));
});

test('a key is kept from a link only once it opens the artifact, and forgotten when asked', async () => {
    const site = await startFakeMarkest();
    try {
        const { text } = await newKey();
        const sealed = await sealAll(text, [{ path: 'a.md', contentType: 'markdown', content: 'secret' }]);
        const paste = site.addPaste({ title: 'Plan', sealed: true, documents: [{ path: 'a.md', content: sealed[0].content, content_type: 'markdown' }] });
        const clear = site.addPaste({ title: 'Clear', documents: [{ path: 'a.md', content: 'plain' }] });
        const path = await freshHome();
        const env = { MARKEST_API_KEY: KEY, MARKEST_HOME: path };
        const keyring = testKeyring(path);

        const other = (await newKey()).text;
        const wrong = await run(['keys', '--add', site.url + '/p/' + paste.id + '#key=' + other, '--url', site.url], env);
        assert.equal(wrong.code, 1);
        assert.match(wrong.stderr, /does not open a\.md/);
        assert.equal(await keyring.get(site.url, paste.id), null, 'a wrong key is never kept');
        const notSealed = await run(['keys', '--add', site.url + '/p/' + clear.id + '#key=' + text, '--url', site.url], env);
        assert.match(notSealed.stderr, /not encrypted end to end: it needs no key/);

        const kept = await run(['keys', '--add', site.url + '/p/' + paste.id + '#key=' + text, '--url', site.url], env);
        assert.equal(kept.code, 0, kept.stderr);
        assert.equal(kept.stdout, 'Kept the key of Plan (' + paste.id + ').\n');
        assert.equal(await keyring.get(site.url, paste.id), text);

        assert.equal((await run(['keys', '--forget', paste.id, '--url', site.url], env)).stdout, 'Forgot the key of ' + paste.id + '.\n');
        assert.equal(await keyring.get(site.url, paste.id), null);
        const again = await run(['keys', '--forget', paste.id, '--url', site.url], env);
        assert.equal(again.code, 1);
        assert.match(again.stderr, /No key for .* is kept/);
    } finally {
        await site.close();
    }
});

test('keys refuses what it cannot ask, never saying a key back', async () => {
    const key = 'Q'.repeat(42) + 'w';
    for (const [argv, said] of [[['keys', 'x'], /markest keys/], [['keys', '--add', 'a', '--forget', 'b'], /one at a time/],
        [['keys', '--add', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], /whole link/], [['keys', '--forget', 'nope#key=' + key], /"nope" is not/]]) {
        const out = await run(argv);
        assert.equal(out.code, 2, argv.join(' '));
        assert.match(out.stderr, said);
        assert.ok(!out.stderr.includes(key));
    }
});

test('a key is kept from a link a browser could open, with no API key, and said exactly', async () => {
    const site = await startFakeMarkest();
    try {
        const { text } = await newKey();
        const sealed = await sealAll(text, [{ path: 'a.md', contentType: 'markdown', content: 'secret' }]);
        const paste = site.addPaste({ title: 'Plan', sealed: true, documents: [{ path: 'a.md', content: sealed[0].content, content_type: 'markdown' }] });
        const path = await freshHome();
        const out = await run(['keys', '--add', site.url + '/p/' + paste.id + '#key=' + text, '--url', site.url], { MARKEST_HOME: path });
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.requests.map((one) => one.path), ['/api/p/' + paste.id + '/manifest', '/api/p/' + paste.id + '/doc'], 'as a browser reads it');
        const listed = await run(['keys'], { MARKEST_HOME: path });
        assert.equal(listed.stderr, 'Kept in ' + join(path, 'keys.vault') + '\n');
        const forgot = await run(['keys', '--forget', paste.id, '--url', site.url, '--json'], { MARKEST_HOME: path });
        assert.deepEqual(JSON.parse(forgot.stdout), { forgotten: paste.id });
        const again = await run(['keys', '--forget', paste.id, '--url', site.url], { MARKEST_HOME: path });
        assert.equal(again.stderr, 'markest: No key for ' + paste.id + ' is kept for ' + site.url + '.\n');
        const elsewhere = await run(['keys', '--add', 'https://marke.st/u/someone#key=' + text], { MARKEST_HOME: path });
        assert.equal(elsewhere.code, 2, 'a link that names no artifact');
        assert.match(elsewhere.stderr, /whole link/);
    } finally {
        await site.close();
    }
});

test('with an API key a private artifact is opened through the API, the only way to read it', async () => {
    const site = await startFakeMarkest();
    try {
        const { text } = await newKey();
        const sealed = await sealAll(text, [{ path: 'a.md', contentType: 'markdown', content: 'secret' }]);
        const paste = site.addPaste({ title: 'Plan', sealed: true, visibility: 'private', documents: [{ path: 'a.md', content: sealed[0].content, content_type: 'markdown' }] });
        const path = await freshHome();
        const out = await run(['keys', '--add', site.url + '/p/' + paste.id + '#key=' + text, '--url', site.url], { MARKEST_API_KEY: KEY, MARKEST_HOME: path });
        assert.equal(out.code, 0, out.stderr);
        assert.ok(site.requests.every((one) => one.path.startsWith('/api/v1/')), site.requests.map((one) => one.path).join(' '));
        assert.equal(await testKeyring(path).get(site.url, paste.id), text);
    } finally {
        await site.close();
    }
});
