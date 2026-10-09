/**
 * Regression test: `markest publish <folder>` against a
 * stand-in for the REST API. A folder is one create, its shown images once each
 * as their own bytes, and one overwrite pointing the documents at them; public
 * with images is published last; an update sends only what changed and removes
 * documents only with --prune; a create is never repeated; the key is never
 * printed; nothing hidden, generated, ignored or secret is ever sent. An
 * update, dry run or not, says only the title and opening document asked for,
 * else the artifact's own - never the folder's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshHome, makeFolder, run, KEY } from './support/cli-harness.mjs';
import { publish } from '../src/publish/publish-run.mjs';
import { scanFolder } from '../src/publish/folder-scan.mjs';
import { ApiError } from '../src/core/api-client.mjs';
import { isEnvelope } from '../src/shared.mjs';

const SITE_FILES = {
    'README.md': '# Sample Site\n\n![chart](img/chart.png)\n',
    'docs/setup.md': '# Setup\n\n![again](../img/chart.png "Chart")\n![copy](../img/copy.png)\n',
    'index.html': '<!doctype html><img src="img/logo.png?v=2" alt="">',
    'main.py': 'print(1)\n',
    'img/chart.png': Buffer.from('PNG-CHART'),
    'img/copy.png': Buffer.from('PNG-CHART'),
    'img/logo.png': Buffer.from('PNG-LOGO'),
    'img/unused.png': Buffer.from('PNG-UNUSED'),
    '.env': 'SECRET=1',
    '.npmrc': '//registry/:_auth' + 'Token=x',
    '.git/config': '[core]',
    'node_modules/x/index.js': 'x',
    'dist/bundle.js': 'x',
    'notes/private.md': 'private',
    '.markestignore': 'notes/\n',
    'config/service-account.json': '{"type": "service_account"}',
    'keys.yaml': 'key: -----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
};

async function withSite(options, body) {
    const site = await startFakeMarkest(options);
    try {
        await body(site);
    } finally {
        await site.close();
    }
}

const sent = (site) => site.requests.map((one) => one.method + ' ' + one.path.replace(/[0-9A-Z]{26}/g, ':id'));

test('a folder is one create, each shown image once as bytes, then one overwrite of the documents that show them', async () => {
    const folder = await makeFolder(SITE_FILES);
    await withSite({}, async (site) => {
        const { code, stdout, stderr } = await run(['publish', folder, '--url', site.url]);
        assert.equal(code, 0, stderr);
        const [paste] = site.pastes.values();
        assert.equal(stdout, site.url + '/p/' + paste.id + '\n', 'stdout is the address alone');
        assert.deepEqual(sent(site), [
            'POST /api/v1/pastes',
            'PUT /api/v1/pastes/:id/images',
            'PUT /api/v1/pastes/:id/images',
            'POST /api/v1/pastes/:id/documents',
        ]);
        const create = site.requests[0].json;
        assert.equal(create.title, 'Sample Site');
        assert.equal(create.default_path, 'README.md');
        assert.deepEqual(create.documents.map((doc) => doc.path), ['README.md', 'docs/setup.md', 'index.html', 'main.py']);
        assert.equal(create.visibility, undefined, 'the account decides when --visibility is not given');
        assert.ok(create.documents.every((doc) => doc.content_type === undefined), 'the server decides each type');

        const uploads = site.requests.filter((one) => one.method === 'PUT');
        assert.deepEqual(uploads.map((one) => one.query.name), ['chart.png', 'logo.png'], 'two files with the same bytes go up once; an image nothing shows not at all');
        assert.equal(uploads[0].bytes.toString(), 'PNG-CHART', 'the bytes themselves, not base64');
        assert.equal(uploads[0].headers['content-type'], 'image/png');

        const rewrite = site.requests[3].json;
        assert.equal(rewrite.overwrite, true);
        const [chart, logo] = paste.images;
        const byPath = Object.fromEntries(rewrite.documents.map((doc) => [doc.path, doc.content]));
        assert.deepEqual(Object.keys(byPath), ['README.md', 'docs/setup.md', 'index.html'], 'only the documents that show an image');
        assert.equal(byPath['README.md'], '# Sample Site\n\n![chart](' + chart.path + ')\n');
        assert.equal(byPath['docs/setup.md'], '# Setup\n\n![again](' + chart.path + ' "Chart")\n![copy](' + chart.path + ')\n');
        assert.equal(byPath['index.html'], '<!doctype html><img src="' + logo.path + '" alt="">', 'the query goes with the local address');

        const everything = site.requests.map((one) => one.bytes.toString('utf8')).join('\n');
        for (const secret of ['SECRET=1', '_authToken', '[core]', 'bundle', 'private', 'service_account', 'OPENSSH']) {
            assert.ok(!everything.includes(secret), secret + ' was never sent');
        }
        assert.match(stderr, /service-account\.json/, 'a file taken for a secret is named');
    });
});

test('public with images is created unlisted and published last; a confirmation to give is exit 3', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n\n![x](x.png)\n', 'x.png': Buffer.from('PNG') });
    await withSite({ requireApproval: true }, async (site) => {
        const { code, stdout, stderr } = await run(['publish', folder, '--url', site.url, '--visibility', 'public']);
        assert.equal(code, 3);
        assert.deepEqual(sent(site), ['POST /api/v1/pastes', 'PUT /api/v1/pastes/:id/images', 'POST /api/v1/pastes/:id/documents', 'POST /api/v1/pastes/visibility']);
        assert.equal(site.requests[0].json.visibility, 'unlisted');
        assert.match(stdout, /\/p\/[0-9A-Z]{26}\n$/, 'the address is still printed');
        assert.match(stderr, /approve\/2/, 'the approval link is given');
        assert.match(stderr, /Nothing is public until you approve it/);
    });
});

test('public without images is one create asking for public; its confirmation is exit 3 with the link in the JSON', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n' });
    await withSite({ requireApproval: true }, async (site) => {
        const { code, stdout } = await run(['publish', folder, '--url', site.url, '--visibility', 'public', '--json']);
        assert.equal(code, 3);
        assert.deepEqual(sent(site), ['POST /api/v1/pastes']);
        assert.equal(site.requests[0].json.visibility, 'public');
        const result = JSON.parse(stdout);
        assert.equal(result.status, 'approval_required');
        assert.equal(result.exit_code, 3);
        assert.match(result.approval_url, /approve\/1$/);
    });
});

test('an update of an unchanged folder only reads, and says it is unchanged', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n\n![x](x.png)\n', 'x.png': Buffer.from('PNG') });
    await withSite({}, async (site) => {
        await run(['publish', folder, '--url', site.url]);
        const [paste] = site.pastes.values();
        site.requests.length = 0;
        const { code, stdout, stderr } = await run(['publish', folder, '--url', site.url, '--update', site.url + '/p/' + paste.id + '/README.md']);
        assert.equal(code, 0, stderr);
        assert.deepEqual(sent(site), ['GET /api/v1/pastes/:id', 'GET /api/v1/pastes/:id/images'], 'an image already there is found by its checksum');
        assert.equal(stdout, site.url + '/p/' + paste.id + '\n');
        assert.match(stderr, /Nothing changed/);
    });
});

test('an update sends what changed in one request, keeps what the folder lost unless --prune, and keeps a chosen type', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n', 'b.md': 'b\n', 'c.md': 'c\n' });
    await withSite({}, async (site) => {
        await run(['publish', folder, '--url', site.url]);
        const [paste] = site.pastes.values();
        paste.documents.find((doc) => doc.path === 'b.md').content_type = 'code';
        paste.documents.find((doc) => doc.path === 'b.md').title = 'Chosen';

        const edited = await makeFolder({ 'README.md': '# A\n', 'b.md': 'b changed\n', 'd.md': 'd\n' });
        site.requests.length = 0;
        const kept = await run(['publish', edited, '--url', site.url, '--update', paste.id]);
        assert.equal(kept.code, 0, kept.stderr);
        assert.deepEqual(sent(site), ['GET /api/v1/pastes/:id', 'GET /api/v1/pastes/:id/images', 'POST /api/v1/pastes/:id/documents']);
        assert.deepEqual(site.requests[2].json.documents, [
            { path: 'd.md', content: 'd\n' },
            { path: 'b.md', content: 'b changed\n', content_type: 'code' },
        ]);
        assert.ok(paste.documents.some((doc) => doc.path === 'c.md'), 'a document gone from the folder stays without --prune');
        assert.equal(paste.documents.find((doc) => doc.path === 'b.md').title, 'Chosen', 'replacing the text keeps the title');

        site.requests.length = 0;
        const pruned = await run(['publish', edited, '--url', site.url, '--update', paste.id, '--prune']);
        assert.equal(pruned.code, 0, pruned.stderr);
        assert.deepEqual(sent(site), ['GET /api/v1/pastes/:id', 'GET /api/v1/pastes/:id/images', 'DELETE /api/v1/pastes/:id/documents']);
        assert.equal(site.requests[2].query.path, 'c.md');
    });
});

test('an update of an artifact that is not the caller\'s, or with a key that cannot read, writes nothing', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n' });
    await withSite({}, async (site) => {
        await run(['publish', folder, '--url', site.url]);
        const [paste] = site.pastes.values();
        paste.owner = 'someone else';
        site.requests.length = 0;
        const theirs = await run(['publish', folder, '--url', site.url, '--update', paste.id]);
        assert.equal(theirs.code, 1);
        assert.match(theirs.stderr, /only update artifacts you own/);
        assert.equal(site.writes().length, 0);
    });
    await withSite({ permissions: ['create_paste'] }, async (site) => {
        const blind = await run(['publish', folder, '--url', site.url, '--update', '01ARZ3NDEKTSV4RRFFQ69G5FAV']);
        assert.equal(blind.code, 1);
        assert.match(blind.stderr, /read_own/);
        assert.equal(site.writes().length, 0);
    });
});

test('an image is reused only from an upload, never from a copy the proxy made of the same picture', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n', 'b.md': '![x](x.png)\n', 'x.png': Buffer.from('PNG') });
    await withSite({}, async (site) => {
        const { code, stderr } = await run(['publish', folder, '--url', site.url, '--update', createBare(site)]);
        assert.equal(code, 0, stderr);
        const [paste] = site.pastes.values();
        const uploads = site.requests.filter((one) => one.method === 'PUT');
        assert.equal(uploads.length, 1, 'the copy with the same checksum was not taken for it');
        assert.equal(paste.documents.find((doc) => doc.path === 'b.md').content, '![x](' + paste.images[1].path + ')\n');
    });
});

/** An artifact holding only a proxy copy of the picture the folder shows; its id. */
function createBare(site) {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    site.pastes.set(id, {
        id, owner: 'me', title: 'A', visibility: 'unlisted', defaultPath: 'README.md',
        documents: [{ path: 'README.md', content: '# A\n', content_type: 'markdown', title: null }],
        images: [{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', source: 'proxy', sha256: createHash('sha256').update('PNG').digest('hex'), path: '/img/' + id + '/copy' }],
    });
    return id;
}

test('a case-only rename against the artifact is refused before anything is written', async () => {
    const folder = await makeFolder({ 'Readme.md': '# A\n' });
    await withSite({}, async (site) => {
        await run(['publish', folder, '--url', site.url]);
        const [paste] = site.pastes.values();
        const renamed = await makeFolder({ 'README.md': '# A\n' });
        site.requests.length = 0;
        const { code, stderr } = await run(['publish', renamed, '--url', site.url, '--update', paste.id]);
        assert.equal(code, 4);
        assert.match(stderr, /case_rename/);
        assert.equal(site.writes().length, 0);
    });
});

test('a dry run of a new artifact asks the site nothing and needs no key', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n\n![x](x.png)\n', 'x.png': Buffer.from('PNG') });
    await withSite({}, async (site) => {
        const { code, stdout } = await run(['publish', folder, '--url', site.url, '--dry-run'], {});
        assert.equal(code, 0);
        assert.match(stdout, /1 new.*1 images to upload/s);
        assert.equal(site.requests.length, 0);

        const result = JSON.parse((await run(['publish', folder, '--url', site.url, '--dry-run', '--json'], {})).stdout);
        assert.deepEqual([result.status, result.title, result.default_path, result.documents.created], ['dry_run', 'A', 'README.md', 1]);
        assert.deepEqual(result.images.uploaded, [{ path: 'x.png', id: null, path_on_site: null }], 'each image that would go up, with no address yet');
        assert.equal(site.requests.length, 0);
    });
});

test('a create whose answer is lost is not repeated, and says the artifact may exist', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n' });
    await withSite({}, async (site) => {
        site.answerOnce((record) => record.method === 'POST' && record.path === '/api/v1/pastes', (req) => {
            req.socket.destroy();
        });
        const { code, stderr } = await run(['publish', folder, '--url', site.url]);
        assert.equal(code, 1);
        assert.equal(site.requests.filter((one) => one.path === '/api/v1/pastes').length, 1);
        assert.match(stderr, /may have been created/);
    });
});

test('an image upload whose answer is lost is looked for by its checksum, not sent twice', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n\n![x](x.png)\n', 'x.png': Buffer.from('PNG') });
    await withSite({}, async (site) => {
        site.answerOnce((record) => record.method === 'PUT', async (req, res, record, proceed) => {
            // Stored, then the connection drops before the answer arrives.
            const original = res.end.bind(res);
            res.end = () => req.socket.destroy();
            await proceed();
            res.end = original;
        });
        const { code, stderr } = await run(['publish', folder, '--url', site.url]);
        assert.equal(code, 0, stderr);
        assert.equal(site.requests.filter((one) => one.method === 'PUT').length, 1);
        const [paste] = site.pastes.values();
        assert.equal(paste.images.length, 1);
        assert.equal(paste.documents[0].content, '# A\n\n![x](' + paste.images[0].path + ')\n');
    });
});

test('a folder the site would refuse is refused with nothing sent (exit 4)', async () => {
    const big = await makeFolder({ 'README.md': '# A\n' + 'x'.repeat(600 * 1024) });
    await withSite({}, async (site) => {
        const { code, stderr } = await run(['publish', big, '--url', site.url]);
        assert.equal(code, 4);
        assert.match(stderr, /file_size/);
        assert.equal(site.requests.length, 0);
    });
    const empty = await makeFolder({ 'picture.png': Buffer.from('PNG') });
    const { code } = await run(['publish', empty, '--url', 'https://marke.st']);
    assert.equal(code, 4, 'no documents');
});

test('the key is never printed, even when the site echoes it', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n' });
    await withSite({}, async (site) => {
        site.answerOnce(() => true, (req, res) => {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid key ' + KEY }));
        });
        const human = await run(['publish', folder, '--url', site.url]);
        site.answerOnce(() => true, (req, res) => {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid key ' + KEY }));
        });
        const machine = await run(['publish', folder, '--url', site.url, '--json']);
        for (const out of [human, machine]) {
            assert.equal(out.code, 1);
            assert.ok(!(out.stdout + out.stderr).includes(KEY));
            assert.ok(!(out.stdout + out.stderr).includes(KEY.slice(8)));
        }
        assert.match(human.stderr, /Invalid key mk_…/);
    });
});

test('a symbolic link in the folder is never followed', async (t) => {
    const outside = await makeFolder({ 'secret.md': 'OUTSIDE' });
    const folder = await makeFolder({ 'README.md': '# A\n' });
    try {
        // A junction needs no privilege on Windows, and Node reports it as a link.
        await symlink(outside, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
        t.skip('this system does not let the test make a link');
        return;
    }
    await withSite({}, async (site) => {
        const { code, stdout } = await run(['publish', folder, '--url', site.url, '--json']);
        assert.equal(code, 0);
        assert.ok(!site.requests.some((one) => one.bytes.toString().includes('OUTSIDE')));
        assert.deepEqual(JSON.parse(stdout).skipped, [{ path: 'linked', reason: 'symlink' }], 'said to be a link');
    });
});

test('an address the key could travel to in the clear is refused before any request', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n' });
    const { code, stderr } = await run(['publish', folder, '--url', 'http://example.test']);
    assert.equal(code, 2);
    assert.match(stderr, /https/);
});

const json = async (argv, env) => {
    const out = await run([...argv, '--json'], env);
    return { code: out.code, result: JSON.parse(out.stdout) };
};

test('a publish says what went up: each image with its address, no warning for one being sent, and published', async () => {
    const folder = await makeFolder({ 'README.md': '# A\n\n![x](x.png)\n', 'x.png': Buffer.from('PNG') });
    await withSite({}, async (site) => {
        const { code, result } = await json(['publish', folder, '--url', site.url]);
        assert.equal(code, 0);
        const [image] = [...site.pastes.values()][0].images;
        assert.equal(result.status, 'published');
        assert.deepEqual(result.images, { uploaded: [{ path: 'x.png', id: image.id, path_on_site: image.path }], reused: [], refused: [], unshown: [] });
        assert.deepEqual(result.warnings, [], 'an image being sent is no warning');
    });
});

test('a folder the site would refuse says why, under the folder\'s own name when it has no opening document', async () => {
    const folder = await makeFolder({ 'README.md': '# A heading\n' });
    await withSite({}, async (site) => {
        const { code, result } = await json(['publish', folder, '--url', site.url, '--default', 'missing.md']);
        assert.equal(code, 4);
        assert.deepEqual([result.status, result.stage, result.error], ['refused', 'plan', 'The folder cannot be published as it is; nothing was sent.']);
        assert.deepEqual(result.errors, [{ code: 'default_missing' }]);
        assert.equal(result.title, basename(folder), 'no document to take a heading from');
        assert.equal(result.default_path, null);
        assert.equal(site.requests.length, 0);
    });
});

test('an update says what it did: documents counted, an image already there reused, and updated only when something was written', async () => {
    const files = { 'README.md': '# A\n\n![x](x.png)\n', 'x.png': Buffer.from('PNG'), 'b.md': 'b\n', 'c.md': 'c\n' };
    await withSite({}, async (site) => {
        await run(['publish', await makeFolder(files), '--url', site.url]);
        const [paste] = site.pastes.values();
        const [image] = paste.images;
        // The folder with `changes`: a path given as undefined is gone from it
        const edited = (changes) => Object.fromEntries(Object.entries({ ...files, ...changes }).filter(([, content]) => content !== undefined));
        const update = async (changes, ...flags) => (await json(['publish', await makeFolder(edited(changes)), '--url', site.url, '--update', paste.id, ...flags])).result;

        const changed = await update({ 'b.md': 'b changed\n' });
        assert.equal(changed.status, 'updated');
        assert.deepEqual(changed.documents, { created: 0, updated: 1, unchanged: 2, deleted: 0 });
        assert.deepEqual(changed.images, { uploaded: [], reused: [{ path: 'x.png', id: image.id }], refused: [], unshown: [] });

        const pruned = await update({ 'b.md': 'b changed\n', 'c.md': undefined }, '--prune');
        assert.equal(pruned.status, 'updated', 'a removal alone is a change');
        assert.deepEqual(pruned.documents, { created: 0, updated: 0, unchanged: 2, deleted: 1 });

        site.requests.length = 0;
        const same = await update({ 'b.md': 'b changed\n', 'c.md': undefined }, '--prune');
        assert.equal(same.status, 'unchanged', '--prune with nothing to remove writes nothing');
        assert.equal(same.documents.deleted, 0);
        assert.equal(site.writes().length, 0);
    });
});

test('an update adds documents in the folder\'s order, opens on the document asked for, and refuses one the folder lacks', async () => {
    await withSite({}, async (site) => {
        const paste = site.addPaste({ title: 'T', defaultPath: 'README.md', documents: [{ path: 'README.md', content: '# T\n' }] });
        const folder = await makeFolder({ 'README.md': '# T\n', 'a.md': 'a\n', 'b.md': 'b\n' });
        const { code, stderr } = await run(['publish', folder, '--url', site.url, '--update', paste.id, '--default', 'b.md']);
        assert.equal(code, 0, stderr);
        assert.deepEqual(sent(site), ['GET /api/v1/pastes/:id', 'GET /api/v1/pastes/:id/images', 'POST /api/v1/pastes/:id/documents', 'PATCH /api/v1/pastes/:id']);
        assert.deepEqual(site.requests[2].json.documents.map((doc) => doc.path), ['a.md', 'b.md'], 'not the opening one first: an update leaves the order to the folder');
        assert.deepEqual(site.requests[3].json, { default_path: 'b.md' });
        assert.equal(paste.defaultPath, 'b.md');

        site.requests.length = 0;
        const { code: refused, result } = await json(['publish', folder, '--url', site.url, '--update', paste.id, '--default', 'gone.md']);
        assert.equal(refused, 4);
        assert.deepEqual(result.errors, [{ code: 'default_missing' }]);
        assert.equal(site.requests.length, 0);
    });
});

test('a dry run of an update only reads, counting what would change and which images would go up, the title and opening document as they would be', async () => {
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    await withSite({}, async (site) => {
        const paste = site.addPaste({
            title: 'On the site', defaultPath: 'index.md',
            documents: [{ path: 'index.md', content: '# Index\n' }, { path: 'about.md', content: '# About\n' }, { path: 'old.md', content: 'old\n' }],
            images: [
                { id: 'UPLOADED', source: 'upload', sha256: sha('A'), path: '/img/x/UPLOADED' },
                { id: 'COPIED', source: 'proxy', sha256: sha('B'), path: '/img/x/COPIED' },
            ],
        });
        const folder = await makeFolder({
            'index.md': '# Index\n', 'about.md': '# About\n\n![a](a.png) ![b](b.png) ![c](c.png)\n', 'new.md': 'new\n',
            'a.png': Buffer.from('A'), 'b.png': Buffer.from('B'), 'c.png': Buffer.from('C'),
        });
        const { code, result } = await json(['publish', folder, '--url', site.url, '--update', paste.id, '--dry-run', '--prune']);
        assert.equal(code, 0);
        assert.deepEqual(sent(site), ['GET /api/v1/pastes/:id', 'GET /api/v1/pastes/:id/images']);
        assert.deepEqual([result.status, result.title, result.default_path], ['dry_run', 'On the site', null]);
        assert.deepEqual(result.documents, { created: 1, updated: 1, unchanged: 1, deleted: 1 });
        assert.deepEqual(result.images.uploaded, [{ path: 'b.png', id: null, path_on_site: null }, { path: 'c.png', id: null, path_on_site: null }],
            'only an upload with the same checksum is already there; a copy the proxy made is not');

        const human = await run(['publish', folder, '--url', site.url, '--update', paste.id, '--dry-run']);
        assert.equal(human.stdout, 'Would publish "On the site", opening on (unchanged):\n  1 new, 1 changed, 1 unchanged and 0 removed documents; 2 images to upload.\n');
        const asked = await run(['publish', folder, '--url', site.url, '--update', paste.id, '--dry-run', '--title', 'New name', '--default', 'about.md']);
        assert.equal(asked.stdout.split('\n')[0], 'Would publish "New name", opening on about.md:');
        assert.equal(site.writes().length, 0);
    });
});

test('one encrypted end to end is published and updated by its own rules, and never with an image or sealed after it was made', async () => {
    const env = { MARKEST_API_KEY: KEY, MARKEST_HOME: await freshHome() };
    await withSite({}, async (site) => {
        const folder = await makeFolder({ 'README.md': '# Sealed\n' });
        const made = await json(['publish', folder, '--url', site.url, '--sealed'], env);
        assert.equal(made.code, 0);
        const [paste] = site.pastes.values();
        assert.ok(paste.sealed && paste.documents.every((doc) => isEnvelope(doc.content)), 'made sealed, nothing in the clear');
        assert.match(made.result.url, /#key=/);

        site.requests.length = 0;
        const again = await json(['publish', folder, '--url', site.url, '--update', paste.id], env);
        assert.deepEqual([again.code, again.result.status, again.result.encrypted], [0, 'unchanged', true], 'opened with the key kept here; nothing changed');
        assert.equal(site.writes().length, 0);

        const clear = site.addPaste({ documents: [{ path: 'README.md', content: '# Sealed\n' }] });
        const sealing = await json(['publish', folder, '--url', site.url, '--update', clear.id, '--sealed'], env);
        assert.equal(sealing.code, 4);
        assert.deepEqual([sealing.result.status, sealing.result.stage, sealing.result.error], ['refused', 'plan',
            'That artifact is not encrypted end to end, and one is encrypted only when it is made: publish the folder as a new one with --sealed.']);

        const shown = await json(['publish', await makeFolder({ 'README.md': '![x](x.png)\n', 'x.png': Buffer.from('PNG') }), '--url', site.url, '--sealed'], env);
        assert.equal(shown.code, 4);
        assert.deepEqual(shown.result.errors, [{ code: 'sealed_image', path: 'x.png' }]);
        assert.equal(site.writes().length, 0);
    });
});

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ASKED = { title: null, visibility: null, defaultPath: null, update: null, prune: false, dryRun: false, sealed: false, updateKey: null };
const CREATED = { status: 201, body: { id: ID, url: 'https://marke.st/p/' + ID, title: 'A', visibility: 'unlisted' } };
const PASTE = { id: ID, title: 'There', visibility: 'unlisted', documents: [{ path: 'README.md', content: '# A\n', content_type: 'markdown' }] };
const LOST = () => new ApiError('The connection to the site was lost: ECONNRESET', { lost: true });
const ONE_IMAGE = { 'README.md': '![a](a.png)\n', 'a.png': Buffer.from('A') };
const digest = (text) => createHash('sha256').update(text).digest('hex');

/** A publish of `files` through a site answering `answer(method, path, options)` - an answer, or an error to throw; what it said and was asked. */
async function publishThrough(files, options, answer) {
    const scan = await scanFolder(await makeFolder(files));
    const asked = [];
    const lines = [];
    const client = {
        requests: 0,
        async request(method, path, requestOptions = {}) {
            client.requests++;
            asked.push({ method, path, options: requestOptions });
            const next = await answer(method, path, requestOptions);
            if (next instanceof Error) throw next;
            return next;
        },
    };
    const result = await publish({ scan, options: { ...ASKED, ...options }, baseUrl: 'https://marke.st' }, { client, log: (line) => lines.push(line) });
    return { result, asked, lines, said: asked.map((one) => one.method + ' ' + one.path.replace(ID, ':id')) };
}

test('each image the site refuses is said and the rest goes on; any other refusal stops at the images, and a fault goes up', async () => {
    const files = { 'README.md': '![a](a.png) ![b](b.png)\n', 'a.png': Buffer.from('A'), 'b.png': Buffer.from('B') };
    const site = (refusal) => (method, path, options) => {
        if (method === 'POST' && path === '/api/v1/pastes') return CREATED;
        if (method === 'PUT') return options.query.name === 'a.png' ? refusal() : { status: 201, body: { id: 'B', path: '/img/' + ID + '/B' } };
        return { status: 201, body: {} };
    };
    for (const status of [400, 403, 413, 415, 422]) {
        const { result, asked, lines } = await publishThrough(files, {}, site(() => new ApiError('Not this one.', { status })));
        assert.equal(result.status, 'incomplete', String(status));
        assert.deepEqual(result.images.refused, [{ path: 'a.png', status, error: 'Not this one.' }]);
        assert.deepEqual(result.images.uploaded, [{ path: 'b.png', id: 'B', path_on_site: '/img/' + ID + '/B' }]);
        assert.deepEqual(lines, ['Uploading a.png', 'Uploading b.png']);
        assert.deepEqual(asked.at(-1).options.json.documents, [{ path: 'README.md', content: '![a](a.png) ![b](/img/' + ID + '/B)\n' }], 'not looked for or sent again; left as it was');
    }
    const stopped = await publishThrough(files, {}, site(() => new ApiError('Broken.', { status: 500 })));
    assert.deepEqual([stopped.result.status, stopped.result.stage, stopped.result.error], ['failed', 'images', 'Broken.']);
    assert.deepEqual(stopped.said, ['POST /api/v1/pastes', 'PUT /api/v1/pastes/:id/images']);
    await assert.rejects(publishThrough(files, {}, site(() => new TypeError('a bug'))), { name: 'TypeError', message: 'a bug' });
});

test('an upload whose answer was lost is looked for by a request safe to repeat: taken if it arrived, sent again if not, and a refusal on the way stops at the images', async () => {
    const arrived = await publishThrough(ONE_IMAGE, {}, (method, path) => {
        if (method === 'POST' && path === '/api/v1/pastes') return CREATED;
        if (method === 'PUT') return LOST();
        if (method === 'GET') return { status: 200, body: { images: [{ id: 'THERE', source: 'upload', sha256: digest('A'), path: '/img/' + ID + '/THERE' }] } };
        return { status: 201, body: {} };
    });
    assert.deepEqual(arrived.result.images.uploaded, [{ path: 'a.png', id: 'THERE', path_on_site: '/img/' + ID + '/THERE' }]);
    assert.deepEqual(arrived.asked.map((one) => [one.method, one.options.idempotent]), [['POST', undefined], ['PUT', undefined], ['GET', true], ['POST', true]]);
    assert.equal(arrived.asked[2].path, '/api/v1/pastes/' + ID + '/images');
    assert.deepEqual(arrived.asked[3].options.json.documents, [{ path: 'README.md', content: '![a](/img/' + ID + '/THERE)\n' }]);

    const lostOnce = (listing, again = () => ({ status: 201, body: { id: 'NEW', path: '/img/' + ID + '/NEW' } })) => {
        let puts = 0;
        return (method, path) => {
            if (method === 'POST' && path === '/api/v1/pastes') return CREATED;
            if (method === 'PUT') return puts++ === 0 ? LOST() : again();
            if (method === 'GET') return listing();
            return { status: 201, body: {} };
        };
    };
    const others = () => ({ status: 200, body: { images: [
        { id: 'COPY', source: 'proxy', sha256: digest('A'), path: '/img/' + ID + '/COPY' },
        { id: 'OTHER', source: 'upload', sha256: digest('other'), path: '/img/' + ID + '/OTHER' },
    ] } });
    for (const listing of [others, () => ({ status: 200, body: null })]) {
        const resent = await publishThrough(ONE_IMAGE, {}, lostOnce(listing));
        assert.deepEqual(resent.said, ['POST /api/v1/pastes', 'PUT /api/v1/pastes/:id/images', 'GET /api/v1/pastes/:id/images', 'PUT /api/v1/pastes/:id/images', 'POST /api/v1/pastes/:id/documents'],
            'neither a copy the proxy made nor another upload is taken for it');
        assert.deepEqual(resent.asked[3].options, { body: Buffer.from('A'), contentType: 'image/png', query: { name: 'a.png' } });
        assert.deepEqual(resent.result.images.uploaded, [{ path: 'a.png', id: 'NEW', path_on_site: '/img/' + ID + '/NEW' }]);
        assert.equal(resent.result.status, 'published');
    }

    const blind = await publishThrough(ONE_IMAGE, {}, lostOnce(() => new ApiError('Down.', { status: 500 })));
    assert.deepEqual([blind.result.status, blind.result.stage, blind.result.error], ['failed', 'images', 'Down.']);
    const refusedAgain = await publishThrough(ONE_IMAGE, {}, lostOnce(() => ({ status: 200, body: { images: [] } }), () => new ApiError('Still broken.', { status: 500 })));
    assert.deepEqual([refusedAgain.result.status, refusedAgain.result.stage, refusedAgain.result.error], ['failed', 'images', 'Still broken.']);
});

test('only an answer that waits (202) asks for confirmation; a refused create stops at the create', async () => {
    const named = await publishThrough({ 'README.md': '# A\n' }, {}, () => ({ status: 201, body: { ...CREATED.body, approval_url: 'https://marke.st/app/approve/9' } }));
    assert.deepEqual([named.result.status, named.result.approval_url], ['published', null]);
    const refused = await publishThrough({ 'README.md': '# A\n' }, {}, () => new ApiError('Over the plan.', { status: 403 }));
    assert.deepEqual([refused.result.status, refused.result.stage, refused.result.error], ['failed', 'create', 'Over the plan.']);
});

test('an update reads by requests safe to repeat; a refused read says why, stops at the read, and claims no title or opening document not asked for', async () => {
    const reads = await publishThrough({ 'README.md': '# A\n' }, { update: ID }, (method, path) => (path.endsWith('/images') ? { status: 200, body: { images: [] } } : { status: 200, body: PASTE }));
    assert.deepEqual(reads.asked.map((one) => [one.method, one.path, one.options.idempotent]), [['GET', '/api/v1/pastes/' + ID, true], ['GET', '/api/v1/pastes/' + ID + '/images', true]]);
    assert.deepEqual([reads.result.status, reads.result.title], ['unchanged', 'There']);

    const readOwn = 'Updating needs a key with the read_own permission, so only what changed is sent: No.';
    for (const [which, status, said] of [
        ['paste', 403, readOwn], ['paste', 404, 'There is no artifact ' + ID + ' that this key can read.'], ['paste', 500, 'No.'],
        ['images', 403, readOwn], ['images', 404, 'You can only update artifacts you own.'], ['images', 500, 'No.'],
    ]) {
        const { result } = await publishThrough({ 'README.md': '# A heading\n' }, { update: ID }, (method, path) => {
            if (path.endsWith('/images') === (which === 'images')) return new ApiError('No.', { status });
            return path.endsWith('/images') ? { status: 200, body: { images: [] } } : { status: 200, body: PASTE };
        });
        assert.deepEqual([result.status, result.stage, result.error], ['failed', 'read', said], which + ' ' + status);
        assert.deepEqual([result.title, result.default_path], [null, null], 'the artifact\'s, not the folder\'s');
    }
    const asked = await publishThrough({ 'README.md': '# A heading\n' }, { update: ID, title: ' Asked ', defaultPath: 'README.md' }, () => new ApiError('No.', { status: 500 }));
    assert.deepEqual([asked.result.title, asked.result.default_path], ['Asked', 'README.md'], 'what was asked for');
});

test('a read that lists no documents is an artifact with none, and a listing with no body one with no images', async () => {
    const bare = await publishThrough(ONE_IMAGE, { update: ID }, (method, path) => {
        if (method === 'GET') return path.endsWith('/images') ? { status: 200, body: null } : { status: 200, body: { id: ID, title: 'There', visibility: 'unlisted' } };
        if (method === 'PUT') return { status: 201, body: { id: 'NEW', path: '/img/' + ID + '/NEW' } };
        return { status: 201, body: {} };
    });
    assert.equal(bare.result.status, 'updated');
    assert.deepEqual(bare.result.documents, { created: 1, updated: 0, unchanged: 0, deleted: 0 });
    assert.deepEqual(bare.asked.at(-1).options.json, { documents: [{ path: 'README.md', content: '![a](/img/' + ID + '/NEW)\n' }], overwrite: true });

    const dry = await publishThrough(ONE_IMAGE, { update: ID, dryRun: true }, (method, path) => (path.endsWith('/images') ? { status: 200, body: null } : { status: 200, body: PASTE }));
    assert.deepEqual(dry.result.images.uploaded, [{ path: 'a.png', id: null, path_on_site: null }]);
});

test('an image sent is a change, even when no document needed pointing at it', async () => {
    const pointed = { ...PASTE, documents: [{ path: 'README.md', content: '![a](/img/' + ID + '/NEW)\n', content_type: 'markdown' }] };
    const { result, said } = await publishThrough(ONE_IMAGE, { update: ID }, (method, path) => {
        if (method === 'GET') return path.endsWith('/images') ? { status: 200, body: { images: [] } } : { status: 200, body: pointed };
        return { status: 201, body: { id: 'NEW', path: '/img/' + ID + '/NEW' } };
    });
    assert.deepEqual(said, ['GET /api/v1/pastes/:id', 'GET /api/v1/pastes/:id/images', 'PUT /api/v1/pastes/:id/images']);
    assert.equal(result.status, 'updated');
});
