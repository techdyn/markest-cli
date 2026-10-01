/**
 * `markest versions`, `markest diff` and `markest restore` against the fake
 * site (cli/commands/history): the history over REST, a diff and a restore over
 * the agent tools, each asked in the tools' words.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, run } from './support/cli-harness.mjs';
import { changesIn } from '../src/commands/history.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

async function withSite(options, body) {
    const site = await startFakeMarkest(options);
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

const VERSIONS = [
    { number: 2, source: 'api', created_at: '2026-10-01T11:00:00+00:00', title: 'Second', document_count: 2, changes: { title: null, default_document: null, added: ['b.md'], removed: [], modified: ['a.md'], retitled: [], renamed: [], reordered: false },
        default_path: 'a.md', documents: [{ path: 'a.md', title: null, content_type: 'markdown', content: 'two' }, { path: 'b.md', title: 'Bee', content_type: 'markdown', content: 'bee' }] },
    { number: 1, source: 'created', created_at: '2026-10-01T10:00:00+00:00', title: 'First', document_count: 1, changes: null, default_path: 'a.md', documents: [{ path: 'a.md', title: null, content_type: 'markdown', content: 'one' }] },
];

test('what a version changed, in a few words', () => {
    // As the site records them (VersionChanges::between): pairs for the title and opening document, lists for documents
    assert.equal(changesIn({ title: ['Old', 'New'], default_document: [null, 'a.md'], added: ['a', 'b'], removed: ['z'], modified: ['c'], retitled: ['d'], renamed: [['e', 'f']], reordered: true }),
        'title, opening document, 2 added, 1 removed, 1 edited, 1 retitled, 1 renamed, reordered');
    assert.equal(changesIn({ title: null, added: [], reordered: false }), '');
    assert.equal(changesIn(null), '');
    assert.equal(changesIn('x'), '');
});

test('versions lists the history, shows one, and a document as it kept it', async () => {
    await withSite({}, async (site, markest) => {
        const paste = site.addPaste({ title: 'T', trackVersions: true, versions: VERSIONS });
        const list = await markest(['versions', paste.id]);
        assert.equal(list.code, 0, list.stderr);
        assert.match(list.stdout, /^VERSION +SAVED \(UTC\) +FROM +DOCS +CHANGES +TITLE\n2 +2026-10-01 11:00 +api +2 +1 added, 1 edited +Second\n1 +2026-10-01 10:00 +created +1 +First\n$/);
        const one = await markest(['versions', paste.id, '2']);
        assert.match(one.stdout, /^Version 2 \(2026-10-01 11:00, api\): Second\n/);
        assert.match(one.stdout, /\* +a\.md +markdown/);
        assert.match(one.stdout, /\n +b\.md +markdown +Bee/);
        assert.equal((await markest(['versions', paste.id, '1', '--path', 'a.md'])).stdout, 'one');
        assert.deepEqual(site.requests.at(-1).query, { path: 'a.md' });
        assert.equal(JSON.parse((await markest(['versions', paste.id, '--json'])).stdout).versions.length, 2);
        const none = site.addPaste({ title: 'N' });
        assert.match((await markest(['versions', none.id])).stdout, /It keeps no versions\. markest set [0-9A-Z]{26} --versions on keeps them from now\./);
        const gone = await markest(['versions', paste.id, '9']);
        assert.equal(gone.code, 1);
        assert.match(gone.stderr, /No version 9/);
    });
    for (const [argv, said] of [[['versions', ID, 'two'], /its number/], [['versions', ID, '0'], /its number/], [['versions', ID, '--path', 'a.md'], /name the version/], [['versions', ID, '1', '2'], /markest versions/]]) {
        const out = await run(argv);
        assert.equal(out.code, 2, argv.join(' '));
        assert.match(out.stderr, said);
    }
});

/** The next request to `path` answered with `body`, as the site would answer it. */
function answerWith(site, path, body) {
    site.answerOnce((one) => one.path === path, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });
}

test('versions says exactly what a version holds, and a history kept before it was turned off', async () => {
    await withSite({}, async (site, markest) => {
        const paste = site.addPaste({ title: 'T', trackVersions: true, versions: VERSIONS });
        const one = await markest(['versions', paste.id, '2']);
        assert.equal(one.stdout, 'Version 2 (2026-10-01 11:00, api): Second\n   PATH  TYPE      TITLE\n*  a.md  markdown\n   b.md  markdown  Bee\n');
        assert.deepEqual(site.requests.at(-1).query, {}, 'no path asked when none is named');
        const missing = await markest(['versions', paste.id, '1', '--path', 'gone.md']);
        assert.equal(missing.code, 0, missing.stderr);
        assert.equal(missing.stdout, '', 'a document the version did not keep reads as nothing');

        const bare = site.addPaste({ title: 'B', trackVersions: true, versions: [{ number: 3, source: 'api', created_at: '2026-10-01T12:00:00+00:00', title: null, document_count: 0, changes: null }] });
        assert.equal((await markest(['versions', bare.id, '3'])).stdout, 'Version 3 (2026-10-01 12:00, api): \n  PATH  TYPE  TITLE\n', 'no title and no documents');

        const header = 'VERSION  SAVED (UTC)  FROM  DOCS  CHANGES  TITLE\n';
        const empty = site.addPaste({ title: 'E', trackVersions: true, versions: [] });
        assert.equal((await markest(['versions', empty.id])).stdout, header, 'keeping versions, with none saved yet');
        const stopped = site.addPaste({ title: 'S', trackVersions: false, versions: VERSIONS });
        assert.match((await markest(['versions', stopped.id])).stdout, /^VERSION .*\n2 .*Second\n1 .*First\n$/, 'versions kept before it was turned off are still listed');

        const base = '/api/v1/pastes/' + paste.id + '/versions';
        answerWith(site, base, { paste_id: paste.id, track_versions: false });
        assert.equal((await markest(['versions', paste.id])).stdout, 'It keeps no versions. markest set ' + paste.id + ' --versions on keeps them from now.\n');
        answerWith(site, base, { paste_id: paste.id, track_versions: true });
        assert.equal((await markest(['versions', paste.id])).stdout, header, 'an answer with no list is an empty one');
    });
});

test('what is asked wrongly is said in its own words, and nothing is asked of the site', async () => {
    await withSite({}, async (site, markest) => {
        for (const [argv, said] of [
            [['versions'], 'Name the artifact: markest versions <artifact> [<number>]'],
            [['versions', ID, 'x1'], 'A version is its number: 1, 2, 3 ...'],
            [['versions', ID, '1x'], 'A version is its number: 1, 2, 3 ...'],
            [['versions', ID, '1234567890'], 'A version is its number: 1, 2, 3 ...'],
            [['diff'], 'Name the artifact: markest diff <artifact> <from> [<to>], or markest diff <artifact> --changes <n>'],
            [['diff', 'nonsense', '1'], '"nonsense" is not an artifact\'s id or address'],
            [['diff', ID, '1', 'x'], 'A version is its number, or current'],
            [['diff', ID, '1', '--context', 'x5'], '--context is a number of lines'],
            [['diff', ID, '1', '--context', '5x'], '--context is a number of lines'],
            [['diff', ID, '1', '--context', '1000'], '--context is a number of lines'],
            [['restore', ID], 'markest restore <artifact> <number> [--path <path>]'],
            [['restore', 'nonsense', '3'], '"nonsense" is not an artifact\'s id or address'],
        ]) {
            const out = await markest(argv);
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: ' + said + '\nRun markest --help for the commands.\n', argv.join(' '));
        }
        for (const argv of [['versions', ID], ['diff', ID, '1'], ['restore', ID, '3']]) {
            const out = await markest(argv, { env: {} });
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: Set MARKEST_API_KEY to an API key from your account settings.\nRun markest --help for the commands.\n', argv.join(' '));
        }
        assert.equal(site.requests.length, 0);
    });
});

test('a version is up to nine digits, and the lines of context up to three', async () => {
    const tools = { markest_diff_versions: (args) => ({ from: args.from, to: args.to ?? 'current' }) };
    await withSite({ tools }, async (site, markest) => {
        for (const [argv, args] of [
            [['12', '999999999'], { paste_id: ID, from: 12, to: 999999999 }],
            [['1', '--context', '10'], { paste_id: ID, from: 1, context: 10 }],
            [['1', '--context', '999'], { paste_id: ID, from: 1, context: 999 }],
            [['1', '--context', '0'], { paste_id: ID, from: 1, context: 0 }],
        ]) {
            const out = await markest(['diff', ID, ...argv]);
            assert.equal(out.code, 0, out.stderr);
            assert.deepEqual(site.agent.calls.at(-1).args, args, argv.join(' '));
        }
        assert.equal((await markest(['diff', ID, '1'])).stdout, 'Version 1 to current\nNo document changed.\n', 'an answer with no files and no diff');
    });
});

test('every read is asked again when the connection drops', async () => {
    const tools = { markest_diff_versions: () => ({ from: 1, to: 2, files: [], diff: '' }) };
    await withSite({ tools }, async (site, markest) => {
        const paste = site.addPaste({ title: 'T', trackVersions: true, versions: VERSIONS });
        const drop = (req) => { req.socket.destroy(); };
        const base = '/api/v1/pastes/' + paste.id + '/versions';
        for (const path of [base, base + '/2', '/mcp']) site.answerOnce((one) => one.path === path, drop);
        const [list, one, diff] = await Promise.all([markest(['versions', paste.id]), markest(['versions', paste.id, '2']), markest(['diff', paste.id, '1', '2'])]);
        for (const out of [list, one, diff]) assert.equal(out.code, 0, out.stderr);
        assert.match(list.stdout, /^VERSION /);
        assert.match(one.stdout, /^Version 2 /);
        assert.equal(diff.stdout, 'Version 1 to 2\nNo document changed.\n');
    });
});

test('diff asks the agent tool in its words and prints the diff', async () => {
    const tools = {
        markest_diff_versions: (args) => ({ paste_id: args.paste_id, from: args.from ?? 1, to: args.to ?? 2, files: [{ path: 'a.md', status: 'modified', added: 1, removed: 1 }, { path: 'c.md', old_path: 'b.md', status: 'renamed', added: 0, removed: 0 }], diff: '--- a/a.md\n+++ b/a.md\n-one\n+two' }),
    };
    await withSite({ tools }, async (site, markest) => {
        const out = await markest(['diff', ID, '1', 'current', '--path', 'a.md', '--context', '5', '--stat']);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.agent.calls.at(-1), { name: 'markest_diff_versions', args: { paste_id: ID, from: 1, to: 'current', path: 'a.md', stat_only: true, context: 5 } });
        assert.equal(out.stdout, 'Version 1 to current\nmodified a.md  +1 -1\nrenamed c.md (was b.md)  +0 -0\n\n--- a/a.md\n+++ b/a.md\n-one\n+two\n');
        await markest(['diff', ID, '--changes', '4']);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, to: 4 }, 'what one version changed is to alone');
        await markest(['diff', ID, '2']);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, from: 2 }, 'from alone, to the artifact as it is');
    });
    await withSite({ tools: { markest_diff_versions: () => ({ from: 1, to: 2, files: [], diff: '' }) } }, async (site, markest) => {
        assert.equal((await markest(['diff', ID, '1', '2'])).stdout, 'Version 1 to 2\nNo document changed.\n');
    });
    for (const argv of [['diff', ID, 'x'], ['diff', ID, '1', '2', '3'], ['diff', ID, '1', '--context', 'lots'], ['diff'], ['diff', ID], ['diff', ID, '1', '--changes', '2'], ['diff', ID, '--changes', 'x']]) {
        assert.equal((await run(argv)).code, 2, argv.join(' '));
    }
    assert.match((await run(['diff', ID])).stderr, /Name the versions: markest diff <artifact> <from> \[<to>\], or markest diff <artifact> --changes <n>/);
});

test('restore brings back a version, or one document, through the agent tool', async () => {
    const tools = { markest_restore_version: (args) => ({ paste_id: args.paste_id, restored_from: args.number, path: args.path ?? null, version: 5, changes: null }) };
    await withSite({ tools }, async (site, markest) => {
        assert.equal((await markest(['restore', ID, '3'])).stdout, 'Restored version 3, saved as version 5.\n');
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, number: 3 });
        assert.equal((await markest(['restore', ID, '3', '--path', 'a.md'])).stdout, 'Restored a.md from version 3, saved as version 5.\n');
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, number: 3, path: 'a.md' });
    });
    await withSite({ tools: { markest_restore_version: (args) => ({ paste_id: args.paste_id, restored_from: args.number, path: null, version: null }) } }, async (site, markest) => {
        assert.equal((await markest(['restore', ID, '3'])).stdout, 'Restored version 3.\n', 'no new version named, none said');
    });
    await withSite({ agentAccess: false }, async (site, markest) => {
        const out = await markest(['restore', ID, '3']);
        assert.equal(out.code, 1);
        assert.match(out.stderr, /Agent access is not included in your plan\./);
    });
    for (const argv of [['restore', ID], ['restore', ID, 'x'], ['restore', ID, '1', '2']]) assert.equal((await run(argv)).code, 2, argv.join(' '));
});
