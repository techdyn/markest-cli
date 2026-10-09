/**
 * Regression test: `markest publish --sealed` against the
 * fake site (cli/publish/sealed-publish). Every document reaches the site as an
 * envelope with its type, the key never does; the address printed carries the
 * key, which is kept here the moment the artifact exists; an image shown stops
 * it with nothing sent; an update opens what is there and seals only what
 * changed, each keeping the type it was sealed as.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshHome, KEY, makeFolder, run, testKeyring } from './support/cli-harness.mjs';
import { keyIn, openAll } from '../src/sealed/sealing.mjs';
import { isEnvelope } from '../src/shared.mjs';

const FOLDER = { 'README.md': '# Sealed plan\n\nStep one.\n', 'docs/setup.md': '# Setup\n', 'main.py': 'print(1)\n' };

async function withSite(body) {
    const site = await startFakeMarkest();
    const keyring = await freshHome();
    const env = { MARKEST_API_KEY: KEY, MARKEST_HOME: keyring };
    try {
        await body(site, (argv) => run([...argv, '--url', site.url], env), keyring);
    } finally {
        await site.close();
    }
}

const leaked = (site, key) => site.requests.some((one) => JSON.stringify([one.path, one.query, one.headers]).includes(key) || one.bytes.toString().includes(key));
const opened = async (site, paste, key) => openAll(key, paste.documents.map((doc) => ({ path: doc.path, contentType: doc.content_type, content: doc.content })));

test('a folder goes as envelopes with their types, the key only in the link printed, kept here at once', async () => {
    await withSite(async (site, markest, keyring) => {
        const out = await markest(['publish', await makeFolder(FOLDER), '--sealed', '--visibility', 'private']);
        assert.equal(out.code, 0, out.stderr);
        const create = site.requests.find((one) => one.method === 'POST' && one.path === '/api/v1/pastes').json;
        assert.equal(create.sealed, true);
        assert.equal(create.visibility, 'private');
        assert.equal(create.title, 'Sealed plan', 'the title is the site\'s to read, as the browser sends it');
        assert.deepEqual(create.documents.map((doc) => [doc.path, doc.content_type, isEnvelope(doc.content)]), [['README.md', 'markdown', true], ['docs/setup.md', 'markdown', true], ['main.py', 'code', true]]);
        assert.ok(!JSON.stringify(create).includes('Step one'), 'nothing in the clear');

        const [paste] = site.pastes.values();
        const key = keyIn(out.stdout.trim());
        assert.match(out.stdout, new RegExp('^' + site.url.replace(/[.]/g, '\\.') + '/p/' + paste.id + '#key=[A-Za-z0-9_-]{43}\\n$'));
        assert.match(out.stderr, /Encrypted end to end: the key is in this link and kept on this machine \(markest keys\)\. Whoever has the link can read it\./);
        assert.ok(!leaked(site, key), 'the key went nowhere');
        assert.equal(await testKeyring(keyring).get(site.url, paste.id), key, 'kept here');
        assert.deepEqual((await opened(site, paste, key)).map((doc) => doc.content), [FOLDER['README.md'], FOLDER['docs/setup.md'], FOLDER['main.py']]);
        assert.equal(paste.defaultPath, 'README.md');

        const json = JSON.parse((await markest(['publish', await makeFolder(FOLDER), '--sealed', '--json'])).stdout);
        assert.equal(json.encrypted, true);
        assert.match(json.url, /#key=/);
    });
});

test('an image a document shows stops it with nothing sent; one nothing shows is no matter', async () => {
    await withSite(async (site, markest) => {
        const out = await markest(['publish', await makeFolder({ 'README.md': '![chart](chart.png)\n', 'chart.png': Buffer.from('PNG') }), '--sealed']);
        assert.equal(out.code, 4);
        assert.match(out.stderr, /Error: sealed_image chart\.png/);
        assert.equal(site.requests.length, 0, 'nothing sent');
        const unshown = await markest(['publish', await makeFolder({ 'README.md': '# Hi\n', 'spare.png': Buffer.from('PNG') }), '--sealed']);
        assert.equal(unshown.code, 0, unshown.stderr);
        assert.equal(site.requests.filter((one) => one.method === 'PUT').length, 0);
    });
});

test('an update opens what is there with the link\'s key, and seals only what changed, keeping each type', async () => {
    await withSite(async (site, markest, keyring) => {
        const folder = await makeFolder({ 'README.md': '# Plan\n', 'notes.txt': 'notes', 'old.md': 'old' });
        const first = await markest(['publish', folder, '--sealed']);
        const link = first.stdout.trim();
        const key = keyIn(link);
        const [paste] = site.pastes.values();
        // The type the browser chose for one, which its name would not give
        paste.documents.find((doc) => doc.path === 'notes.txt').content_type = 'code';
        const { sealAll } = await import('../src/sealed/sealing.mjs');
        paste.documents.find((doc) => doc.path === 'notes.txt').content = (await sealAll(key, [{ path: 'notes.txt', contentType: 'code', content: 'notes' }]))[0].content;
        await testKeyring(keyring).forget(site.url, paste.id);

        const changed = await makeFolder({ 'README.md': '# Plan, again\n', 'notes.txt': 'more notes', 'new.md': 'new' });
        const before = site.requests.length;
        const out = await markest(['publish', changed, '--update', link, '--prune']);
        assert.equal(out.code, 0, out.stderr);
        const sent = site.requests.slice(before).find((one) => one.method === 'POST' && one.path.endsWith('/documents')).json.documents;
        assert.deepEqual(sent.map((doc) => [doc.path, doc.content_type]), [['new.md', 'markdown'], ['notes.txt', 'code'], ['README.md', 'markdown']], 'added, then changed in the folder\'s order, each its type');
        assert.ok(sent.every((doc) => isEnvelope(doc.content)));
        assert.deepEqual(Object.fromEntries((await opened(site, paste, key)).map((doc) => [doc.path, doc.content])), { 'README.md': '# Plan, again\n', 'notes.txt': 'more notes', 'new.md': 'new' }, 'old.md pruned');
        assert.equal(out.stdout, link.replace(/\/p\/.*#/, '/p/' + paste.id + '#') + '\n', 'the link again');
        assert.equal(await testKeyring(keyring).get(site.url, paste.id), key, 'the owner\'s key kept again');
        assert.ok(!leaked(site, key));

        const same = await markest(['publish', changed, '--update', paste.id]);
        assert.equal(same.code, 0, same.stderr);
        assert.match(same.stderr, /Nothing changed\./, 'by id, with the key kept here');
        const dry = JSON.parse((await markest(['publish', await makeFolder({ 'README.md': 'x' }), '--update', paste.id, '--dry-run', '--json'])).stdout);
        assert.deepEqual(dry.documents, { created: 0, updated: 1, unchanged: 0, deleted: 0 });
    });
});

test('an update with no key, the wrong key, an image, or --sealed on an artifact in the clear stops before writing', async () => {
    await withSite(async (site, markest, keyring) => {
        const link = (await markest(['publish', await makeFolder({ 'README.md': '# P\n' }), '--sealed'])).stdout.trim();
        const [paste] = site.pastes.values();
        await testKeyring(keyring).forget(site.url, paste.id);
        const writes = () => site.requests.filter((one) => one.method !== 'GET').length;
        const before = writes();
        const none = await markest(['publish', await makeFolder({ 'README.md': 'x' }), '--update', paste.id]);
        assert.equal(none.code, 4);
        assert.match(none.stderr, /keeps no key for it: give --update its whole link/);
        const { newKey } = await import('../src/sealed/sealing.mjs');
        const wrong = await markest(['publish', await makeFolder({ 'README.md': 'x' }), '--update', site.url + '/p/' + paste.id + '#key=' + (await newKey()).text]);
        assert.equal(wrong.code, 4);
        assert.match(wrong.stderr, /The key does not open README\.md/);
        const image = await markest(['publish', await makeFolder({ 'README.md': '![a](a.png)', 'a.png': Buffer.from('P') }), '--update', link]);
        assert.equal(image.code, 4);
        assert.match(image.stderr, /holds no image/);
        assert.equal(writes(), before, 'nothing written');

        const clear = (await markest(['publish', await makeFolder({ 'README.md': '# Clear\n' })])).stdout.trim();
        const refused = await markest(['publish', await makeFolder({ 'README.md': 'x' }), '--update', clear, '--sealed']);
        assert.equal(refused.code, 4);
        assert.match(refused.stderr, /encrypted only when it is made/);
    });
});

test('a key that cannot be kept is a warning, as the link printed still holds it', async () => {
    const site = await startFakeMarkest();
    try {
        const folder = await makeFolder({ 'README.md': '# P\n', 'blocker': 'a file where the store\'s folder would be' });
        const out = await run(['publish', folder, '--sealed', '--ignore', 'blocker', '--url', site.url], { MARKEST_API_KEY: KEY, MARKEST_HOME: folder + '/blocker/keys.json' });
        assert.equal(out.code, 0, out.stderr);
        assert.match(out.stdout, /#key=/);
        assert.match(out.stderr, /could not keep the key; keep the link printed, which holds it/);
    } finally {
        await site.close();
    }
});

test('the first request carries what it opens on and no visibility not asked for; a refused create says where it stopped', async () => {
    await withSite(async (site, markest) => {
        const out = await markest(['publish', await makeFolder({ 'b.md': 'b', 'README.md': '# R' }), '--sealed']);
        assert.equal(out.code, 0, out.stderr);
        const create = site.requests.find((one) => one.method === 'POST' && one.path === '/api/v1/pastes').json;
        assert.equal(create.default_path, 'README.md');
        assert.ok(!('visibility' in create), 'the account\'s own, when not asked');
        assert.deepEqual(site.requests.filter((one) => one.method !== 'GET').map((one) => one.method + ' ' + one.path.replace(/[0-9A-Z]{26}/, ':id')), ['POST /api/v1/pastes'], 'one request, nothing set after');
        site.answerOnce((one) => one.method === 'POST', (req, res) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"Artifacts encrypted end to end are not available on your current plan."}'); });
        const refused = JSON.parse((await markest(['publish', await makeFolder({ 'README.md': '# R' }), '--sealed', '--json'])).stdout);
        assert.deepEqual([refused.status, refused.stage, refused.error], ['failed', 'create', 'Artifacts encrypted end to end are not available on your current plan.']);
    });
});

test('an update of one found sealed says so, counts what changed, writes nothing on a dry run, and prunes only when asked', async () => {
    await withSite(async (site, markest) => {
        const folder = await makeFolder({ 'README.md': '# A', 'old.md': 'old', 'keep.md': 'k' });
        const link = (await markest(['publish', folder, '--sealed'])).stdout.trim();
        const [paste] = site.pastes.values();
        const changed = await makeFolder({ 'README.md': '# B', 'keep.md': 'k', 'new.md': 'n' });
        const writes = () => site.requests.filter((one) => one.method !== 'GET').length;

        const before = writes();
        const dry = JSON.parse((await markest(['publish', changed, '--update', paste.id, '--prune', '--dry-run', '--json'])).stdout);
        assert.deepEqual([dry.status, dry.encrypted, dry.documents], ['dry_run', true, { created: 1, updated: 1, unchanged: 1, deleted: 1 }]);
        assert.equal(writes(), before, 'a dry run writes nothing');

        const kept = JSON.parse((await markest(['publish', changed, '--update', paste.id, '--json'])).stdout);
        assert.deepEqual([kept.status, kept.encrypted, kept.documents], ['updated', true, { created: 1, updated: 1, unchanged: 1, deleted: 0 }], 'found sealed, though --sealed was not given');
        assert.ok(paste.documents.some((doc) => doc.path === 'old.md'), 'nothing removed unasked');
        const pruned = JSON.parse((await markest(['publish', changed, '--update', paste.id, '--prune', '--json'])).stdout);
        assert.deepEqual([pruned.status, pruned.documents], ['updated', { created: 0, updated: 0, unchanged: 3, deleted: 1 }]);
        const deletes = site.requests.filter((one) => one.method === 'DELETE').length;
        const nothing = JSON.parse((await markest(['publish', changed, '--update', paste.id, '--prune', '--json'])).stdout);
        assert.equal(nothing.status, 'unchanged');
        assert.equal(site.requests.filter((one) => one.method === 'DELETE').length, deletes, 'nothing to prune, nothing deleted');
        assert.ok(link.includes('#key='));
    });
});

test('an update that would break the site\'s rules, or shows an image, says what is wrong as JSON too', async () => {
    await withSite(async (site, markest) => {
        await markest(['publish', await makeFolder({ 'README.md': '# A', 'Notes.md': 'n' }), '--sealed']);
        const [paste] = site.pastes.values();
        const clash = JSON.parse((await markest(['publish', await makeFolder({ 'README.md': '# A', 'notes.md': 'n' }), '--update', paste.id, '--json'])).stdout);
        assert.deepEqual([clash.status, clash.errors], ['refused', [{ code: 'case_rename', path: 'notes.md', target: 'Notes.md' }]]);
        assert.match(clash.error, /only in case or accents/);
        const image = JSON.parse((await markest(['publish', await makeFolder({ 'README.md': '![a](a.png)', 'a.png': Buffer.from('P') }), '--update', paste.id, '--json'])).stdout);
        assert.deepEqual(image.errors, [{ code: 'sealed_image', path: 'a.png' }]);
    });
});

test('published with no key store, it still prints the link that holds the key', async () => {
    const { publish } = await import('../src/publish/publish-run.mjs');
    const { scanFolder } = await import('../src/publish/folder-scan.mjs');
    const { createClient } = await import('../src/core/api-client.mjs');
    const site = await startFakeMarkest();
    try {
        const scan = await scanFolder(await makeFolder({ 'README.md': '# Bare' }));
        const options = { title: null, visibility: null, defaultPath: null, update: null, prune: false, dryRun: false, sealed: true, updateKey: null };
        const result = await publish({ scan, options, baseUrl: site.url }, { client: createClient({ baseUrl: site.url, key: KEY }) });
        assert.equal(result.status, 'published');
        assert.match(result.url, /#key=[A-Za-z0-9_-]{43}$/);
        assert.deepEqual(result.warnings, []);
    } finally {
        await site.close();
    }
});
