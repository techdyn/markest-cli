/**
 * An artifact's documents as the site hands them over (cli/reading/artifact-source):
 * through the REST API with a key, through the public API without - a signed
 * link's exp and sig carried, only the document wanted fetched - and an
 * artifact of envelopes known for one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/core/api-client.mjs';
import { ALL, OPENING, chooseDocument, fetchArtifact, pathIn, signedQuery } from '../src/reading/artifact-source.mjs';
import { startFakeMarkest } from './support/fake-markest.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ENVELOPE = 'MKSEAL1:AAAAAAAAAAAAAAAA:' + 'A'.repeat(24);

test('a signed link\'s exp and sig are carried; nothing else is', () => {
    assert.deepEqual(signedQuery('https://marke.st/p/' + ID + '/a.md?exp=17&sig=ab&utm=x#key=k'), { exp: '17', sig: 'ab' });
    assert.deepEqual(signedQuery('https://marke.st/p/' + ID + '?exp=17'), {}, 'a half signature is none');
    assert.deepEqual(signedQuery(ID), {});
});

test('the document an address names is found, its spelling decoded', () => {
    assert.equal(pathIn('https://marke.st/p/' + ID + '/docs/setup%20notes.md?exp=1#key=k', ID), 'docs/setup notes.md');
    assert.equal(pathIn('https://marke.st/p/' + ID.toLowerCase() + '/a.md', ID), 'a.md');
    assert.equal(pathIn('https://marke.st/p/' + ID, ID), null);
    assert.equal(pathIn('https://marke.st/p/' + ID + '/', ID), null);
    assert.equal(pathIn('https://marke.st/r/' + ID + '/a.md', ID), null, 'only the viewer\'s address names one');
    assert.equal(pathIn('https://marke.st/p/' + ID + '/bad%E0%A4%A.md', ID), 'bad%E0%A4%A.md', 'taken as written when it will not decode');
    assert.equal(pathIn(ID, ID), null);
});

test('the document asked for opens, else the one it opens on, else the first', () => {
    const artifact = { defaultPath: 'b.md', documents: [{ path: 'a.md' }, { path: 'b.md' }] };
    assert.equal(chooseDocument(artifact, 'a.md'), 'a.md');
    assert.equal(chooseDocument(artifact, 'z.md'), null);
    assert.equal(chooseDocument(artifact, null), 'b.md');
    assert.equal(chooseDocument({ ...artifact, defaultPath: 'gone.md' }, null), 'a.md');
    assert.equal(chooseDocument({ defaultPath: null, documents: [] }, undefined), null);
});

test('with a key it is one read of the REST API; markdown is asked for when wanted', async () => {
    const site = await startFakeMarkest();
    try {
        const paste = site.addPaste({ title: 'T', defaultPath: 'b.md', documents: [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B', title: 'Bee' }] });
        const client = createClient({ baseUrl: site.url, key: 'mk_live_' + 'ab'.repeat(24) });
        const artifact = await fetchArtifact(client, { id: paste.id, keyed: true });
        assert.deepEqual(artifact, {
            id: paste.id, title: 'T', defaultPath: 'b.md', sealed: false,
            documents: [{ path: 'a.md', title: 'a.md', contentType: 'markdown', content: 'A' }, { path: 'b.md', title: 'Bee', contentType: 'markdown', content: 'B' }],
        });
        await fetchArtifact(client, { id: paste.id, keyed: true, format: 'markdown' });
        assert.deepEqual(site.requests.at(-1).query, { format: 'markdown' });
        assert.equal(site.requests.length, 2);
    } finally {
        await site.close();
    }
});

test('without a key it reads as a browser does: the manifest, then only the document wanted, a signature carried', async () => {
    const site = await startFakeMarkest();
    try {
        const paste = site.addPaste({ title: 'T', visibility: 'private', signature: 'good', defaultPath: 'b.md', documents: [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }] });
        const client = createClient({ baseUrl: site.url, key: '' });
        const reference = site.url + '/p/' + paste.id + '?exp=99&sig=good';
        const opening = await fetchArtifact(client, { id: paste.id, reference, keyed: false, pick: OPENING });
        assert.deepEqual(opening.documents.map((doc) => [doc.path, doc.content]), [['a.md', null], ['b.md', 'B']]);
        assert.deepEqual(site.requests.map((one) => [one.path, one.query]), [
            ['/api/p/' + paste.id + '/manifest', { exp: '99', sig: 'good' }],
            ['/api/p/' + paste.id + '/doc', { exp: '99', sig: 'good', path: 'b.md' }],
        ]);
        assert.ok(site.requests.every((one) => one.headers.authorization === undefined), 'no credential');
        const named = await fetchArtifact(client, { id: paste.id, reference, keyed: false, pick: 'a.md' });
        assert.equal(named.documents[0].content, 'A');
        const every = await fetchArtifact(client, { id: paste.id, reference, keyed: false, pick: ALL });
        assert.deepEqual(every.documents.map((doc) => doc.content), ['A', 'B']);
        await assert.rejects(fetchArtifact(client, { id: paste.id, reference: paste.id, keyed: false }), /Not found/, 'a private one, unsigned, is not there');
    } finally {
        await site.close();
    }
});

test('an artifact whose documents are all envelopes is known for one encrypted end to end', async () => {
    const site = await startFakeMarkest();
    try {
        const sealed = site.addPaste({ documents: [{ path: 'a.md', content: ENVELOPE }] });
        const mixed = site.addPaste({ documents: [{ path: 'a.md', content: ENVELOPE }, { path: 'b.md', content: 'plain' }] });
        const client = createClient({ baseUrl: site.url, key: '' });
        assert.equal((await fetchArtifact(client, { id: sealed.id, keyed: false })).sealed, true);
        assert.equal((await fetchArtifact(client, { id: mixed.id, keyed: false })).sealed, false);
        const empty = site.addPaste({ documents: [] });
        assert.equal((await fetchArtifact(client, { id: empty.id, keyed: false })).sealed, false);
    } finally {
        await site.close();
    }
});

test('a signature is both its parts or none; an artifact named without a document opens where it opens', () => {
    assert.deepEqual(signedQuery('https://marke.st/p/' + ID + '?sig=ab'), {}, 'a signature alone is none');
    assert.deepEqual(signedQuery('https://marke.st/p/' + ID), {});
    const artifact = { defaultPath: 'b.md', documents: [{ path: 'a.md' }, { path: 'b.md' }] };
    assert.equal(chooseDocument(artifact, undefined), 'b.md', 'nothing asked is the one it opens on');
});

test('what the site leaves out is taken as nothing, and each read is tried again after a lost connection', async () => {
    const site = await startFakeMarkest();
    try {
        const paste = site.addPaste({ title: 'T', documents: [{ path: 'a.md', content: 'A', title: 'Aye' }] });
        const keyed = createClient({ baseUrl: site.url, key: 'mk_live_' + 'ab'.repeat(24), sleep: async () => {} });
        site.answerOnce(() => true, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: paste.id, documents: [{ path: 'x.md', content_type: 'markdown' }] })); });
        const thin = await fetchArtifact(keyed, { id: paste.id, keyed: true });
        assert.deepEqual(thin, { id: paste.id, title: null, defaultPath: null, sealed: false, documents: [{ path: 'x.md', title: null, contentType: 'markdown', content: '' }] });
        site.answerOnce(() => true, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: paste.id })); });
        assert.deepEqual((await fetchArtifact(keyed, { id: paste.id, keyed: true })).documents, [], 'no documents is none');
        await fetchArtifact(keyed, { id: paste.id, keyed: true });
        assert.deepEqual(site.requests.at(-1).query, {}, 'markdown only when asked');

        const drop = (req) => { req.socket.destroy(); };
        site.answerOnce((one) => one.path === '/api/v1/pastes/' + paste.id, drop);
        assert.equal((await fetchArtifact(keyed, { id: paste.id, keyed: true })).documents[0].content, 'A');
        const anonymous = createClient({ baseUrl: site.url, key: '', sleep: async () => {} });
        site.answerOnce((one) => one.path.endsWith('/manifest'), drop);
        site.answerOnce((one) => one.path.endsWith('/doc'), drop);
        const read = await fetchArtifact(anonymous, { id: paste.id, keyed: false });
        assert.deepEqual([read.title, read.documents[0].title, read.documents[0].content], ['T', 'Aye', 'A'], 'its title and each document\'s, as the manifest says');
        site.answerOnce((one) => one.path.endsWith('/manifest'), (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: paste.id })); });
        assert.deepEqual(await fetchArtifact(anonymous, { id: paste.id, keyed: false }), { id: paste.id, title: null, defaultPath: null, documents: [], sealed: false });
    } finally {
        await site.close();
    }
});
