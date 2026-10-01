/**
 * Sealing and opening on this machine (cli/sealed/sealing), as the browser
 * does: every envelope bound to its path and type, the type sent beside it, a
 * key found only in a fragment, and a key that does not open it refused without
 * being said.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { keyIn, newKey, openAll, sealAll, withoutKey } from '../src/sealed/sealing.mjs';
import { Refused } from '../src/core/command-kit.mjs';
import { isEnvelope, keyFromText, openDocument } from '../src/shared.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

test('a key is found in a link\'s fragment, never in an id; a reference is said back without one', () => {
    const key = 'Z'.repeat(42) + 'w';
    assert.equal(keyIn('https://marke.st/p/' + ID + '/a.md#key=' + key), key);
    assert.equal(keyIn('https://marke.st/p/' + ID + '#theme=dark&key=' + key), key);
    assert.equal(keyIn('#key=' + key), key);
    assert.equal(keyIn(ID), null);
    assert.equal(keyIn(key), null, 'a bare key is not a reference');
    assert.equal(keyIn('https://marke.st/p/' + ID + '#key=nope'), null);
    assert.equal(keyIn(null), null);
    assert.equal(withoutKey('https://marke.st/p/' + ID + '/a.md?exp=1#key=' + key), 'https://marke.st/p/' + ID + '/a.md?exp=1');
    assert.equal(withoutKey(undefined), '');
});

test('documents sealed here open as the browser opens them, each bound to its path and type', async () => {
    const { text } = await newKey();
    assert.match(text, /^[A-Za-z0-9_-]{43}$/);
    const documents = [{ path: 'README.md', contentType: 'markdown', content: '# Plan\n', title: 'The plan' }, { path: 'site/index.html', contentType: 'html', content: '<h1>Hi</h1>' }];
    const sealed = await sealAll(text, documents);
    assert.deepEqual(sealed.map((doc) => [doc.path, doc.content_type, doc.title, isEnvelope(doc.content)]), [['README.md', 'markdown', 'The plan', true], ['site/index.html', 'html', undefined, true]]);
    // Looked for with characters base64 never holds, so ciphertext cannot match it by chance ("Hi" alone did, one run in seventy)
    assert.ok(!sealed.some((doc) => doc.content.includes('# Plan') || doc.content.includes('<h1>Hi</h1>')), 'nothing in the clear');
    // The browser's own opening
    assert.equal(await openDocument(await keyFromText(text), { path: 'site/index.html', contentType: 'html', content: sealed[1].content }), '<h1>Hi</h1>');
    const opened = await openAll(text, sealed.map((doc) => ({ path: doc.path, contentType: doc.content_type, content: doc.content, title: doc.title ?? null })));
    assert.deepEqual(opened.map((doc) => doc.content), ['# Plan\n', '<h1>Hi</h1>']);
    assert.equal((await sealAll(text, documents)).find((doc) => doc.path === 'README.md').content === sealed[0].content, false, 'a new IV every time');
});

test('a key that does not open it is a refusal that names no key; a document with no text stays as it is', async () => {
    const { text } = await newKey();
    const other = (await newKey()).text;
    const [envelope] = await sealAll(text, [{ path: 'a.md', contentType: 'markdown', content: 'secret' }]);
    const doc = { path: 'a.md', contentType: 'markdown', content: envelope.content };
    await assert.rejects(openAll(other, [doc]), (error) => error instanceof Refused && /does not open a\.md/.test(error.message) && !error.message.includes(other));
    await assert.rejects(openAll(text, [{ ...doc, path: 'b.md' }]), Refused, 'moved to another path, it will not open');
    await assert.rejects(openAll(text, [{ ...doc, contentType: 'code' }]), Refused, 'nor as another type');
    await assert.rejects(openAll('not a key', [doc]), /not an artifact's key/);
    await assert.rejects(sealAll('not a key', [doc]), /not an artifact's key/);
    assert.deepEqual(await openAll(text, [{ path: 'b.md', contentType: 'markdown', content: null }]), [{ path: 'b.md', contentType: 'markdown', content: null }]);
});

test('a document with no text at all stays as it is; a key that does not open one is said in full', async () => {
    const { text } = await newKey();
    assert.deepEqual(await openAll(text, [{ path: 'b.md', contentType: 'markdown' }]), [{ path: 'b.md', contentType: 'markdown' }]);
    const [envelope] = await sealAll(text, [{ path: 'a.md', contentType: 'markdown', content: 'x' }]);
    await assert.rejects(openAll((await newKey()).text, [{ path: 'a.md', contentType: 'markdown', content: envelope.content }]),
        { message: 'The key does not open a.md: it is another artifact\'s key, or the document was changed outside a tool that holds the key.' });
});
