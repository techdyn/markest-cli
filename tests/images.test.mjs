/**
 * `markest images` against the fake site (cli/commands/images): listed, added
 * as their own bytes under their own names, removed by id.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, makeFolder, run } from './support/cli-harness.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

async function withSite(body) {
    const site = await startFakeMarkest();
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

test('images are added as their own bytes, named by their files, and printed with their addresses', async () => {
    await withSite(async (site, markest) => {
        const paste = site.addPaste({ title: 'T' });
        const folder = await makeFolder({ 'chart.png': Buffer.from('PNG'), 'Logo.SVG': '<svg/>' });
        const out = await markest(['images', paste.id, '--add', join(folder, 'chart.png'), '--add', join(folder, 'Logo.SVG')]);
        assert.equal(out.code, 0, out.stderr);
        const puts = site.requests.filter((one) => one.method === 'PUT');
        assert.deepEqual(puts.map((one) => [one.query.name, one.headers['content-type'], one.bytes.toString()]), [['chart.png', 'image/png', 'PNG'], ['Logo.SVG', 'image/svg+xml', '<svg/>']]);
        assert.match(out.stdout, /^chart\.png {2}\/img\/[0-9A-Z]{26}\/[0-9A-Z]{26}\nLogo\.SVG {2}\/img\//);
        assert.equal(site.pastes.get(paste.id).images[0].sha256, createHash('sha256').update('PNG').digest('hex'));

        const list = await markest(['images', paste.id]);
        assert.match(list.stdout, /^ID +FROM +TYPE +BYTES +ADDRESS +NAME\n[0-9A-Z]{26} +upload +image\/png +3 +\/img\/\S+ +chart\.png\n/);
        const [first] = site.pastes.get(paste.id).images;
        const removed = await markest(['images', paste.id, '--remove', first.id.toLowerCase()]);
        assert.equal(removed.stdout, 'Removed ' + first.id + '\n');
        assert.equal(site.pastes.get(paste.id).images.length, 1);
        assert.equal(JSON.parse((await markest(['images', paste.id, '--json'])).stdout).images.length, 1);
    });
});

test('a file that cannot be read stops it, saying what was added before', async () => {
    await withSite(async (site, markest) => {
        const paste = site.addPaste({ title: 'T' });
        const folder = await makeFolder({ 'a.png': Buffer.from('A') });
        const out = await markest(['images', paste.id, '--add', join(folder, 'a.png'), '--add', join(folder, 'gone.png')]);
        assert.equal(out.code, 1);
        assert.match(out.stderr, /gone\.png could not be read; added before it: a\.png\./);
    });
});

test('what images cannot be is refused before anything is sent', async () => {
    for (const [argv, said] of [[['images', ID, '--add', 'notes.txt'], /not an image the site keeps/], [['images', ID, '--remove', 'img1'], /not an image id/],
        [['images', ID, '--add', 'a.png', '--remove', ID], /one at a time/], [['images'], /Name the artifact/]]) {
        const out = await run(argv);
        assert.equal(out.code, 2, argv.join(' '));
        assert.match(out.stderr, said);
    }
});

test('what images refuses is said exactly and nothing is sent: an extension that is no image, even one every object answers to, an id not 26 letters and digits, or no key', async () => {
    await withSite(async (site, markest) => {
        const paste = site.addPaste({ title: 'T' });
        const kept = 'png, jpg, jpeg, gif, webp, avif, bmp, apng, svg';
        for (const [argv, said, env] of [
            [[], 'Name the artifact: markest images <artifact>'],
            [[paste.id, paste.id], 'Too many arguments: markest images <artifact>'],
            [[paste.id, '--add', 'notes.txt'], 'notes.txt is not an image the site keeps (' + kept + ')'],
            [[paste.id, '--add', 'notes.constructor'], 'notes.constructor is not an image the site keeps (' + kept + ')'],
            [[paste.id, '--add', 'notes.__proto__'], 'notes.__proto__ is not an image the site keeps (' + kept + ')'],
            [[paste.id, '--remove', 'img1'], '"img1" is not an image id: markest images <artifact> lists them'],
            [[paste.id, '--remove', 'X' + ID], '"X' + ID + '" is not an image id: markest images <artifact> lists them'],
            [[paste.id, '--remove', ID + 'X'], '"' + ID + 'X" is not an image id: markest images <artifact> lists them'],
            [[paste.id], 'Sign in with markest login, or set MARKEST_API_KEY to an API key from your account settings.', {}],
        ]) {
            const out = await markest(['images', ...argv], env ? { env } : {});
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: ' + said + '\nRun markest --help for the commands.\n');
        }
        assert.deepEqual(site.requests, []);
    });
});

test('ids to remove are taken in either case and sent in upper case, each removal said on its own line', async () => {
    await withSite(async (site, markest) => {
        const ids = ['ABCDEFGHJKMNPQRSTVWXYZ0123', 'ZYXWVTSRQPNMKJHGFEDCBA9876'];
        const paste = site.addPaste({ title: 'T', images: ids.map((id) => ({ id, source: 'upload', name: id + '.png', content_type: 'image/png', size: 1, path: '/img/x/' + id })) });
        const out = await markest(['images', paste.id, '--remove', ids[0].toLowerCase(), '--remove', ids[1].toLowerCase()]);
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, 'Removed ' + ids[0] + '\nRemoved ' + ids[1] + '\n');
        assert.deepEqual(site.requests.map((one) => [one.method, one.path]), ids.map((id) => ['DELETE', '/api/v1/pastes/' + paste.id + '/images/' + id]));
        assert.deepEqual(site.pastes.get(paste.id).images, []);
    });
});

test('a file that cannot be read is said exactly: alone when it comes first, else with every image added before it', async () => {
    await withSite(async (site, markest) => {
        const paste = site.addPaste({ title: 'T' });
        const folder = await makeFolder({ 'a.png': Buffer.from('A'), 'b.png': Buffer.from('B') });
        const gone = join(folder, 'gone.png');
        const first = await markest(['images', paste.id, '--add', gone, '--add', join(folder, 'a.png')]);
        assert.equal(first.code, 1);
        assert.equal(first.stdout, '');
        assert.equal(first.stderr, 'markest: ' + gone + ' could not be read.\n');
        assert.deepEqual(site.requests, [], 'nothing sent');

        const later = await markest(['images', paste.id, '--add', join(folder, 'a.png'), '--add', join(folder, 'b.png'), '--add', gone]);
        assert.equal(later.code, 1);
        assert.equal(later.stderr, 'markest: ' + gone + ' could not be read; added before it: a.png, b.png.\n');
        assert.deepEqual(site.pastes.get(paste.id).images.map((one) => one.name), ['a.png', 'b.png']);
    });
});

test('a list the site leaves out is none, and listing or removing is tried again after a 502', async () => {
    const IMAGE = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
    const badGateway = (req, res) => {
        res.writeHead(502);
        res.end();
    };
    const holding = (site) => {
        const paste = site.addPaste({ title: 'T' });
        paste.images.push({ id: IMAGE, source: 'upload', name: 'a.png', content_type: 'image/png', size: 1, path: '/img/' + paste.id + '/' + IMAGE });
        return paste;
    };
    await Promise.all([
        withSite(async (site, markest) => {
            const paste = holding(site);
            site.answerOnce(() => true, (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
            });
            assert.equal((await markest(['images', paste.id])).stdout, 'ID  FROM  TYPE  BYTES  ADDRESS  NAME\n');
            site.answerOnce(() => true, badGateway);
            const listed = await markest(['images', paste.id, '--json']);
            assert.equal(listed.code, 0, listed.stderr);
            assert.deepEqual(JSON.parse(listed.stdout).images.map((one) => one.id), [IMAGE]);
            assert.equal(site.requests.length, 3, 'the empty list, then the 502 and its second try');
        }),
        withSite(async (site, markest) => {
            const paste = holding(site);
            site.answerOnce(() => true, badGateway);
            const removed = await markest(['images', paste.id, '--remove', IMAGE]);
            assert.equal(removed.code, 0, removed.stderr);
            assert.equal(removed.stdout, 'Removed ' + IMAGE + '\n');
            assert.deepEqual(site.requests.map((one) => one.method), ['DELETE', 'DELETE']);
            assert.deepEqual(paste.images, []);
        }),
    ]);
});
