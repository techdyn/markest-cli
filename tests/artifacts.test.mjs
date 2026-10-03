/**
 * `markest list`, `markest show` and `markest delete` against the fake site
 * (cli/commands/artifacts): filters and pages, one artifact without its text,
 * and nothing deleted without --yes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, run } from './support/cli-harness.mjs';

async function withSite(options, body) {
    const site = await startFakeMarkest(options);
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

test('list shows each artifact on a line, encrypted ones said so, and passes the filters on', async () => {
    await withSite({}, async (site, markest) => {
        const plan = site.addPaste({ title: 'Plan', visibility: 'private', sealed: true, folder: 'work', documents: [{ path: 'a.md', content: 'x' }] });
        const notes = site.addPaste({ title: 'Notes', documents: [{ path: 'a.md', content: 'x' }, { path: 'b.md', content: 'y' }] });
        const all = await markest(['list']);
        assert.equal(all.code, 0, all.stderr);
        const [head, ...rows] = all.stdout.trimEnd().split('\n');
        assert.match(head, /^ID +VISIBILITY +DOCS +UPDATED \(UTC\) +TITLE$/);
        assert.equal(rows.length, 2);
        assert.match(all.stdout, /private, encrypted +1 +2026-10-01 10:30 +Plan/);
        assert.match(all.stdout, /unlisted +2 +2026-10-01 10:30 +Notes/);
        assert.equal(all.stdout, [
            'ID' + ' '.repeat(26) + 'VISIBILITY' + ' '.repeat(10) + 'DOCS  UPDATED (UTC)' + ' '.repeat(5) + 'TITLE',
            plan.id + '  private, encrypted  1     2026-10-01 10:30  Plan',
            notes.id + '  unlisted' + ' '.repeat(12) + '2     2026-10-01 10:30  Notes',
        ].join('\n') + '\n');
        assert.equal(all.stderr, '', 'every one shown, so nothing more to say');

        await markest(['list', '--search', 'pla', '--folder', 'work', '--visibility', 'private', '--limit', '5', '--offset', '0']);
        assert.deepEqual(site.requests.at(-1).query, { offset: '0', query: 'pla', folder: 'work', visibility: 'private', limit: '5' });
        const json = JSON.parse((await markest(['list', '--search', 'notes', '--json'])).stdout);
        assert.deepEqual(json.pastes.map((one) => one.title), ['Notes']);
        assert.equal(json.total, 1);
    });
});

test('list says when there is more, and --all reads every page', async () => {
    await withSite({}, async (site, markest) => {
        for (let i = 0; i < 5; i++) site.addPaste({ title: 'A' + i });
        const first = await markest(['list', '--limit', '2']);
        assert.equal(first.stdout.trimEnd().split('\n').length, 3);
        assert.match(first.stderr, /2 of 5 shown; --all for every one\./);
        assert.equal(first.stderr, '2 of 5 shown; --all for every one.\n');
        const every = await markest(['list', '--limit', '2', '--all', '--json']);
        assert.equal(JSON.parse(every.stdout).count, 5);
        assert.equal(site.requests.filter((one) => one.path === '/api/v1/pastes' && one.method === 'GET').length, 4, 'one, then three pages');
        assert.equal(every.stderr, '');
    });
});

test('list refuses what it cannot ask', async () => {
    for (const [argv, said] of [[['list', 'x'], /takes no artifact/], [['list', '--limit', '0'], /--limit/], [['list', '--limit', 'ten'], /--limit/], [['list', '--offset', '-1'], /--offset/], [['list', '--visibility', 'secret'], /--visibility/]]) {
        const out = await run(argv);
        assert.equal(out.code, 2);
        assert.match(out.stderr, said);
    }
});

test('show gives the settings and documents, not their text, marking the one it opens on', async () => {
    await withSite({}, async (site, markest) => {
        const paste = site.addPaste({ title: 'Plan', folder: 'work', defaultPath: 'b.md', documents: [{ path: 'a.md', content: 'secret words' }, { path: 'b.md', content: 'more', title: 'Bee' }] });
        const out = await markest(['show', 'https://marke.st/p/' + paste.id]);
        assert.equal(out.code, 0, out.stderr);
        assert.match(out.stdout, /^Plan\n {2}http:\/\/127\.0\.0\.1:\d+\/p\/[0-9A-Z]{26}\n {2}unlisted, in work\n {2}created 2026-10-01 09:00, updated 2026-10-01 10:30\n/);
        assert.match(out.stdout, /\* +b\.md +markdown +4 +Bee/);
        assert.ok(!out.stdout.includes('secret words'));
        const json = JSON.parse((await markest(['show', paste.id, '--json'])).stdout);
        assert.equal(json.documents[0].content, undefined, 'no text, even as JSON');
        assert.equal(json.documents[0].bytes, 12);
        assert.equal(json.url, site.url + '/p/' + paste.id);
        const missing = await markest(['show', '01ARZ3NDEKTSV4RRFFQ69G5FAV']);
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /Paste not found/);
    });
});

test('show of an artifact with no title says so', async () => {
    await withSite({}, async (site, markest) => {
        const paste = site.addPaste({ title: null, expiresAt: '2026-10-08T10:00:00+00:00', documents: [{ path: 'a.md', content: '' }] });
        const out = await markest(['show', paste.id]);
        assert.match(out.stdout, /^\(untitled\)\n/);
        assert.match(out.stdout, /expires 2026-10-08 10:00/);
    });
});

test('delete needs --yes, deletes each, and says what went before a refusal', async () => {
    await withSite({}, async (site, markest) => {
        const one = site.addPaste({ title: 'One' });
        const two = site.addPaste({ title: 'Two' });
        const asked = await markest(['delete', one.id, two.id]);
        assert.equal(asked.code, 2);
        assert.match(asked.stderr, /cannot be undone\. Add --yes to delete these 2/);
        assert.match((await markest(['delete', one.id])).stderr, /Add --yes to delete it\./);
        assert.equal(site.pastes.size, 2, 'nothing deleted');

        const done = await markest(['delete', one.id, '--yes']);
        assert.equal(done.code, 0, done.stderr);
        assert.equal(done.stdout, 'Deleted ' + one.id + '\n');
        assert.ok(!site.pastes.has(one.id));

        const third = site.addPaste({ title: 'Three' });
        const partly = await markest(['delete', third.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--yes']);
        assert.equal(partly.code, 1);
        assert.match(partly.stderr, /Paste not found/);
        assert.match(partly.stderr, new RegExp('Deleted before that: ' + third.id));
        assert.equal(JSON.parse((await markest(['delete', two.id, '--yes', '--json'])).stdout).deleted[0], two.id);
    });
});

const MISSING = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const usageLine = (said) => 'markest: ' + said + '\nRun markest --help for the commands.\n';
const answerWith = (body) => (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};
const badGateway = (req, res) => {
    res.writeHead(502);
    res.end();
};

test('list takes --limit and --offset as whole numbers alone, sends no filter it was not given, and says exactly what it refuses', async () => {
    await withSite({}, async (site, markest) => {
        site.addPaste({ title: 'One' });
        for (const [argv, query] of [
            [[], { offset: '0' }],
            [['--limit', '25'], { offset: '0', limit: '25' }],
            [['--offset', '3'], { offset: '3' }],
            [['--limit', '10', '--offset', '12'], { offset: '12', limit: '10' }],
        ]) {
            const out = await markest(['list', ...argv]);
            assert.equal(out.code, 0, out.stderr);
            assert.deepEqual(site.requests.at(-1).query, query, argv.join(' '));
        }
        const asked = site.requests.length;
        for (const [argv, said] of [
            [['--limit=-1'], '--limit is a number from 1'],
            [['--limit', '+5'], '--limit is a number from 1'],
            [['--limit', '1e3'], '--limit is a number from 1'],
            [['--limit', '00'], '--limit is a number from 1'],
            [['--offset=-1'], '--offset is a number'],
            [['--offset', 'ten'], '--offset is a number'],
            [['--offset', '1e3'], '--offset is a number'],
        ]) {
            const out = await markest(['list', ...argv]);
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, usageLine(said));
        }
        assert.equal(site.requests.length, asked, 'nothing asked');
    });
});

test('list --all stops where the site names no next page, and after 50 pages; a list the site leaves out is none', async () => {
    await withSite({}, async (site, markest) => {
        site.answerOnce(() => true, answerWith({ total: 0, has_more: false }));
        assert.deepEqual(JSON.parse((await markest(['list', '--json'])).stdout), { pastes: [], total: 0, count: 0, has_more: false });

        site.answerOnce(() => true, answerWith({ pastes: [{ id: 'A' }], total: 3, has_more: true }));
        assert.equal(JSON.parse((await markest(['list', '--all', '--json'])).stdout).count, 1);
        assert.equal(site.requests.length, 2, 'no next page asked for when the site names none');

        site.answerOnce(() => true, answerWith({ pastes: [{ id: 'A' }], total: 1, has_more: true, next_offset: 1 }));
        site.answerOnce(() => true, answerWith({ has_more: false }));
        assert.deepEqual(JSON.parse((await markest(['list', '--all', '--json'])).stdout), { pastes: [{ id: 'A' }], total: 1, count: 1, has_more: false });
        assert.equal(site.requests.length, 4);

        for (let i = 0; i < 60; i++) site.addPaste({ title: 'P' + i });
        const capped = JSON.parse((await markest(['list', '--limit', '1', '--all', '--json'])).stdout);
        assert.deepEqual([capped.count, capped.total, capped.has_more], [50, 60, true]);
        assert.equal(site.requests.length, 4 + 50, 'fifty pages at most');
    });
});

test('show draws the settings, a blank line, then the documents in columns, marking only the one it opens on', async () => {
    await withSite({}, async (site, markest) => {
        const plan = site.addPaste({ title: 'Plan', folder: 'work', defaultPath: 'b.md', documents: [{ path: 'a.md', content: 'secret words' }, { path: 'b.md', content: 'more', title: 'Bee' }] });
        assert.equal((await markest(['show', plan.id])).stdout, [
            'Plan',
            '  ' + site.url + '/p/' + plan.id,
            '  unlisted, in work',
            '  created 2026-10-01 09:00, updated 2026-10-01 10:30',
            '',
            '   PATH  TYPE      BYTES  TITLE',
            '   a.md  markdown  12     a.md',
            '*  b.md  markdown  4      Bee',
        ].join('\n') + '\n');

        const loose = site.addPaste({ title: null, expiresAt: '2026-10-08T10:00:00+00:00', documents: [{ path: 'a.md', content: '' }] });
        assert.equal((await markest(['show', loose.id])).stdout, [
            '(untitled)',
            '  ' + site.url + '/p/' + loose.id,
            '  unlisted',
            '  created 2026-10-01 09:00, updated 2026-10-01 10:30, expires 2026-10-08 10:00',
            '',
            '  PATH  TYPE      BYTES  TITLE',
            '  a.md  markdown  0      a.md',
        ].join('\n') + '\n');

        site.answerOnce(() => true, answerWith({ id: loose.id, title: 'Bare', visibility: 'private' }));
        assert.deepEqual(JSON.parse((await markest(['show', loose.id, '--json'])).stdout),
            { id: loose.id, title: 'Bare', visibility: 'private', url: site.url + '/p/' + loose.id, documents: [] }, 'documents the site leaves out are none');
    });
});

test('show and delete say exactly what they need, and list, show and delete ask nothing without a key', async () => {
    await withSite({}, async (site, markest) => {
        const paste = site.addPaste({ title: 'Kept' });
        const show = 'markest show <artifact>';
        const remove = 'markest delete <artifact>... --yes';
        const keyless = 'Sign in with markest login, or set MARKEST_API_KEY to an API key from your account settings.';
        for (const [argv, said, env] of [
            [['show'], 'Name the artifact: ' + show],
            [['show', paste.id, paste.id], 'Too many arguments: ' + show],
            [['delete'], 'Name the artifact: ' + remove],
            [['delete', '--yes'], 'Name the artifact: ' + remove],
            [['list'], keyless, {}],
            [['show', paste.id], keyless, {}],
            [['delete', paste.id, '--yes'], keyless, {}],
        ]) {
            const out = await markest(argv, env ? { env } : {});
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, usageLine(said));
        }
        assert.deepEqual(site.requests, []);
        assert.ok(site.pastes.has(paste.id));
    });
});

test('delete says each it deleted on its own line, and before a refusal exactly which went: on stderr, or with --json as a line of its own after the error', async () => {
    await withSite({}, async (site, markest) => {
        const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map((title) => site.addPaste({ title }));
        const both = await markest(['delete', a.id, b.id, '--yes']);
        assert.deepEqual([both.code, both.stdout, both.stderr], [0, 'Deleted ' + a.id + '\nDeleted ' + b.id + '\n', '']);

        const first = await markest(['delete', MISSING, c.id, '--yes']);
        assert.deepEqual([first.code, first.stdout, first.stderr], [1, '', 'markest: Paste not found.\n'], 'nothing went before it');
        assert.ok(site.pastes.has(c.id), 'nor after it');

        const later = await markest(['delete', c.id, d.id, MISSING, '--yes']);
        assert.deepEqual([later.code, later.stdout, later.stderr], [1, '', 'markest: Paste not found.\nDeleted before that: ' + c.id + ', ' + d.id + '\n']);

        const asJson = await markest(['delete', e.id, MISSING, '--yes', '--json']);
        assert.deepEqual([asJson.code, asJson.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)), asJson.stderr],
            [1, [{ error: 'Paste not found.', status: 404 }, { deleted: [e.id] }], 'markest: Paste not found.\n'], 'a script told what is gone though the run failed');
        assert.ok(!site.pastes.has(e.id));
        const noneJson = await markest(['delete', MISSING, '--yes', '--json']);
        assert.equal(noneJson.stdout, '{"error":"Paste not found.","status":404}\n', 'nothing gone, nothing more said');
    });
});

test('listing, showing and deleting are each tried again after a 502', async () => {
    await Promise.all([
        withSite({}, async (site, markest) => {
            for (let i = 0; i < 3; i++) site.addPaste({ title: 'A' + i });
            site.answerOnce((one) => one.query.offset === '0', badGateway);
            site.answerOnce((one) => one.query.offset === '2', badGateway);
            const every = await markest(['list', '--limit', '2', '--all', '--json']);
            assert.equal(every.code, 0, every.stderr);
            assert.equal(JSON.parse(every.stdout).count, 3);
            assert.deepEqual(site.requests.map((one) => one.query.offset), ['0', '0', '2', '2'], 'the first page and the next, each twice');
        }),
        withSite({}, async (site, markest) => {
            const paste = site.addPaste({ title: 'Shown' });
            site.answerOnce(() => true, badGateway);
            const out = await markest(['show', paste.id, '--json']);
            assert.equal(out.code, 0, out.stderr);
            assert.equal(JSON.parse(out.stdout).title, 'Shown');
            assert.equal(site.requests.length, 2);
        }),
        withSite({}, async (site, markest) => {
            const paste = site.addPaste({ title: 'Gone' });
            site.answerOnce(() => true, badGateway);
            const out = await markest(['delete', paste.id, '--yes']);
            assert.equal(out.code, 0, out.stderr);
            assert.equal(out.stdout, 'Deleted ' + paste.id + '\n');
            assert.deepEqual(site.requests.map((one) => one.method), ['DELETE', 'DELETE']);
            assert.ok(!site.pastes.has(paste.id));
        }),
    ]);
});
