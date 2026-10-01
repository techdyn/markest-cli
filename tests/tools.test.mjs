/**
 * `markest tools` and `markest call` against the fake site (cli/commands/tools):
 * every agent tool listed, and any one run with JSON arguments, given or piped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, run } from './support/cli-harness.mjs';
import { firstSentence } from '../src/commands/tools.mjs';

async function withSite(body) {
    const site = await startFakeMarkest({ tools: { search: (args) => ({ results: [args.query] }), markest_fork_paste: () => ({ forks: [] }), markest_list_comments: () => ({ threads: [] }) }, pageSize: 2 });
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

test('a description is cut to its first sentence for a list', () => {
    assert.equal(firstSentence('Search pastes. Then more.'), 'Search pastes.');
    assert.equal(firstSentence('  Two\n  lines here!  And more'), 'Two lines here!');
    assert.equal(firstSentence('No full stop'), 'No full stop');
    assert.equal(firstSentence('v1.2 is out. Yes'), 'v1.2 is out.');
    assert.equal(firstSentence(null), '');
});

test('tools lists every tool, however paged, marking those that change something', async () => {
    await withSite(async (site, markest) => {
        const out = await markest(['tools']);
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, 'search                 Does search.\nmarkest_fork_paste     * Does markest_fork_paste.\nmarkest_list_comments  Does markest_list_comments.\n\n* changes something\n');
        const one = await markest(['tools', 'search']);
        assert.match(one.stdout, /^Does search\. More words\.\n\nArguments:\n\{\n {2}"type": "object"\n\}\n$/);
        const missing = await markest(['tools', 'markest_nothing']);
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /There is no tool "markest_nothing"/);
        assert.equal(JSON.parse((await markest(['tools', '--json'])).stdout).tools.length, 3);
    });
    assert.equal((await run(['tools', 'Bad-Name'])).code, 2);
    assert.equal((await run(['tools', 'a', 'b'])).code, 2);
});

test('call runs any tool with JSON arguments, given or piped, and prints its answer as JSON', async () => {
    await withSite(async (site, markest) => {
        const out = await markest(['call', 'search', '{"query": "plan"}']);
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, '{"results":["plan"]}\n');
        assert.deepEqual(site.agent.calls.at(-1), { name: 'search', args: { query: 'plan' } });
        assert.equal((await markest(['call', 'search', '-'], { stdin: '{"query": "piped"}' })).stdout, '{"results":["piped"]}\n');
        await markest(['call', 'markest_list_comments']);
        assert.deepEqual(site.agent.calls.at(-1).args, {});
        for (const stdin of ['not json', '[1]', 'null']) {
            const bad = await markest(['call', 'search', '-'], { stdin });
            assert.equal(bad.code, 1, stdin);
            assert.match(bad.stderr, /JSON/);
        }
        const unknown = await markest(['call', 'markest_nothing', '{}']);
        assert.equal(unknown.code, 1);
        assert.match(unknown.stderr, /Unknown tool/);
    });
    for (const argv of [['call'], ['call', 'search', '{bad'], ['call', 'search', '[1,2]'], ['call', 'search', 'null'], ['call', 'Bad', '{}'], ['call', 'a', '{}', 'extra']]) {
        assert.equal((await run(argv)).code, 2, argv.join(' '));
    }
});

const AGAIN = '\nRun markest --help for the commands.\n';

/** The site's list of tools, answered once as given. */
const listing = (tools) => (req, res, record) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: record.json.id, result: { tools } }));
};

test('a tool listed with no title, description or hints is untitled, undescribed and changes something', async () => {
    const tools = [{ name: 'bare' }, { name: 'reader', title: 'Reader', description: 'Reads. More.', annotations: { readOnlyHint: true } }];
    await withSite(async (site, markest) => {
        site.answerOnce((one) => one.json?.method === 'tools/list', listing(tools));
        const out = await markest(['tools', '--json']);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(JSON.parse(out.stdout), { tools: [
            { name: 'bare', title: null, description: '', read_only: false },
            { name: 'reader', title: 'Reader', description: 'Reads. More.', read_only: true },
        ] });
        site.answerOnce((one) => one.json?.method === 'tools/list', listing(tools));
        const one = await markest(['tools', 'bare']);
        assert.equal(one.code, 0, one.stderr);
        assert.equal(one.stdout, '\n\nArguments:\n{}\n');
    });
});

test('a wrong name or arguments are refused in so many words, and nothing runs without a key', async () => {
    await withSite(async (site, markest) => {
        for (const [argv, message] of [
            [['tools', 'search-x'], '"search-x" is not a tool\'s name'],
            [['tools', 'a'.repeat(65)], '"' + 'a'.repeat(65) + '" is not a tool\'s name'],
            [['call', 'search-x', '{}'], '"search-x" is not a tool\'s name'],
            [['call', 'search', '{bad'], 'The arguments are not JSON: {bad'],
            [['call', 'search', '5'], 'The arguments are one JSON object'],
            [['call', 'search', '"plan"'], 'The arguments are one JSON object'],
        ]) {
            const out = await markest(argv);
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: ' + message + AGAIN, argv.join(' '));
        }
        for (const argv of [['tools'], ['call', 'search', '{}']]) {
            const out = await markest(argv, { env: {} });
            assert.equal(out.code, 2, argv.join(' '));
            assert.equal(out.stderr, 'markest: Set MARKEST_API_KEY to an API key from your account settings.' + AGAIN);
        }
        assert.equal(site.requests.length, 0, 'nothing is sent');
        for (const [stdin, message] of [['5', 'The arguments are one JSON object.'], ['not json', 'What arrived on stdin is not JSON.']]) {
            const out = await markest(['call', 'search', '-'], { stdin });
            assert.equal(out.code, 1, stdin);
            assert.equal(out.stderr, 'markest: ' + message + '\n');
        }
        assert.equal(site.agent.calls.length, 0, 'nor is a tool called');
    });
});
