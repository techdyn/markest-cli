/**
 * REGRESSION ANCHOR (D-20261001-03): `markest draft` against the fake site
 * (cli/commands/draft). A file or a small folder is published with no
 * credential, even when a key is set; what a draft cannot hold is refused with
 * nothing sent; the claim link goes to stderr.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { KEY, makeFolder, run } from './support/cli-harness.mjs';
import { draftProblems } from '../src/commands/draft.mjs';

async function withSite(options, body) {
    const site = await startFakeMarkest(options);
    try {
        await body(site, (argv, env = {}) => run([...argv, '--url', site.url], env));
    } finally {
        await site.close();
    }
}

const LIMITS = { max_documents: 2, max_total_bytes: 2048, html: false };

test('what a draft cannot hold is said, all of it', () => {
    assert.deepEqual(draftProblems([{ path: 'a.md', content: 'x', type: 'markdown' }], LIMITS), []);
    assert.deepEqual(draftProblems([], LIMITS), ['there is no document to publish']);
    const big = 'x'.repeat(3000);
    assert.deepEqual(draftProblems([{ path: 'a.md', content: big, type: 'markdown' }, { path: 'b.html', content: '<p>', type: 'html' }, { path: 'c.md', content: '', type: 'markdown' }], LIMITS), [
        '3 documents, where a draft holds 2', '3 KB, where a draft holds 2 KB', 'an HTML page, which a draft cannot hold: b.html',
    ]);
    assert.deepEqual(draftProblems([{ path: 'b.html', content: '<p>', type: 'html' }], { ...LIMITS, html: true }), []);
    assert.deepEqual(draftProblems([{ path: 'a.md', content: 'x'.repeat(2048), type: 'markdown' }, { path: 'b.md', content: '', type: 'markdown' }], LIMITS), [], 'as many documents and bytes as a draft holds, exactly');
    assert.deepEqual(draftProblems([{ path: 'a.html', content: '', type: 'html' }, { path: 'b.html', content: '', type: 'html' }], LIMITS), ['an HTML page, which a draft cannot hold: a.html, b.html']);
});

test('a file is published with no credential, even with a key set, the claim link on stderr', async () => {
    await withSite({}, async (site, markest) => {
        const folder = await makeFolder({ 'report.md': '# Weekly report\n\nAll well.\n' });
        const out = await markest(['draft', join(folder, 'report.md')], { MARKEST_API_KEY: KEY });
        assert.equal(out.code, 0, out.stderr);
        assert.match(out.stdout, /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9A-Z]{26}\n$/);
        assert.equal(out.stderr, 'Live until 2026-10-02T10:00:00+00:00 unless claimed. Give this claim link only to whoever should own it:\n  ' + site.url + '/app/claim/' + 'c'.repeat(64) + '\n', 'a file leaves out no images');
        const sent = site.requests.find((one) => one.method === 'POST');
        assert.equal(sent.headers.authorization, undefined, 'no credential');
        assert.deepEqual(sent.json, { title: 'Weekly report', default_path: 'report.md', documents: [{ path: 'report.md', content: '# Weekly report\n\nAll well.\n' }] });
        assert.ok(site.requests.every((one) => one.headers.authorization === undefined));
    });
});

test('a folder goes as publish reads it: secrets and images left out, opening on its README', async () => {
    await withSite({}, async (site, markest) => {
        const folder = await makeFolder({ 'README.md': '# Hi\n', 'notes.md': '# Notes\n', 'draft.md': 'not yet', '.markestignore': 'draft.md\n', '.env': 'SECRET=1', 'shot.png': Buffer.from('PNG') });
        const out = await markest(['draft', folder, '--title', 'Mine', '--json']);
        assert.equal(out.code, 0, out.stderr);
        const sent = site.requests.find((one) => one.method === 'POST').json;
        assert.deepEqual(sent.documents.map((doc) => doc.path), ['README.md', 'notes.md']);
        assert.equal(sent.title, 'Mine');
        assert.match(out.stderr, /Left out 1 images: a draft holds none\./);
        assert.equal(JSON.parse(out.stdout).draft, true);
        const opened = await markest(['draft', folder, '--default', 'notes.md']);
        const reopened = site.requests.filter((one) => one.method === 'POST').at(-1).json;
        assert.equal(reopened.default_path, 'notes.md');
        assert.equal(reopened.title, 'Notes', 'titled by the document it opens on');
        assert.equal(opened.code, 0);
        const missing = await markest(['draft', folder, '--default', 'gone.md']);
        assert.equal(missing.code, 1);
        assert.equal(missing.stderr, 'markest: There is no document gone.md to open on.\n');
    });
});

test('the limits are asked again when the connection drops', async () => {
    await withSite({}, async (site, markest) => {
        const folder = await makeFolder({ 'a.md': 'a' });
        site.answerOnce((one) => one.method === 'GET' && one.path === '/api/v1/drafts', (req) => { req.socket.destroy(); });
        const out = await markest(['draft', folder]);
        assert.equal(out.code, 0, out.stderr);
        assert.equal(site.requests.filter((one) => one.method === 'GET').length, 2);
    });
});

test('what a draft cannot hold is refused with nothing sent, exit 4; a site with drafts off says so', async () => {
    await withSite({}, async (site, markest) => {
        const folder = await makeFolder({ 'page.html': '<!doctype html><p>hi</p>' });
        const out = await markest(['draft', folder]);
        assert.equal(out.code, 4);
        assert.match(out.stderr, /A draft cannot hold this: an HTML page, which a draft cannot hold: page\.html\. Nothing was sent\./);
        assert.equal(site.requests.filter((one) => one.method === 'POST').length, 0);
        const empty = await makeFolder({});
        assert.match((await markest(['draft', empty])).stderr, /there is no document to publish/);
        const two = await makeFolder({ 'page.html': '<!doctype html><p>hi</p>', 'a.md': 'a' });
        site.answerOnce((one) => one.method === 'GET' && one.path === '/api/v1/drafts', (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ enabled: true, max_documents: 1, max_total_bytes: 262144, html: false }));
        });
        const both = await markest(['draft', two]);
        assert.equal(both.code, 4);
        assert.equal(both.stderr, 'markest: A draft cannot hold this: 2 documents, where a draft holds 1; an HTML page, which a draft cannot hold: page.html. Nothing was sent.\n');
        assert.equal(site.requests.filter((one) => one.method === 'POST').length, 0);
    });
    await withSite({ drafts: { enabled: false } }, async (site, markest) => {
        const folder = await makeFolder({ 'a.md': 'a' });
        const out = await markest(['draft', folder]);
        assert.equal(out.code, 1);
        assert.match(out.stderr, /publishing without an account turned off/);
    });
    // A device is neither: the null device, as each system names it
    const device = process.platform === 'win32' ? '//./nul' : '/dev/null';
    await withSite({}, async (site, markest) => {
        for (const target of ['no/such/thing', device]) {
            const out = await markest(['draft', target]);
            assert.equal(out.code, 2, target);
            assert.equal(out.stderr, 'markest: ' + target + ' is not a file or a folder.\n');
        }
        for (const argv of [['draft'], ['draft', 'a', 'b']]) {
            const out = await markest(argv);
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: Name one file or folder: markest draft <file|folder>\nRun markest --help for the commands.\n', argv.join(' '));
        }
        assert.equal(site.requests.length, 0, 'nothing asked of the site');
    });
});
