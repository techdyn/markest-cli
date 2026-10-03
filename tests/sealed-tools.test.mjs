/**
 * Every tool `markest mcp` offers, called as an agent calls it, in process,
 * against the fake site (cli/mcp/sealed-tools): create, read, write, remove,
 * link and keys, each answering in the protocol's shape and refusing as one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshHome, KEY, homeEnv, testKeyring } from './support/cli-harness.mjs';
import { createRpc } from '../src/mcp/json-rpc.mjs';
import { INSTRUCTIONS, sealedTools } from '../src/mcp/sealed-tools.mjs';
import { isRefusal } from '../src/core/command-kit.mjs';
import { keyIn } from '../src/sealed/sealing.mjs';

async function withServer(body) {
    const site = await startFakeMarkest();
    const keyring = await freshHome();
    const ctx = { baseUrl: site.url, key: KEY, env: homeEnv(keyring), stderr: { write() {} }, version: '0', json: true };
    const rpc = createRpc({ name: 'markest-sealed', version: '0', instructions: INSTRUCTIONS, tools: sealedTools(ctx), isRefusal });
    let serial = 0;
    const call = async (name, args) => (await rpc.handle({ jsonrpc: '2.0', id: ++serial, method: 'tools/call', params: { name, arguments: args } })).result;
    try {
        await body({ site, call, keyring: testKeyring(keyring) });
    } finally {
        await site.close();
    }
}

test('an agent makes, writes to, reads, links and trims an encrypted artifact, each answer in the protocol\'s shape', async () => {
    await withServer(async ({ site, call }) => {
        const made = await call('markest_sealed_create', { title: 'Plan', documents: [{ path: 'README.md', content: '# Plan' }, { path: 'old.md', content: 'old' }] });
        assert.equal(made.isError, false);
        assert.equal(made.content[0].text, JSON.stringify(made.structuredContent));
        const { id, url } = made.structuredContent;

        const written = await call('markest_sealed_write', { artifact: id, documents: [{ path: 'README.md', content: '# Plan, again' }] });
        assert.deepEqual(written.structuredContent.written, [{ path: 'README.md', replaced: true, content_type: 'markdown' }]);
        const read = await call('markest_sealed_read', { artifact: id, all: true });
        assert.deepEqual(read.structuredContent.documents.map((doc) => doc.content), ['# Plan, again', 'old']);

        assert.deepEqual((await call('markest_sealed_link', { artifact: id })).structuredContent, { id, url, has_key: true });
        assert.deepEqual((await call('markest_sealed_remove_documents', { artifact: id, paths: ['old.md'] })).structuredContent, { id, removed: ['old.md'] });
        assert.equal(site.pastes.get(id).documents.length, 1);
    });
});

test('keys lists what this machine keeps for the site - never a key - and keeps one from a link once it opens', async () => {
    await withServer(async ({ site, call, keyring }) => {
        const made = (await call('markest_sealed_create', { title: 'Kept', documents: [{ path: 'a.md', content: 'x' }] })).structuredContent;
        const key = keyIn(made.url);
        const listed = await call('markest_sealed_keys', {});
        assert.deepEqual(listed.structuredContent.keys.map(({ saved_at, ...one }) => one), [{ id: made.id, title: 'Kept' }]);
        assert.ok(!JSON.stringify(listed).includes(key));
        await keyring.remember('https://elsewhere.test', made.id, key, 'Other site');
        assert.equal((await call('markest_sealed_keys', {})).structuredContent.keys.length, 1, 'only this site\'s');

        await keyring.forget(site.url, made.id);
        assert.deepEqual((await call('markest_sealed_keys', { link: made.url })).structuredContent, { kept: made.id, title: 'Kept' });
        assert.equal(await keyring.get(site.url, made.id), key);

        const clear = site.addPaste({ title: 'Clear', documents: [{ path: 'a.md', content: 'plain' }] });
        const refused = await call('markest_sealed_keys', { link: site.url + '/p/' + clear.id + '#key=' + key });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, /needs no key/);
        const notALink = await call('markest_sealed_keys', { link: made.id });
        assert.match(notALink.content[0].text, /whole link/);
    });
});

test('what the site or the tool refuses is a result marked an error, saying why', async () => {
    await withServer(async ({ call }) => {
        const none = await call('markest_sealed_read', { artifact: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
        assert.equal(none.isError, true);
        assert.match(none.content[0].text, /Paste not found|Not found/);
        const bad = await call('markest_sealed_write', { artifact: 'nonsense', documents: [{ path: 'a.md', content: 'x' }] });
        assert.match(bad.content[0].text, /by its id or its link/);
    });
});

// What an agent is shown is the tools' contract: every name, title, type, choice, required field and hint, and a description wherever one is said
const DESCRIBED = { type: 'string', description: true };
const DOCUMENT = {
    type: 'object',
    properties: { path: DESCRIBED, content: DESCRIBED, content_type: { type: 'string', enum: ['markdown', 'html', 'code'], description: true }, title: DESCRIBED },
    required: ['path', 'content'],
    additionalProperties: false,
};
const DOCUMENTS = { type: 'array', items: DOCUMENT, minItems: 1, maxItems: 50 };
const CONTRACT = [
    ['markest_sealed_create', 'Create an encrypted artifact',
        { title: DESCRIBED, documents: DOCUMENTS, visibility: { type: 'string', enum: ['unlisted', 'private'], default: 'unlisted' }, default_path: DESCRIBED, folder: DESCRIBED },
        ['documents'], { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
    ['markest_sealed_read', 'Read an encrypted artifact',
        { artifact: DESCRIBED, path: DESCRIBED, all: { type: 'boolean', description: true }, remember: { type: 'boolean', description: true } },
        ['artifact'], { readOnlyHint: true, openWorldHint: true }],
    ['markest_sealed_write', 'Add or replace documents in an encrypted artifact', { artifact: DESCRIBED, documents: DOCUMENTS },
        ['artifact', 'documents'], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }],
    ['markest_sealed_remove_documents', 'Take documents out of an encrypted artifact', { artifact: DESCRIBED, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } },
        ['artifact', 'paths'], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }],
    ['markest_sealed_link', 'The link that shares an encrypted artifact', { artifact: DESCRIBED }, ['artifact'], { readOnlyHint: true, openWorldHint: false }],
    ['markest_sealed_keys', 'Encrypted artifacts with keys kept here', { link: DESCRIBED }, [], { readOnlyHint: false, destructiveHint: false, openWorldHint: true }],
];
const PRIVACY = ' Markest stores only ciphertext and never has the key; text read or written here does pass through this conversation, so the AI provider running it sees it.';

/** The definition with each description checked as a sentence of its own and marked as there. */
function described(value, where) {
    if (Array.isArray(value)) return value.map((one, i) => described(one, where + '[' + i + ']'));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, one]) => {
        if (key !== 'description') return [key, described(one, where + '.' + key)];
        assert.match(one, /^[A-Z][^\n]{3,}[.)]$/, where + ' is a sentence');
        return [key, true];
    }));
}

test('each tool is shown to an agent as its contract says, with a description of its own and the privacy note', () => {
    const tools = sealedTools({}).map((one) => one.definition);
    assert.deepEqual(tools.map(({ description, ...one }) => described(one, one.name)), CONTRACT.map(([name, title, properties, required, hints]) => ({
        name, title, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { title, ...hints },
    })));
    for (const one of tools) {
        assert.ok(one.description.endsWith(PRIVACY), one.name);
        assert.match(one.description.slice(0, -PRIVACY.length), /^[A-Z].{30,}\.$/, one.name + ' says what it does before the note');
    }
    assert.ok(INSTRUCTIONS.startsWith('Tools for Markest artifacts encrypted end to end (their links end #key=...).'));
    assert.ok(INSTRUCTIONS.endsWith(PRIVACY));
});

test('keeping a key needs a whole link, naming the artifact and carrying the key', async () => {
    await withServer(async ({ call, site }) => {
        for (const link of ['https://marke.st/u/someone#key=' + 'Q'.repeat(42) + 'w', 'https://marke.st/p/01ARZ3NDEKTSV4RRFFQ69G5FAV']) {
            const refused = await call('markest_sealed_keys', { link });
            assert.equal(refused.isError, true, link);
            assert.equal(refused.content[0].text, 'Give the artifact\'s whole link, the one ending #key=...');
        }
        assert.equal(site.requests.length, 0, 'nothing asked of the site');
    });
});
