/**
 * REGRESSION ANCHOR (D-20261001-01): what an agent asks of artifacts encrypted
 * end to end, done on this machine (cli/sealed/sealed-artifacts) against the
 * fake site: made from text as envelopes with their types, the key kept and
 * never sent; read whole or one document; documents added or replaced keeping
 * their types; taken out; linked; and every refusal made before a request.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshHome, KEY, homeEnv, testKeyring } from './support/cli-harness.mjs';
import { createSealed, documentsFrom, linkFor, readSealed, removeSealed, writeSealed } from '../src/sealed/sealed-artifacts.mjs';
import { keyIn, openAll } from '../src/sealed/sealing.mjs';
import { Refused } from '../src/core/command-kit.mjs';
import { isEnvelope } from '../src/shared.mjs';

async function withSite(body) {
    const site = await startFakeMarkest();
    const keyring = await freshHome();
    const ctx = { baseUrl: site.url, key: KEY, env: homeEnv(keyring), stderr: { write() {} }, version: '0' };
    try {
        await body(site, ctx, testKeyring(keyring));
    } finally {
        await site.close();
    }
}

const leaked = (site, key) => site.requests.some((one) => JSON.stringify([one.path, one.query, one.headers]).includes(key) || one.bytes.toString().includes(key));

test('documents are checked as the site checks them, each with its type', () => {
    assert.deepEqual(documentsFrom([{ path: ' a.md ', content: '# A' }, { path: 'p.html', content: '<!doctype html><p>x</p>', title: 'Page' }, { path: 's.md', content: 'x', content_type: 'code' }],
        new Map([['s.md', 'markdown']])).map((doc) => [doc.path, doc.contentType, doc.title]), [['a.md', 'markdown', undefined], ['p.html', 'html', 'Page'], ['s.md', 'code', undefined]]);
    assert.equal(documentsFrom([{ path: 'notes.md', content: 'x' }], new Map([['notes.md', 'code']]))[0].contentType, 'code', 'the type it has is kept');
    for (const [given, said] of [[[], /at least one/], [null, /at least one/], [[{ path: '../a.md', content: '' }], /not one the site takes \(traversal\)/],
        [[{ path: 'a.md', content: 'x' }, { path: 'a.md', content: 'y' }], /Two documents at a\.md/], [[{ path: 'a.md' }], /no text content/],
        [[{ path: 'a.md', content: 'x', content_type: 'pdf' }], /markdown, html or code/], [Array.from({ length: 51 }, (_, i) => ({ path: i + '.md', content: '' })), /At most 50/]]) {
        assert.throws(() => documentsFrom(given), (error) => error instanceof Refused && said.test(error.message), JSON.stringify(given)?.slice(0, 60));
    }
});

test('an artifact is made as envelopes with their types, its key kept here and never sent', async () => {
    await withSite(async (site, ctx, keyring) => {
        const made = await createSealed(ctx, { title: 'Agent plan', documents: [{ path: 'README.md', content: '# Plan' }, { path: 'run.py', content: 'print(1)' }], visibility: 'private', default_path: 'run.py', folder: 'agents' });
        const key = keyIn(made.url);
        assert.match(made.url, /\/p\/[0-9A-Z]{26}#key=[A-Za-z0-9_-]{43}$/);
        assert.deepEqual({ ...made, url: undefined }, { id: made.id, url: undefined, title: 'Agent plan', visibility: 'private', documents: ['README.md', 'run.py'] });
        const body = site.requests.find((one) => one.method === 'POST').json;
        assert.equal(body.sealed, true);
        assert.equal(body.default_path, 'run.py');
        assert.equal(body.folder, 'agents');
        assert.deepEqual(body.documents.map((doc) => [doc.path, doc.content_type, isEnvelope(doc.content)]), [['README.md', 'markdown', true], ['run.py', 'code', true]]);
        assert.equal(await keyring.get(site.url, made.id), key);
        assert.ok(!leaked(site, key));
    });
});

test('it is read with the key kept here, whole or one document; a link\'s key is kept only when asked', async () => {
    await withSite(async (site, ctx, keyring) => {
        const made = await createSealed(ctx, { documents: [{ path: 'README.md', content: '# Plan' }, { path: 'b.md', content: 'Bee' }] });
        const one = await readSealed(ctx, { artifact: made.id });
        assert.deepEqual(one, { id: made.id, title: null, encrypted: true, document: { path: 'README.md', title: 'README.md', content_type: 'markdown', content: '# Plan' }, paths: ['README.md', 'b.md'] });
        assert.deepEqual((await readSealed(ctx, { artifact: made.id, all: true })).documents.map((doc) => doc.content), ['# Plan', 'Bee']);
        await assert.rejects(readSealed(ctx, { artifact: made.id, path: 'z.md' }), /There is no document z\.md\. It holds: README\.md, b\.md/);

        await keyring.forget(site.url, made.id);
        await assert.rejects(readSealed(ctx, { artifact: made.id }), /no key for it is kept here/);
        assert.equal((await readSealed({ ...ctx, key: '' }, { artifact: made.url, path: 'b.md' })).document.content, 'Bee', 'by its link, as a browser, no API key');
        assert.equal(await keyring.get(site.url, made.id), null, 'not kept unasked');
        await readSealed(ctx, { artifact: made.url, remember: true });
        assert.equal(await keyring.get(site.url, made.id), keyIn(made.url));

        const clear = site.addPaste({ title: 'Clear', documents: [{ path: 'a.md', content: 'plain' }] });
        assert.deepEqual((await readSealed(ctx, { artifact: clear.id })).document.content, 'plain', 'one in the clear reads as it is');
        await assert.rejects(readSealed(ctx, { artifact: 'nonsense' }), /by its id or its link/);
    });
});

test('documents are added or replaced, keeping their types; taken out; and refused on one in the clear', async () => {
    await withSite(async (site, ctx, keyring) => {
        const made = await createSealed(ctx, { documents: [{ path: 'README.md', content: '# Plan' }, { path: 'notes.md', content: 'n', content_type: 'code' }] });
        const key = keyIn(made.url);
        await keyring.forget(site.url, made.id);
        const written = await writeSealed(ctx, { artifact: made.url, documents: [{ path: 'notes.md', content: 'more' }, { path: 'new.md', content: '# New', title: 'New one' }] });
        assert.deepEqual(written, { id: made.id, written: [{ path: 'notes.md', replaced: true, content_type: 'code' }, { path: 'new.md', replaced: false, content_type: 'markdown' }] });
        const paste = site.pastes.get(made.id);
        const texts = await openAll(key, paste.documents.map((doc) => ({ path: doc.path, contentType: doc.content_type, content: doc.content })));
        assert.deepEqual(Object.fromEntries(texts.map((doc) => [doc.path, doc.content])), { 'README.md': '# Plan', 'notes.md': 'more', 'new.md': '# New' });
        assert.equal(paste.documents.find((doc) => doc.path === 'new.md').title, 'New one');
        assert.equal(await keyring.get(site.url, made.id), key, 'a key that opened it to write is the owner\'s, and kept');
        assert.ok(!leaked(site, key));

        assert.deepEqual(await removeSealed(ctx, { artifact: made.id, paths: ['new.md'] }), { id: made.id, removed: ['new.md'] });
        assert.ok(!site.pastes.get(made.id).documents.some((doc) => doc.path === 'new.md'));
        await assert.rejects(removeSealed(ctx, { artifact: made.id, paths: [] }), /Name the documents/);

        const clear = site.addPaste({ title: 'Clear', documents: [{ path: 'a.md', content: 'plain' }] });
        await assert.rejects(writeSealed(ctx, { artifact: clear.id, documents: [{ path: 'a.md', content: 'x' }] }), /not encrypted end to end/);
        await assert.rejects(writeSealed(ctx, { artifact: made.id, documents: [{ path: 'big.md', content: 'x'.repeat(600 * 1024) }] }), /The site would refuse it: file_size big\.md/);
    });
});

test('nothing is made without an API key, public, or opening on a document it lacks; a link has its key when one is kept', async () => {
    await withSite(async (site, ctx) => {
        await assert.rejects(createSealed({ ...ctx, key: '' }, { documents: [{ path: 'a.md', content: 'x' }] }), /MARKEST_API_KEY/);
        await assert.rejects(createSealed(ctx, { documents: [{ path: 'a.md', content: 'x' }], visibility: 'public' }), /never public/);
        await assert.rejects(createSealed(ctx, { documents: [{ path: 'a.md', content: 'x' }], default_path: 'b.md' }), /no document b\.md/);
        await assert.rejects(writeSealed({ ...ctx, key: '' }, { artifact: 'x', documents: [] }), /MARKEST_API_KEY/);
        await assert.rejects(removeSealed({ ...ctx, key: '' }, { artifact: 'x', paths: ['a'] }), /MARKEST_API_KEY/);
        assert.equal(site.requests.length, 0, 'every refusal before a request');

        const made = await createSealed(ctx, { documents: [{ path: 'a.md', content: 'x' }] });
        assert.deepEqual(await linkFor(ctx, { artifact: made.id }), { id: made.id, url: made.url, has_key: true });
        const other = site.addPaste({ title: 'O' });
        assert.deepEqual(await linkFor(ctx, { artifact: other.id }), { id: other.id, url: site.url + '/p/' + other.id, has_key: false });
    });
});

test('the limits and every refusal are said in full, a site refusal reaching an agent as a refusal', async () => {
    assert.equal(documentsFrom(Array.from({ length: 50 }, (_, i) => ({ path: i + '.md', content: '' }))).length, 50, 'fifty is within');
    assert.throws(() => documentsFrom(Array.from({ length: 51 }, (_, i) => ({ path: i + '.md', content: '' }))), { message: 'At most 50 documents.' });
    assert.throws(() => documentsFrom([null]), { message: 'The path "" is not one the site takes (empty).' });
    assert.throws(() => documentsFrom([{ path: 'a.md', content: '' }, { path: 'a.md', content: '' }]), { message: 'Two documents at a.md.' });
    assert.throws(() => documentsFrom([{ path: 'a.md', content: 5 }]), { message: 'The document at a.md has no text content.' });
    assert.ok(!('title' in documentsFrom([{ path: 'a.md', content: '', title: 5 }])[0]), 'a title that is no text is none');
    await withSite(async (site, ctx, keyring) => {
        await assert.rejects(createSealed(ctx, { documents: [{ path: 'big.md', content: 'x'.repeat(600 * 1024) }] }),
            (error) => error instanceof Refused && error.message === 'The site would refuse it: file_size big.md (limit 524288).');
        await assert.rejects(createSealed(ctx, { documents: [{ path: 'a.md', content: 'x' }], default_path: 'b.md' }), { message: 'There is no document b.md to open on.' });
        assert.equal(site.requests.length, 0);
        site.answerOnce((one) => one.method === 'POST', (req, res) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"Not in your plan."}'); });
        await assert.rejects(createSealed(ctx, { documents: [{ path: 'a.md', content: 'x' }] }), (error) => error instanceof Refused && error.message === 'Not in your plan.');
        const made = await createSealed(ctx, { title: 'Titled', documents: [{ path: 'a.md', content: 'x' }] });
        assert.equal((await keyring.list()).find((one) => one.id === made.id).title, 'Titled', 'kept with its title');
        const byId = await readSealed(ctx, { artifact: made.id, remember: true });
        assert.equal(byId.document.content, 'x', 'by id, remember has nothing new to keep');
    });
});

test('documents past the first request follow it, and the one it opens on is set when it came later', async () => {
    await withSite(async (site, ctx) => {
        const made = await createSealed({ ...ctx, batchBytes: 200 }, { documents: [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }, { path: 'c.md', content: 'C' }], default_path: 'c.md' });
        const sent = site.requests.filter((one) => one.method !== 'GET').map((one) => one.method + ' ' + one.path.replace(/[0-9A-Z]{26}/, ':id'));
        assert.deepEqual(sent, ['POST /api/v1/pastes', 'POST /api/v1/pastes/:id/documents', 'POST /api/v1/pastes/:id/documents', 'PATCH /api/v1/pastes/:id']);
        assert.ok(!('default_path' in site.requests[0].json), 'not with a first request that does not hold it');
        assert.equal(site.requests.at(-1).json.default_path, 'c.md');
        assert.deepEqual(site.pastes.get(made.id).documents.map((doc) => doc.path), ['a.md', 'b.md', 'c.md'], 'in the order given');
        const before = site.requests.length;
        await createSealed(ctx, { documents: [{ path: 'a.md', content: 'A' }], default_path: 'a.md' });
        const created = site.requests.slice(before);
        assert.equal(created[0].json.default_path, 'a.md', 'with the first request that holds it');
        assert.equal(created.filter((one) => one.method === 'PATCH').length, 0);
    });
});

test('every reason the site would refuse is said, with its path where it has one and its limit', async () => {
    await withSite(async (site, ctx) => {
        const big = '<p>' + 'x'.repeat(51 * 1024 * 1024) + '</p>';
        await assert.rejects(createSealed(ctx, { documents: [{ path: 'a.md', content: 'x' }, { path: 'big.html', content: big }] }),
            (error) => error instanceof Refused && error.message === 'The site would refuse it: file_size big.html (limit 1048576), total_size (limit 52428800).');
        assert.equal(site.requests.length, 0, 'nothing sent');
    });
});

test('the opening document set after the first request is tried again when the connection is lost', async () => {
    await withSite(async (site, ctx) => {
        site.answerOnce((one) => one.method === 'PATCH', (req) => { req.socket.destroy(); });
        const made = await createSealed({ ...ctx, batchBytes: 200 }, { documents: [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }], default_path: 'b.md' });
        assert.equal(site.requests.filter((one) => one.method === 'PATCH').length, 2, 'once lost, once made');
        assert.equal(site.pastes.get(made.id).defaultPath, 'b.md');
    });
});
