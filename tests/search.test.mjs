/**
 * `markest grep` against the fake site (cli/commands/search): the pattern and
 * its flags in the agent tool's words, matches printed as grep prints them,
 * and grep's exit code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, run } from './support/cli-harness.mjs';
import { renderMatches } from '../src/commands/search.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const RESULT = {
    results: [
        { paste_id: ID, path: 'a.md', matches: 1, lines: [{ line: 3, text: 'before', match: false }, { line: 4, text: 'the plan\u001b[1m', match: true }] },
        { paste_id: ID, path: 'b.md', error: 'too large to search' },
    ],
    total_matches: 1, has_more: true, next_cursor: 'n2',
};

test('matches print as grep prints them, context apart, without control characters', () => {
    assert.equal(renderMatches(RESULT, 'content'), ID + ':a.md-3-before\n' + ID + ':a.md:4:the plan[1m\n' + ID + ':b.md: too large to search\n');
    assert.equal(renderMatches(RESULT, 'files'), ID + ':a.md\n' + ID + ':b.md: too large to search\n');
    assert.equal(renderMatches(RESULT, 'count'), ID + ':a.md:1\n' + ID + ':b.md: too large to search\n');
    assert.equal(renderMatches({ results: [] }, 'content'), '');
    assert.equal(renderMatches({}, 'files'), '', 'an answer with no results prints nothing');
    assert.equal(renderMatches({ results: [{ paste_id: ID, path: 'c.md', matches: 0 }] }, 'content'), '', 'nor a result with no lines');
});

const AGAIN = '\nRun markest --help for the commands.\n';

test('grep counts the matches the site counted, else the results it gave, and asks again after a lost connection, since it only reads', async () => {
    let answer = {};
    const site = await startFakeMarkest({ tools: { markest_grep: () => answer } });
    const markest = against(site);
    try {
        for (const [given, code] of [
            [{}, 1],
            [{ results: [] }, 1],
            [{ results: [RESULT.results[0]] }, 0],
            [{ results: [], total_matches: 2 }, 0],
            [{ results: [RESULT.results[0]], total_matches: 0 }, 1],
        ]) {
            answer = given;
            const out = await markest(['grep', 'plan']);
            assert.equal(out.code, code, JSON.stringify(given));
            assert.equal(out.stdout, renderMatches(given, 'content'), JSON.stringify(given));
            assert.equal(out.stderr, '', 'no next page, and nothing gone wrong: ' + JSON.stringify(given));
        }
        answer = { results: [RESULT.results[0]] };
        site.answerOnce((one) => one.path === '/mcp', (req) => { req.socket.destroy(); });
        const again = await markest(['grep', 'plan']);
        assert.equal(again.code, 0, again.stderr);
        assert.equal(again.stdout, renderMatches(answer, 'content'));
    } finally {
        await site.close();
    }
});

test('grep refuses a wrong number or too many artifacts in so many words, and does not run without a key', async () => {
    const site = await startFakeMarkest({ tools: { markest_grep: () => RESULT } });
    const markest = against(site);
    try {
        for (const [argv, message] of [
            [['grep', 'a', '-C', 'x1'], '--context is a number'],
            [['grep', 'a', '--max', '1x'], '--max is a number'],
            [['grep', 'a', ...Array.from({ length: 51 }, () => ['--in', ID]).flat()], 'Too many arguments: markest grep <pattern> --in <artifact>'],
        ]) {
            const out = await markest(argv);
            assert.equal(out.code, 2, argv.slice(0, 4).join(' '));
            assert.equal(out.stderr, 'markest: ' + message + AGAIN);
        }
        const noKey = await markest(['grep', 'a'], { env: {} });
        assert.equal(noKey.code, 2);
        assert.equal(noKey.stderr, 'markest: Sign in with markest login, or set MARKEST_API_KEY to an API key from your account settings.' + AGAIN);
        assert.equal(site.requests.length, 0, 'nothing is sent');
    } finally {
        await site.close();
    }
});

test('grep sends the pattern and its flags, prints the matches, and exits 1 with none', async () => {
    let answer = RESULT;
    const site = await startFakeMarkest({ tools: { markest_grep: () => answer } });
    const markest = against(site);
    try {
        const out = await markest(['grep', 'pl.n', '--in', ID, '--folder', 'work', '--glob', '**/*.md', '--fixed', '-i', '-C', '1', '--max', '20', '--cursor', 'c1']);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.agent.calls.at(-1).args, { pattern: 'pl.n', pastes: [ID], folder: 'work', glob: '**/*.md', cursor: 'c1', fixed_strings: true, ignore_case: true, context: 1, max_results: 20, output_mode: 'content' });
        assert.equal(out.stdout, renderMatches(RESULT, 'content'));
        assert.equal(out.stderr, 'More matches: --cursor n2\n');
        await markest(['grep', 'x', '--files']);
        assert.deepEqual(site.agent.calls.at(-1).args, { pattern: 'x', output_mode: 'files' });
        await markest(['grep', 'x', '--count']);
        assert.equal(site.agent.calls.at(-1).args.output_mode, 'count');
        answer = { results: [], total_matches: 0, has_more: false };
        const none = await markest(['grep', 'nothing']);
        assert.equal(none.code, 1, 'as grep, none is 1');
        assert.equal(none.stdout, '');
        assert.equal((await markest(['grep', 'nothing', '--json'])).code, 1);
    } finally {
        await site.close();
    }
    for (const argv of [['grep'], ['grep', ''], ['grep', 'a', 'b'], ['grep', 'a', '--files', '--count'], ['grep', 'a', '-C', 'x'], ['grep', 'a', '--in', 'nope']]) {
        assert.equal((await run(argv)).code, 2, argv.join(' '));
    }
});
