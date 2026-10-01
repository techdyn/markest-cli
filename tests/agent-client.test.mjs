/**
 * The site's agent tools called from the command line (cli/core/agent-client):
 * JSON-RPC over the REST client, the protocol the site speaks, a tool's
 * structured answer or its text, its refusal and the plan's, and the list of
 * tools however it is paged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ApiError, createClient } from '../src/core/api-client.mjs';
import { AgentError, createAgent, PROTOCOL_VERSION } from '../src/core/agent-client.mjs';
import { startFakeMarkest } from './support/fake-markest.mjs';

const KEY = 'mk_live_' + 'cd'.repeat(24);

async function withSite(options, body) {
    const site = await startFakeMarkest(options);
    try {
        await body(site, createAgent(createClient({ baseUrl: site.url, key: KEY })));
    } finally {
        await site.close();
    }
}

test('a tool is called as the site expects, and answers with its structured content', async () => {
    await withSite({ tools: { markest_get_views: (args) => ({ days: 30, ids: args.paste_ids }) } }, async (site, agent) => {
        assert.deepEqual(await agent.call('markest_get_views', { paste_ids: ['A'] }, { reads: true }), { days: 30, ids: ['A'] });
        const sent = site.requests.at(-1);
        assert.equal(sent.path, '/mcp');
        assert.equal(sent.headers['mcp-protocol-version'], PROTOCOL_VERSION);
        assert.equal(PROTOCOL_VERSION, '2025-06-18');
        assert.match(sent.headers.accept, /application\/json/);
        assert.match(sent.headers.accept, /text\/event-stream/);
        assert.equal(sent.headers.authorization, 'Bearer ' + KEY);
        assert.equal(sent.json.jsonrpc, '2.0');
        assert.equal(sent.json.method, 'tools/call');
        assert.deepEqual(sent.json.params, { name: 'markest_get_views', arguments: { paste_ids: ['A'] } });
        assert.ok(Number.isInteger(sent.json.id));
        await agent.call('markest_get_views', {});
        assert.ok(site.requests.at(-1).json.id > sent.json.id, 'each request its own id');
    });
});

test('a tool with no structured content answers with its text, as JSON where it is JSON', async () => {
    await withSite({ tools: { a: () => ({ textOnly: '{"n":2}' }), b: () => ({ textOnly: 'plain words' }) } }, async (site, agent) => {
        assert.deepEqual(await agent.call('a'), { n: 2 });
        assert.deepEqual(await agent.call('b'), { text: 'plain words' });
        assert.deepEqual(site.requests.at(-1).json.params.arguments, {}, 'no arguments is an empty object');
    });
});

test('a tool that refuses says why, and so does a plan without agent access', async () => {
    await withSite({ tools: { markest_fork_paste: () => ({ refuse: 'It is encrypted in the browser, so it cannot be copied.' }) } }, async (site, agent) => {
        await assert.rejects(agent.call('markest_fork_paste', { pastes: ['A'] }), (error) => error instanceof AgentError && error.tool === 'markest_fork_paste' && /cannot be copied/.test(error.message));
        await assert.rejects(agent.call('markest_nothing'), (error) => error instanceof AgentError && error.code === -32602 && /Unknown tool/.test(error.message));
    });
    await withSite({ agentAccess: false }, async (site, agent) => {
        await assert.rejects(agent.call('markest_list_comments'), (error) => error instanceof AgentError && error.status === 403 && error.code === -32001 && error.message === 'Agent access is not included in your plan.');
    });
});

test('an answer the tool cannot read is said so; a refusal with no words still is one', async () => {
    const answers = [{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2, error: { code: 1 } }, { jsonrpc: '2.0', id: 3, result: { isError: true, content: [] } }];
    const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(answers.shift()));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const agent = createAgent(createClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, key: KEY }));
        await assert.rejects(agent.call('x'), /no answer the tool can read/);
        await assert.rejects(agent.call('x'), /The site refused the request\./);
        await assert.rejects(agent.call('quiet'), /The tool quiet refused\./);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('the tools are listed however the site pages them', async () => {
    const tools = Object.fromEntries(['search', 'markest_list_comments', 'markest_grep', 'markest_fork_paste', 'markest_get_views'].map((name) => [name, () => ({})]));
    await withSite({ tools, pageSize: 2 }, async (site, agent) => {
        const listed = await agent.tools();
        assert.deepEqual(listed.map((one) => one.name), Object.keys(tools));
        assert.equal(site.requests.filter((one) => one.json?.method === 'tools/list').length, 3);
        assert.equal(site.requests.at(-1).json.params.cursor, '4');
    });
});

test('a lost connection is tried again only for a tool that only reads', async () => {
    await withSite({ tools: { markest_list_comments: () => ({ threads: [] }), markest_fork_paste: () => ({ forks: [] }) } }, async (site, agent) => {
        site.answerOnce((one) => one.path === '/mcp', (req) => { req.socket.destroy(); });
        assert.deepEqual(await agent.call('markest_list_comments', {}, { reads: true }), { threads: [] });
        site.answerOnce((one) => one.path === '/mcp', (req) => { req.socket.destroy(); });
        await assert.rejects(agent.call('markest_fork_paste', {}), (error) => !(error instanceof AgentError) || /lost/.test(error.message));
        assert.equal(site.agent.calls.filter((one) => one.name === 'markest_fork_paste').length, 0, 'a change is never sent twice');
    });
});

test('only the text parts of an answer are its text, and a refusal with no text names its tool', async () => {
    const answers = [
        { jsonrpc: '2.0', id: 1, result: { isError: true, content: [null, { type: 'image', data: 'x' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } },
        { jsonrpc: '2.0', id: 2, result: { isError: true, content: 'not a list' } },
        { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'image' }, { type: 'text', text: '{"a":1}' }] } },
        { jsonrpc: '2.0', id: 4 },
    ];
    const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(answers.shift()));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const agent = createAgent(createClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, key: KEY }));
        await assert.rejects(agent.call('t'), (error) => error.message === 'first\nsecond');
        await assert.rejects(agent.call('quiet'), (error) => error.message === 'The tool quiet refused.' && error.tool === 'quiet');
        assert.deepEqual(await agent.call('t'), { a: 1 });
        await assert.rejects(agent.call('t'), (error) => error.status === 200);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('the tools list starts with no cursor, takes what is a list, stops at a cursor that is none, and at twenty pages whatever', async () => {
    const pages = [];
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const message = JSON.parse(Buffer.concat(chunks).toString());
            pages.push(message.params);
            const n = pages.length;
            const result = n === 1 ? { tools: [{ name: 'a' }], nextCursor: 'c1' } : n === 2 ? { tools: 'not a list', nextCursor: 'c2' } : n === 3 ? { tools: [{ name: 'b' }], nextCursor: '' } : { tools: [{ name: 'x' + n }], nextCursor: 'more' };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const agent = createAgent(createClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, key: KEY }));
        assert.deepEqual((await agent.tools()).map((one) => one.name), ['a', 'b']);
        assert.deepEqual(pages, [{}, { cursor: 'c1' }, { cursor: 'c2' }], 'no cursor at first, then each given');
        pages.length = 3;
        const endless = await agent.tools();
        assert.equal(pages.length - 3, 20, 'twenty pages, then it stops');
        assert.equal(endless.length, 20);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('listing the tools only reads, so a lost connection is tried again', async () => {
    await withSite({ tools: { search: () => ({}) } }, async (site, agent) => {
        site.answerOnce((one) => one.path === '/mcp', (req) => { req.socket.destroy(); });
        assert.deepEqual((await agent.tools()).map((one) => one.name), ['search']);
    });
});

test('a refusal of the site is the agent\'s, with the code it gave or none; anything else is passed on as it is', async () => {
    const thrown = [new ApiError('No.', { status: 403, body: { error: { code: -32001 } } }), new ApiError('Down.', { status: 500, body: null }), new ApiError('Odd.', { status: 400, body: {} }), new TypeError('a bug')];
    const agent = createAgent({ request: async () => { throw thrown.shift(); } });
    await assert.rejects(agent.call('x'), (error) => error instanceof AgentError && error.message === 'No.' && error.status === 403 && error.code === -32001);
    await assert.rejects(agent.call('x'), (error) => error instanceof AgentError && error.status === 500 && error.code === null);
    await assert.rejects(agent.call('x'), (error) => error instanceof AgentError && error.status === 400 && error.code === null);
    await assert.rejects(agent.call('x'), (error) => error instanceof TypeError && !(error instanceof AgentError));
});

test('a result that is no object is no answer the tool can read', async () => {
    for (const result of [null, 'text', 5]) {
        const agent = createAgent({ request: async () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } }) });
        await assert.rejects(agent.call('x'), (error) => error instanceof AgentError && error.message === 'The site gave no answer the tool can read.' && error.status === 200, String(result));
    }
});
