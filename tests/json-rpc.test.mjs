/**
 * The Model Context Protocol answers `markest mcp` gives (cli/mcp/json-rpc):
 * initialize with a revision both sides speak, ping, the tools listed, a tool's
 * answer and its refusal as the protocol asks, and a JSON-RPC error for the rest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, PROTOCOL_VERSIONS } from '../src/mcp/json-rpc.mjs';
import { Refused, isRefusal } from '../src/core/command-kit.mjs';

const rpc = createRpc({
    name: 'markest-sealed',
    version: '9.9.9',
    instructions: 'Use these for encrypted artifacts.',
    isRefusal,
    tools: [
        { definition: { name: 'echo', inputSchema: { type: 'object' } }, run: async (args) => ({ said: args.text ?? null }) },
        { definition: { name: 'refuse', inputSchema: { type: 'object' } }, run: async () => { throw new Refused('Not like that.'); } },
        { definition: { name: 'bug', inputSchema: { type: 'object' } }, run: async () => { throw new TypeError('x is undefined'); } },
    ],
});

test('initialize answers with a revision both sides speak, and says what it is', async () => {
    const answer = await rpc.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    assert.deepEqual(answer, {
        jsonrpc: '2.0', id: 1,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'markest-sealed', version: '9.9.9' }, instructions: 'Use these for encrypted artifacts.' },
    });
    assert.equal((await rpc.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).result.protocolVersion, PROTOCOL_VERSIONS[0], 'one it does not speak: its newest');
    assert.equal((await rpc.handle({ jsonrpc: '2.0', id: 3, method: 'initialize' })).result.protocolVersion, '2025-06-18');
    assert.deepEqual(PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26', '2024-11-05']);
});

test('a notification gets no answer; ping and the tools list do', async () => {
    assert.equal(await rpc.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
    const listed = await rpc.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    assert.deepEqual(listed.result.tools.map((one) => one.name), ['echo', 'refuse', 'bug']);
});

test('a tool answers with structured content and its text; a refusal is a result marked an error', async () => {
    const answer = await rpc.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
    assert.deepEqual(answer.result, { content: [{ type: 'text', text: '{"said":"hi"}' }], structuredContent: { said: 'hi' }, isError: false });
    assert.deepEqual((await rpc.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo' } })).result.structuredContent, { said: null }, 'no arguments is an empty object');
    const refused = await rpc.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'refuse', arguments: {} } });
    assert.deepEqual(refused.result, { content: [{ type: 'text', text: 'Not like that.' }], isError: true });
    const bug = await rpc.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bug', arguments: {} } });
    assert.deepEqual(bug.error, { code: -32603, message: 'The tool failed unexpectedly: x is undefined' });
});

test('anything else is a JSON-RPC error', async () => {
    assert.equal((await rpc.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
    assert.equal((await rpc.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'echo', arguments: [1] } })).error.code, -32602);
    assert.equal((await rpc.handle({ jsonrpc: '2.0', id: 11, method: 'resources/list' })).error.code, -32601);
    for (const bad of [null, [], { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 12 }, 'x']) {
        assert.equal((await rpc.handle(bad)).error.code, -32600, JSON.stringify(bad));
    }
    assert.deepEqual(await rpc.handleLine('{not json'), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } });
    assert.equal((await rpc.handleLine('{"jsonrpc":"2.0","id":13,"method":"ping"}')).id, 13);
});

test('each JSON-RPC error says what was wrong, to the request that asked', async () => {
    const said = async (message) => (await rpc.handle(message)).error;
    assert.deepEqual(await said({ jsonrpc: '2.0', id: 20, method: 'tools/call' }), { code: -32602, message: 'Unknown tool: undefined' }, 'a call naming no tool');
    assert.deepEqual(await said({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'nope' } }), { code: -32602, message: 'Unknown tool: nope' });
    for (const args of ['x', 5, [1], true]) {
        assert.deepEqual(await said({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'echo', arguments: args } }), { code: -32602, message: 'A tool\'s arguments are one object.' }, JSON.stringify(args));
    }
    assert.deepEqual((await rpc.handle({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'echo', arguments: null } })).result.structuredContent, { said: null }, 'no arguments are none');
    assert.deepEqual(await rpc.handle({ jsonrpc: '2.0', id: 24, method: 'resources/list' }), { jsonrpc: '2.0', id: 24, error: { code: -32601, message: 'No method resources/list.' } });
    for (const bad of [{ jsonrpc: '2.0', id: 25 }, { jsonrpc: '2.0', id: 25, method: 5 }, { jsonrpc: '1.0', id: 25, method: 'ping' }]) {
        assert.deepEqual(await rpc.handle(bad), { jsonrpc: '2.0', id: 25, error: { code: -32600, message: 'Not a JSON-RPC 2.0 request.' } }, JSON.stringify(bad));
    }
    assert.deepEqual(await rpc.handle(undefined), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Not a JSON-RPC 2.0 request.' } });
});

test('a tool that fails, rather than refuses, is an internal error saying what it threw; with no rule, every failure is one', async () => {
    const thrown = [new TypeError('x is undefined'), 'boom', null, new Refused('Not like that.')];
    const strict = createRpc({ name: 'n', version: '1', instructions: '', tools: [{ definition: { name: 'f', inputSchema: { type: 'object' } }, run: async () => { throw thrown.shift(); } }] });
    const errorOf = async () => (await strict.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'f' } })).error;
    assert.deepEqual(await errorOf(), { code: -32603, message: 'The tool failed unexpectedly: x is undefined' });
    assert.deepEqual(await errorOf(), { code: -32603, message: 'The tool failed unexpectedly: boom' });
    assert.deepEqual(await errorOf(), { code: -32603, message: 'The tool failed unexpectedly: null' });
    assert.deepEqual(await errorOf(), { code: -32603, message: 'The tool failed unexpectedly: Not like that.' }, 'a server told of no refusals takes none for one');
});
