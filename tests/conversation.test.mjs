/**
 * `markest comments`, `markest reply` and `markest resolve` against the fake
 * site (cli/commands/conversation): threads read with the ids to answer by,
 * replies and resolutions sent in the agent tools' words.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, run } from './support/cli-harness.mjs';
import { renderThread } from '../src/commands/conversation.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const C1 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const C2 = '01BX5ZZKBKACTAV9WEVGEMMVS0';

const THREAD = {
    id: C1, paste_id: ID, paste_title: 'Plan', url: 'https://marke.st/p/' + ID, deleted: false, author: { name: 'Bea', is_owner: false, is_you: false },
    body: 'Is step two right?\nI think not.', created_at: '2026-10-01T09:00:00+00:00', resolved: false, awaiting_answer: true, replies_not_shown: 0,
    replies: [{ id: C2, deleted: false, author: { name: 'Ada', is_owner: true, is_you: true }, body: 'Fixed.', created_at: '2026-10-01T10:00:00+00:00' },
        { id: 'X', deleted: true, author: null, body: '', created_at: '2026-10-01T11:00:00+00:00' }],
};

async function withSite(tools, body) {
    const site = await startFakeMarkest({ tools });
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

test('a thread reads as a conversation, with the id to answer each comment by', () => {
    assert.equal(renderThread(THREAD), [
        'On "Plan" https://marke.st/p/' + ID + '  (awaiting an answer)',
        '  [' + C1 + '] Bea, 2026-10-01 09:00',
        '  > Is step two right?',
        '  > I think not.',
        '    [' + C2 + '] Ada (you), 2026-10-01 10:00',
        '    > Fixed.',
        '    [X] (deleted), 2026-10-01 11:00',
        '    > (deleted)',
    ].join('\n') + '\n');
    assert.match(renderThread({ ...THREAD, resolved: true, replies: [], replies_not_shown: 4, author: { name: 'Cy', is_owner: true } }), /\(resolved\)\n {2}\[\S+\] Cy \(owner\)[\s\S]*\(4 earlier replies not shown\)/);
});

test('a thread the site says little about reads with empty places, a nameless author as Someone, and a deleted one as deleted', () => {
    assert.equal(renderThread({ id: C1, author: {} }), 'On "" \n  [' + C1 + '] Someone, \n  > \n');
    assert.equal(renderThread({ id: C1, deleted: true, body: '', author: null, replies: [{ id: C2, author: { name: 'Ada', is_owner: true } }] }), [
        'On "" ',
        '  [' + C1 + '] (deleted), ',
        '  > (deleted)',
        '    [' + C2 + '] Ada (owner), ',
        '    > ',
    ].join('\n') + '\n');
});

const AGAIN = '\nRun markest --help for the commands.\n';

test('each command says it needs agent access, and none runs without a key', async () => {
    for (const name of ['comments', 'reply', 'resolve']) {
        assert.ok((await run(['help', name])).stdout.endsWith('\n\nUses the site\'s agent tools: your plan must include agent (MCP) access.\n'), name);
    }
    await withSite({}, async (site, markest) => {
        for (const argv of [['comments'], ['reply', C1, 'hi'], ['resolve', C1]]) {
            const out = await markest(argv, { env: {} });
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: Sign in with markest login, or set MARKEST_API_KEY to an API key from your account settings.' + AGAIN);
        }
        assert.equal(site.requests.length, 0);
    });
});

test('a wrong status, limit, artifact or comment id is refused in so many words, and nothing is sent', async () => {
    await withSite({ markest_list_comments: () => ({ threads: [] }) }, async (site, markest) => {
        for (const [argv, message] of [
            [['comments', '--status', 'open'], '--status is unresolved, resolved, all'],
            [['comments', '--limit', '5x'], '--limit is 1 to 50'],
            [['comments', '--limit', 'x5'], '--limit is 1 to 50'],
            [['comments', ID, ID], 'Too many arguments: markest comments [<artifact>]'],
            [['reply', C1], 'markest reply <comment-id> <text|->'],
            [['reply', 'nope', 'hi'], '"nope" is not a comment id: markest comments shows them'],
            [['reply', 'X' + C1, 'hi'], '"X' + C1 + '" is not a comment id: markest comments shows them'],
            [['reply', C1 + 'X', 'hi'], '"' + C1 + 'X" is not a comment id: markest comments shows them'],
            [['resolve', C1, 'nope'], '"nope" is not a comment id: markest comments shows them'],
        ]) {
            const out = await markest(argv);
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: ' + message + AGAIN, argv.join(' '));
        }
        assert.equal(site.agent.calls.length, 0);
    });
});

test('comments takes every status and a limit up to 50, and asks again after a lost connection, since it only reads', async () => {
    await withSite({ markest_list_comments: () => ({ threads: [] }) }, async (site, markest) => {
        for (const [argv, args] of [
            [['--status', 'unresolved'], { status: 'unresolved' }],
            [['--status', 'resolved'], { status: 'resolved' }],
            [['--limit', '50'], { limit: 50 }],
            [['--limit', '10'], { limit: 10 }],
        ]) {
            const out = await markest(['comments', ...argv]);
            assert.equal(out.code, 0, argv.join(' ') + ': ' + out.stderr);
            assert.deepEqual(site.agent.calls.at(-1).args, args);
        }
        site.answerOnce((one) => one.path === '/mcp', (req) => { req.socket.destroy(); });
        const again = await markest(['comments']);
        assert.equal(again.code, 0, again.stderr);
        assert.equal(again.stdout, 'No unresolved threads.\n');
    });
});

test('comments prints every thread a blank line apart, says nothing more when there is no next page, and reads an answer with no threads as none', async () => {
    const second = { ...THREAD, id: C2, paste_title: 'Other', replies: [] };
    let answer = { status: 'unresolved', threads: [THREAD, second], total: 2, has_more: false, next_cursor: null };
    await withSite({ markest_list_comments: () => answer }, async (site, markest) => {
        const out = await markest(['comments']);
        assert.equal(out.stdout, renderThread(THREAD) + '\n' + renderThread(second));
        assert.equal(out.stderr, '');
        answer = {};
        const none = await markest(['comments']);
        assert.equal(none.stdout, 'No unresolved threads.\n');
        assert.equal(none.stderr, '');
    });
});

test('reply says only that it replied when it does not resolve, and refuses a reply of nothing but spaces', async () => {
    await withSite({ markest_reply_to_comments: () => ({ replies: [{}], count: 1, left_this_hour: 29 }) }, async (site, markest) => {
        const out = await markest(['reply', C1, 'Thanks']);
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, 'Replied. 29 more replies this hour.\n');
        assert.deepEqual(site.agent.calls.at(-1).args, { replies: [{ comment_id: C1, body: 'Thanks' }] });
        const blank = await markest(['reply', C1, '   ']);
        assert.equal(blank.code, 1);
        assert.equal(blank.stderr, 'markest: There is nothing to say: the reply is empty.\n');
        assert.equal(site.agent.calls.length, 1, 'nothing more is sent');
    });
});

test('comments asks for one artifact\'s threads or every one\'s, and says when there are none or more', async () => {
    let answer = { status: 'unresolved', threads: [THREAD], total: 3, returned: 1, has_more: true, next_cursor: 'p2' };
    await withSite({ markest_list_comments: () => answer }, async (site, markest) => {
        const out = await markest(['comments', ID, '--status', 'all', '--since', '2026-09-01', '--limit', '1']);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, status: 'all', since: '2026-09-01', limit: 1 });
        assert.equal(out.stdout, renderThread(THREAD));
        assert.equal(out.stderr, '1 of 3 threads; the next page: --cursor p2\n');
        await markest(['comments', '--cursor', 'p2']);
        assert.deepEqual(site.agent.calls.at(-1).args, { cursor: 'p2' }, 'every artifact, the next page');
        answer = { status: 'resolved', threads: [], total: 0, has_more: false, next_cursor: null };
        assert.equal((await markest(['comments'])).stdout, 'No resolved threads.\n');
        answer = { status: 'all', threads: [], total: 0, has_more: false, next_cursor: null };
        assert.equal((await markest(['comments'])).stdout, 'No threads.\n');
    });
    for (const argv of [['comments', ID, '--status', 'open'], ['comments', ID, '--limit', '0'], ['comments', ID, '--limit', '51'], ['comments', 'x']]) {
        assert.equal((await run(argv)).code, 2, argv.join(' '));
    }
});

test('reply sends the text, or what is piped in, and can resolve the thread too', async () => {
    await withSite({ markest_reply_to_comments: () => ({ replies: [{}], count: 1, left_this_hour: 29 }) }, async (site, markest) => {
        const out = await markest(['reply', C1.toLowerCase(), 'Thanks,', 'fixed', 'now.', '--resolve']);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.agent.calls.at(-1).args, { replies: [{ comment_id: C1, body: 'Thanks, fixed now.', resolve: true }] });
        assert.equal(out.stdout, 'Replied and resolved the thread. 29 more replies this hour.\n');
        await markest(['reply', C1, '-'], { stdin: 'From a file.\n\n' });
        assert.deepEqual(site.agent.calls.at(-1).args, { replies: [{ comment_id: C1, body: 'From a file.' }] });
        const empty = await markest(['reply', C1, '-'], { stdin: '  \n' });
        assert.equal(empty.code, 1);
        assert.match(empty.stderr, /the reply is empty/);
    });
    for (const argv of [['reply', C1], ['reply', 'nope', 'hi'], ['reply']]) assert.equal((await run(argv)).code, 2, argv.join(' '));
});

test('resolve resolves threads, or reopens them', async () => {
    await withSite({ markest_resolve_comments: () => ({ changed: 2 }) }, async (site, markest) => {
        assert.equal((await markest(['resolve', C1, C2])).stdout, 'Resolved 2 threads.\n');
        assert.deepEqual(site.agent.calls.at(-1).args, { comment_ids: [C1, C2], resolved: true });
        assert.equal((await markest(['resolve', C1, '--reopen'])).stdout, 'Reopened 1 thread.\n');
        assert.deepEqual(site.agent.calls.at(-1).args, { comment_ids: [C1], resolved: false });
    });
    for (const argv of [['resolve'], ['resolve', C1, 'nope']]) assert.equal((await run(argv)).code, 2, argv.join(' '));
});
