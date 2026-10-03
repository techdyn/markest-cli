/**
 * REGRESSION ANCHOR (D-20261001-01): `markest mcp` as an agent client runs it -
 * a real process on stdio, against the fake site (cli/commands/mcp,
 * cli/mcp/sealed-tools). It initialises, lists the sealed tools alone, each
 * saying what the model provider sees; creates an artifact the site holds only
 * as ciphertext; reads it back; and its stdout carries the protocol alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshHome, homeEnv, KEY, run } from './support/cli-harness.mjs';
import { keyIn } from '../src/sealed/sealing.mjs';
import { INSTRUCTIONS, sealedTools } from '../src/mcp/sealed-tools.mjs';

const ENTRY = fileURLToPath(new URL('../bin/markest.mjs', import.meta.url));

/** The server as a client starts it, and a way to send it requests and read its answers. */
function startServer(env) {
    const child = spawn(process.execPath, [ENTRY, 'mcp'], { env: { ...process.env, NODE_TEST_CONTEXT: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    const waiting = new Map();
    const lines = [];
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            lines.push(line);
            const message = JSON.parse(line);
            waiting.get(message.id)?.(message);
        }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let serial = 0;
    return {
        lines,
        stderr: () => stderr,
        request(method, params) {
            const id = ++serial;
            return new Promise((resolve) => {
                waiting.set(id, resolve);
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
        },
        notify(method) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
        },
        close: () => new Promise((resolve) => {
            child.on('close', (code) => resolve(code));
            child.stdin.end();
        }),
    };
}

test('the tools are the sealed ones alone, named apart, each saying what the model provider sees', () => {
    const tools = sealedTools({ baseUrl: 'https://marke.st', env: {} });
    assert.deepEqual(tools.map((one) => one.definition.name), ['markest_sealed_create', 'markest_sealed_read', 'markest_sealed_write', 'markest_sealed_remove_documents', 'markest_sealed_link', 'markest_sealed_keys']);
    for (const { definition } of tools) {
        assert.match(definition.description, /AI provider running it sees it/, definition.name);
        assert.equal(definition.inputSchema.type, 'object');
        assert.equal(definition.inputSchema.additionalProperties, false);
        assert.equal(typeof definition.annotations.readOnlyHint, 'boolean');
    }
    assert.ok(tools.find((one) => one.definition.name === 'markest_sealed_remove_documents').definition.annotations.destructiveHint);
    assert.match(INSTRUCTIONS, /for every other Markest task use the Markest connector/);
});

test('an agent client initialises it, creates an artifact sealed here, and reads it back; stdout is the protocol alone', { timeout: 60000 }, async () => {
    const site = await startFakeMarkest();
    const server = startServer(homeEnv(await freshHome(), { MARKEST_URL: site.url, MARKEST_API_KEY: KEY }));
    try {
        const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        assert.equal(init.result.serverInfo.name, 'markest-sealed');
        assert.equal(init.result.protocolVersion, '2025-06-18');
        server.notify('notifications/initialized');
        const listed = await server.request('tools/list', {});
        assert.equal(listed.result.tools.length, 6);

        const created = await server.request('tools/call', { name: 'markest_sealed_create', arguments: { title: 'From an agent', documents: [{ path: 'README.md', content: '# Secret plan' }] } });
        assert.equal(created.result.isError, false, JSON.stringify(created));
        const { id, url } = created.result.structuredContent;
        const key = keyIn(url);
        assert.ok(key);
        const stored = site.pastes.get(id).documents[0].content;
        assert.ok(stored.startsWith('MKSEAL1:') && !stored.includes('Secret'), 'the site holds ciphertext');

        const read = await server.request('tools/call', { name: 'markest_sealed_read', arguments: { artifact: id } });
        assert.equal(read.result.structuredContent.document.content, '# Secret plan', 'by id, with the key kept here');
        const refused = await server.request('tools/call', { name: 'markest_sealed_create', arguments: { documents: [{ path: 'a.md', content: 'x' }], visibility: 'public' } });
        assert.equal(refused.result.isError, true);
        assert.match(refused.result.content[0].text, /never public/);
        const unknown = await server.request('tools/call', { name: 'markest_read_document', arguments: {} });
        assert.equal(unknown.error.code, -32602, 'the remote tools are not here');

        assert.equal(await server.close(), 0);
        assert.ok(server.lines.every((line) => JSON.parse(line).jsonrpc === '2.0'), 'nothing but the protocol on stdout');
        assert.ok(site.requests.every((one) => !JSON.stringify([one.path, one.query, one.headers]).includes(key) && !one.bytes.toString().includes(key)), 'the key never sent');
        assert.ok(!server.stderr().includes(key));
    } finally {
        await site.close();
    }
});

test('it takes nothing on the command line, and says how a client starts it', async () => {
    assert.equal((await run(['mcp', 'extra'])).code, 2);
    const help = (await run(['help', 'mcp'])).stdout;
    // Signed in, the client needs no key; a key is the other way (D-20261002-04)
    assert.match(help, /once you have run markest login:\n {2}claude mcp add markest-sealed -- markest mcp\n/);
    assert.match(help, /claude mcp add markest-sealed -e MARKEST_API_KEY=mk_live_\.\.\.\n-- markest mcp/);
});

test('it starts with no API key, since reading by a link needs none', async () => {
    const out = await run(['mcp'], { MARKEST_HOME: await freshHome() }, { stdin: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
});
