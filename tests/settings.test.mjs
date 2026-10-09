/**
 * `markest set` and `markest visibility` against the fake site
 * (cli/commands/settings): only what is named changes, a password comes from
 * stdin, and publishing waits for its confirmation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, run } from './support/cli-harness.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

async function withSite(options, body) {
    const site = await startFakeMarkest(options);
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

test('set sends only what is named, in the API\'s words', async () => {
    await withSite({}, async (site, markest) => {
        const paste = site.addPaste({ title: 'Old', documents: [{ path: 'a.md', content: '' }, { path: 'b.md', content: '' }] });
        const out = await markest(['set', paste.id, '--title', 'New', '--folder', 'work', '--tags', 'a,b', '--default', 'b.md', '--expires', '7d',
            '--burn', '--versions', 'on', '--proxy-images', 'off']);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.requests.at(-1).json, {
            title: 'New', folder: 'work', tags: 'a,b', default_path: 'b.md', expires_in: 604800, burn_after_reading: true, track_versions: true, proxy_images: false,
        });
        assert.match(out.stdout, /^Changed New\n {2}unlisted, in work, opens on b\.md\n {2}expires 2026-10-08 10:00, burns after reading, keeps versions\n$/);

        await markest(['set', paste.id, '--no-burn', '--expires', 'never', '--folder', '']);
        assert.deepEqual(site.requests.at(-1).json, { folder: '', expires_in: 0, burn_after_reading: false });
        assert.match((await markest(['set', paste.id, '--title', 'X'])).stdout, /never expires/);
        assert.equal(JSON.parse((await markest(['set', paste.id, '--title', 'Y', '--json'])).stdout).title, 'Y');
        const plain = site.addPaste({ title: 'Plain' });
        assert.equal((await markest(['set', plain.id, '--title', 'Plainer'])).stdout, 'Changed Plainer\n  unlisted, opens on (its first document)\n  never expires\n', 'nothing said of what it does not do');
    });
});

test('what is asked wrongly is said in its own words, and nothing is asked of the site', async () => {
    await withSite({}, async (site, markest) => {
        for (const [argv, said] of [
            [['set'], 'Name the artifact: markest set <artifact> [options]'],
            [['visibility', ID], 'Say which first: markest visibility <public|unlisted|private> <artifact>...'],
            [['visibility', 'public'], 'Name the artifact: markest visibility <public|unlisted|private> <artifact>...'],
        ]) {
            const out = await markest(argv);
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: ' + said + '\nRun markest --help for the commands.\n', argv.join(' '));
        }
        for (const argv of [['set', ID, '--title', 'T'], ['visibility', 'private', ID]]) {
            const out = await markest(argv, { env: {} });
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: Sign in with markest login, or set MARKEST_API_KEY to an API key from your account settings.\nRun markest --help for the commands.\n', argv.join(' '));
        }
        assert.equal(site.requests.length, 0);
    });
});

test('a change is asked again when the connection drops, since asking twice changes nothing more', async () => {
    await withSite({}, async (site, markest) => {
        const one = site.addPaste({ title: 'One' });
        const two = site.addPaste({ title: 'Two' });
        const drop = (req) => { req.socket.destroy(); };
        site.answerOnce((record) => record.method === 'PATCH', drop);
        site.answerOnce((record) => record.path === '/api/v1/pastes/visibility', drop);
        const [set, shown] = await Promise.all([markest(['set', one.id, '--title', 'Uno']), markest(['visibility', 'private', two.id])]);
        assert.equal(set.code, 0, set.stderr);
        assert.equal(shown.code, 0, shown.stderr);
        assert.equal(site.pastes.get(one.id).title, 'Uno');
        assert.equal(shown.stdout, 'Made 1 private.\n');
        assert.equal(site.writes().length, 4, 'each sent twice');
    });
});

test('a password is read from stdin, never a flag, and can be taken off', async () => {
    await withSite({}, async (site, markest) => {
        const paste = site.addPaste({ title: 'P' });
        const out = await markest(['set', paste.id, '--password-stdin'], { stdin: 'correct horse\n' });
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.requests.at(-1).json, { password: 'correct horse' }, 'one trailing newline dropped');
        assert.match(out.stdout, /password protected/);
        await markest(['set', paste.id, '--password-stdin'], { stdin: 'two\nlines\n' });
        assert.deepEqual(site.requests.at(-1).json, { password: 'two' + '\nlines' }, 'only the newline at the end dropped');
        const empty = await markest(['set', paste.id, '--password-stdin'], { stdin: '\n' });
        assert.equal(empty.code, 2);
        assert.match(empty.stderr, /no password arrived/);
        await markest(['set', paste.id, '--no-password']);
        assert.deepEqual(site.requests.at(-1).json, { password: null });
        assert.match((await run(['set', paste.id, '--password', 'x'])).stderr, /--password/, 'there is no --password flag');
    });
});

test('set refuses what it cannot ask, and says what the site refused', async () => {
    for (const [argv, said] of [
        [['set', ID], /Nothing to change/], [['set'], /Name the artifact/], [['set', ID, '--expires', 'soon'], /--expires/],
        [['set', ID, '--versions', 'maybe'], /--versions is on or off/], [['set', ID, '--burn', '--no-burn'], /opposite/],
        [['set', ID, '--password-stdin', '--no-password'], /opposite/], [['set', ID, '--proxy-images', 'yes'], /--proxy-images is on or off/],
    ]) {
        const out = await run(argv);
        assert.equal(out.code, 2, argv.join(' '));
        assert.match(out.stderr, said);
    }
    await withSite({}, async (site, markest) => {
        const sealed = site.addPaste({ title: 'S', sealed: true, visibility: 'private' });
        const out = await markest(['set', sealed.id, '--burn']);
        assert.equal(out.code, 1);
        assert.match(out.stderr, /Burn-after-reading is not available/);
    });
});

test('visibility goes through the one door: restricting applies, publishing may wait for confirmation', async () => {
    await withSite({ requireApproval: true }, async (site, markest) => {
        const one = site.addPaste({ title: 'One' });
        const two = site.addPaste({ title: 'Two' });
        const restricted = await markest(['visibility', 'private', one.id, two.id]);
        assert.equal(restricted.code, 0, restricted.stderr);
        assert.equal(restricted.stdout, 'Made 2 private.\n');
        assert.deepEqual(site.requests.at(-1).json, { paste_ids: [one.id, two.id], visibility: 'private' });
        assert.equal((await markest(['visibility', 'private', one.id])).stdout, 'Nothing to change: already private.\n');
        site.answerOnce((record) => record.path === '/api/v1/pastes/visibility', (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'applied', visibility: 'private' }));
        });
        assert.equal((await markest(['visibility', 'private', one.id])).stdout, 'Nothing to change: already private.\n', 'an answer with no list changed none');

        const waiting = await markest(['visibility', 'public', one.id]);
        assert.equal(waiting.code, 3);
        assert.equal(waiting.stdout, '');
        assert.match(waiting.stderr, /Making it public needs your confirmation: open http:\/\/127\.0\.0\.1:\d+\/app\/approve\/2\nNothing is public until you approve it\./);
        assert.equal(site.pastes.get(one.id).visibility, 'private');
        const json = await markest(['visibility', 'public', one.id, two.id, '--json']);
        assert.equal(json.code, 3);
        assert.equal(JSON.parse(json.stdout).status, 'approval_required');
        assert.match(json.stderr, /Making these public/);
    });
    for (const [argv, said] of [[['visibility', ID], /Say which first/], [['visibility', 'secret', ID], /Say which first/], [['visibility', 'public'], /Name the artifact/]]) {
        const out = await run(argv);
        assert.equal(out.code, 2);
        assert.match(out.stderr, said);
    }
});
