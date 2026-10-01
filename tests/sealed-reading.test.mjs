/**
 * REGRESSION ANCHOR (D-20261001-01): an artifact encrypted end to end read on
 * this machine (cli/reading/sealed-reading, through `markest read` and `pull`):
 * opened with the key in its link or the one kept here, never sending the key
 * anywhere, kept only when asked, and refused - saying how to give one - when
 * there is none or it is the wrong one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshKeyring, KEY, makeFolder, run } from './support/cli-harness.mjs';
import { newKey, sealAll } from '../src/sealed/sealing.mjs';
import { openKeyring } from '../src/sealed/keyring.mjs';
import { openIfSealed } from '../src/reading/sealed-reading.mjs';

async function sealedSite() {
    const site = await startFakeMarkest();
    const { text } = await newKey();
    const sealed = await sealAll(text, [{ path: 'README.md', contentType: 'markdown', content: '# The plan\n' }, { path: 'notes.md', contentType: 'markdown', content: 'Secret notes.' }]);
    const paste = site.addPaste({ title: 'Plan', visibility: 'unlisted', sealed: true, defaultPath: 'README.md', documents: sealed.map((doc) => ({ path: doc.path, content: doc.content, content_type: doc.content_type })) });
    return { site, key: text, paste, link: site.url + '/p/' + paste.id + '#key=' + text };
}

/** Whether the key went anywhere: in an address, a header or a body. */
const leaked = (site, key) => site.requests.some((one) => JSON.stringify([one.path, one.query, one.headers]).includes(key) || one.bytes.toString().includes(key));

test('opened with the key in its link, with a key or as a browser, the key never sent', async () => {
    const { site, key, paste, link } = await sealedSite();
    try {
        const keyring = await freshKeyring();
        const read = await run(['read', link, '--url', site.url], { MARKEST_API_KEY: KEY, MARKEST_KEYRING: keyring });
        assert.equal(read.code, 0, read.stderr);
        assert.equal(read.stdout, '# The plan\n');
        const anonymous = await run(['read', site.url + '/p/' + paste.id + '/notes.md#key=' + key, '--url', site.url, '--json'], { MARKEST_KEYRING: keyring });
        assert.deepEqual(JSON.parse(anonymous.stdout), { id: paste.id, path: 'notes.md', content_type: 'markdown', content: 'Secret notes.', encrypted: true });
        assert.ok(!leaked(site, key), 'no request carried the key');
        assert.deepEqual(await openKeyring({ path: keyring }).list(), [], 'and it was not kept, unasked');
    } finally {
        await site.close();
    }
});

test('kept when asked, and then opened by its id alone', async () => {
    const { site, key, paste, link } = await sealedSite();
    try {
        const keyring = await freshKeyring();
        const env = { MARKEST_API_KEY: KEY, MARKEST_KEYRING: keyring };
        assert.equal((await run(['read', link, '--remember', '--url', site.url], env)).code, 0);
        assert.equal(await openKeyring({ path: keyring }).get(site.url, paste.id), key);
        const byId = await run(['read', paste.id, 'notes.md', '--url', site.url], env);
        assert.equal(byId.stdout, 'Secret notes.');
        const folder = await makeFolder({});
        const pulled = await run(['pull', paste.id, folder, '--url', site.url], env);
        assert.equal(pulled.code, 0, pulled.stderr);
        assert.equal(await readFile(join(folder, 'notes.md'), 'utf8'), 'Secret notes.');
        assert.ok(!leaked(site, key));
    } finally {
        await site.close();
    }
});

test('without a key, or with the wrong one, nothing is read and it says how to give one', async () => {
    const { site, paste, link } = await sealedSite();
    try {
        const env = { MARKEST_API_KEY: KEY, MARKEST_KEYRING: await freshKeyring() };
        const none = await run(['read', paste.id, '--url', site.url], env);
        assert.equal(none.code, 1);
        assert.match(none.stderr, /encrypted end to end, and this machine keeps no key for it\. Name it by its whole link, the one ending #key=\.\.\./);
        const other = (await newKey()).text;
        const wrong = await run(['read', site.url + '/p/' + paste.id + '#key=' + other, '--url', site.url], env);
        assert.equal(wrong.code, 1);
        assert.match(wrong.stderr, /The key does not open README\.md/);
        assert.ok(!wrong.stderr.includes(other), 'the key is not said back');
        const pulled = await run(['pull', link.replace(/#key=.*/, ''), await makeFolder({}), '--url', site.url], env);
        assert.equal(pulled.code, 1);
    } finally {
        await site.close();
    }
});

test('an artifact in the clear is handed on as it is', async () => {
    const artifact = { id: 'X', sealed: false, documents: [{ path: 'a.md', content: 'plain' }] };
    assert.equal(await openIfSealed(artifact, { env: {} }), artifact);
});

test('reading by id with --remember has nothing new to keep, and reads', async () => {
    const { site, paste, link } = await sealedSite();
    try {
        const env = { MARKEST_API_KEY: KEY, MARKEST_KEYRING: await freshKeyring() };
        assert.equal((await run(['read', link, '--remember', '--url', site.url], env)).code, 0);
        const again = await run(['read', paste.id, '--remember', '--url', site.url], env);
        assert.equal(again.code, 0, again.stderr);
        assert.equal(again.stdout, '# The plan\n');
    } finally {
        await site.close();
    }
});
