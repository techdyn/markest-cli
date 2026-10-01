import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient, redact, ApiError } from '../src/core/api-client.mjs';

const KEY = 'mk_live_' + '0f'.repeat(24);

async function stub(answers) {
    const seen = [];
    const server = createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, headers: req.headers });
        const answer = answers.shift() ?? { status: 200, body: {} };
        if (answer.drop) {
            req.socket.destroy();
            return;
        }
        res.writeHead(answer.status, { 'Content-Type': 'application/json', ...(answer.headers ?? {}) });
        res.end(JSON.stringify(answer.body ?? {}));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { seen, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

async function withStub(answers, body) {
    const site = await stub(answers);
    const waits = [];
    const client = createClient({ baseUrl: site.url, key: KEY, sleep: async (ms) => { waits.push(ms); }, version: '9.9' });
    try {
        await body({ site, client, waits });
    } finally {
        await site.close();
    }
}

test('every request carries the key, asks for JSON and names the command', async () => {
    await withStub([{ status: 201, body: { id: 'x' } }], async ({ site, client }) => {
        const answer = await client.request('POST', '/api/v1/pastes', { json: { a: 1 } });
        assert.deepEqual(answer, { status: 201, body: { id: 'x' }, text: '{"id":"x"}' }, 'the parsed answer, and its text as sent');
        const headers = site.seen[0].headers;
        assert.equal(headers.authorization, 'Bearer ' + KEY);
        assert.equal(headers.accept, 'application/json');
        assert.equal(headers['content-type'], 'application/json');
        assert.match(headers['user-agent'], /^markest-cli\/9\.9 node\/v\d+/);
        assert.equal(client.requests, 1);
    });
});

test('with no key a request carries no credential; a caller may ask for more than JSON and add headers', async () => {
    const site = await stub([{ status: 200 }, { status: 200 }]);
    try {
        const anonymous = createClient({ baseUrl: site.url, key: '', version: '1' });
        await anonymous.request('GET', '/x', { accept: 'application/json, text/event-stream', headers: { 'MCP-Protocol-Version': '2025-06-18' } });
        assert.equal(site.seen[0].headers.authorization, undefined);
        assert.equal(site.seen[0].headers.accept, 'application/json, text/event-stream');
        assert.equal(site.seen[0].headers['mcp-protocol-version'], '2025-06-18');
        await createClient({ baseUrl: site.url, key: KEY }).request('GET', '/x');
        assert.equal(site.seen[1].headers.authorization, 'Bearer ' + KEY);
        assert.match(site.seen[1].headers['user-agent'], /^markest-cli\/0 /, 'a version always named');
    } finally {
        await site.close();
    }
});

test('a refusal says what the site said: the API\'s error, a JSON-RPC error\'s message, else the text or the status', async () => {
    await withStub([
        { status: 403, body: { error: { code: -32001, message: 'Agent access is not in your plan.' } } },
        { status: 400, body: { error: 'Bad.' } },
        { status: 418 },
    ], async ({ client }) => {
        await assert.rejects(client.request('POST', '/mcp', { json: {} }), (error) => error.status === 403 && error.message === 'Agent access is not in your plan.' && error.body.error.code === -32001);
        await assert.rejects(client.request('POST', '/x', { json: {} }), (error) => error.message === 'Bad.');
        await assert.rejects(client.request('GET', '/x'), (error) => error instanceof ApiError && error.message === '{}', 'the text when nothing else');
    });
    const waits = [];
    const site = await stub(Array.from({ length: 6 }, () => ({ status: 429, body: { error: { message: 'Slow, JSON-RPC.' } } })));
    try {
        const client = createClient({ baseUrl: site.url, key: KEY, sleep: async (ms) => { waits.push(ms); } });
        await assert.rejects(client.request('GET', '/x'), /Too many requests: Slow, JSON-RPC\./);
    } finally {
        await site.close();
    }
});

test('a 429 waits as long as asked, 5 s when it does not say, a minute at most, five times at most', async () => {
    await withStub([
        { status: 429, headers: { 'Retry-After': '2' } },
        { status: 429 },
        { status: 429, headers: { 'Retry-After': '300' } },
        { status: 200, body: { ok: true } },
    ], async ({ client, waits }) => {
        assert.deepEqual((await client.request('GET', '/x')).body, { ok: true });
        assert.deepEqual(waits, [2000, 5000, 60000]);
    });
    await withStub(Array.from({ length: 6 }, () => ({ status: 429, body: { error: 'Slow down.' } })), async ({ client, waits }) => {
        await assert.rejects(client.request('POST', '/x', { json: {} }), (error) => error instanceof ApiError && error.status === 429 && /Slow down/.test(error.message));
        assert.equal(waits.length, 5);
    });
});

test('a 503 asking for longer than a minute - the site being updated - stops at once', async () => {
    await withStub([{ status: 503, headers: { 'Retry-After': '3600' }, body: { error: 'Maintenance.' } }], async ({ client, waits }) => {
        await assert.rejects(client.request('GET', '/x', { idempotent: true }), /unavailable for now: Maintenance/);
        assert.deepEqual(waits, []);
    });
    await withStub([{ status: 503, headers: { 'Retry-After': '1' } }, { status: 200 }], async ({ client, waits }) => {
        assert.equal((await client.request('GET', '/x')).status, 200);
        assert.deepEqual(waits, [1000]);
    });
});

test('a lost connection is tried again only for a request safe to repeat', async () => {
    await withStub([{ drop: true }, { drop: true }, { status: 200 }], async ({ site, client, waits }) => {
        assert.equal((await client.request('GET', '/x', { idempotent: true })).status, 200);
        assert.equal(site.seen.length, 3);
        assert.deepEqual(waits, [1000, 2000]);
    });
    await withStub([{ drop: true }, { status: 200 }], async ({ site, client }) => {
        await assert.rejects(client.request('POST', '/x', { json: {} }), (error) => error.lost === true);
        assert.equal(site.seen.length, 1);
    });
    await withStub([{ status: 502 }, { status: 504 }, { status: 502 }], async ({ client }) => {
        await assert.rejects(client.request('GET', '/x', { idempotent: true }), (error) => error.status === 502);
    });
    await withStub([{ status: 500, body: { error: 'Broken.' } }], async ({ site, client }) => {
        await assert.rejects(client.request('GET', '/x', { idempotent: true }), /Broken/);
        assert.equal(site.seen.length, 1, 'a 500 is not tried again');
    });
});

test('a redirect is an error, and the key never follows it', async () => {
    const elsewhere = await stub([]);
    try {
        await withStub([{ status: 301, headers: { Location: elsewhere.url + '/x' } }], async ({ client }) => {
            await assert.rejects(client.request('GET', '/x', { idempotent: true }), /redirect/);
        });
        assert.equal(elsewhere.seen.length, 0);
    } finally {
        await elsewhere.close();
    }
});

test('an error made with nothing said is no lost connection, has no status and no body', () => {
    const error = new ApiError('x');
    assert.deepEqual([error.message, error.status, error.body, error.lost], ['x', 0, null, false]);
});

test('bytes go with their own type, a query is carried, and a read sends no body type', async () => {
    await withStub([{ status: 201 }, { status: 200 }], async ({ site, client }) => {
        await client.request('PUT', '/img', { body: Buffer.from('PNG'), contentType: 'image/png', query: { name: 'a b.png', n: '2' } });
        assert.equal(site.seen[0].headers['content-type'], 'image/png');
        assert.equal(site.seen[0].url, '/img?name=a+b.png&n=2');
        await client.request('GET', '/x');
        assert.equal(site.seen[1].headers['content-type'], undefined, 'nothing to type');
    });
});

test('an answer with no JSON is kept as text; an error\'s text is cut to 200 characters, and an empty one is its status', async () => {
    const long = 'E'.repeat(500);
    const raw = createServer((req, res) => {
        const [status, body] = { '/empty': [200, ''], '/plain': [200, 'just text'], '/long': [500, long], '/none': [502, ''], '/word': [400, 'Bad request'] }[req.url.split('?')[0]];
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(body);
    });
    await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
    try {
        const client = createClient({ baseUrl: 'http://127.0.0.1:' + raw.address().port, key: KEY, sleep: async () => {} });
        assert.deepEqual(await client.request('GET', '/empty'), { status: 200, body: null, text: '' });
        assert.deepEqual(await client.request('GET', '/plain'), { status: 200, body: null, text: 'just text' });
        await assert.rejects(client.request('GET', '/long'), (error) => error.message === 'E'.repeat(200) && error.status === 500 && error.body === null);
        await assert.rejects(client.request('POST', '/none', { json: {} }), (error) => error.message === 'HTTP 502');
        await assert.rejects(client.request('GET', '/word'), (error) => error.message === 'Bad request');
    } finally {
        raw.closeAllConnections?.();
        await new Promise((resolve) => raw.close(resolve));
    }
});

test('a lost connection is tried twice more at most, and says what was lost', async () => {
    await withStub([{ drop: true }, { drop: true }, { drop: true }, { status: 200 }], async ({ site, client, waits }) => {
        await assert.rejects(client.request('GET', '/x', { idempotent: true }), (error) => error.lost === true && /^The connection to the site was lost: [A-Z_]+$/.test(error.message));
        assert.equal(site.seen.length, 3, 'three tries, not a fourth');
        assert.deepEqual(waits, [1000, 2000]);
    });
});

test('a redirect of any kind is refused, saying where it pointed, and never followed', async () => {
    await withStub([{ status: 300, headers: { Location: 'https://elsewhere.test/p' } }, { status: 307 }], async ({ client }) => {
        await assert.rejects(client.request('GET', '/x'), (error) => error.status === 300 && error.message === 'The site answered with a redirect to https://elsewhere.test/p; give its address exactly with --url.');
        await assert.rejects(client.request('GET', '/x'), (error) => error.status === 307 && /redirect to elsewhere;/.test(error.message));
    });
});

test('a 503 asking for a minute exactly still waits; the wait is told; 502 and 504 are tried again only when safe, twice', async () => {
    const told = [];
    const site = await stub([{ status: 503, headers: { 'Retry-After': '60' } }, { status: 200 }, { status: 504 }, { status: 200 }, { status: 502 }, { status: 502 }, { status: 502 }, { status: 502 }]);
    try {
        const waits = [];
        const client = createClient({ baseUrl: site.url, key: KEY, sleep: async (ms) => { waits.push(ms); }, onWait: (wait) => told.push(wait) });
        assert.equal((await client.request('GET', '/x')).status, 200);
        assert.deepEqual(told, [{ status: 503, ms: 60000 }]);
        assert.equal((await client.request('GET', '/x', { idempotent: true })).status, 200, 'a 504 tried again');
        await assert.rejects(client.request('POST', '/x', { json: {} }), (error) => error.status === 502, 'not when unsafe');
        await assert.rejects(client.request('GET', '/x', { idempotent: true }), (error) => error.status === 502);
        assert.equal(site.seen.length, 8, '503+200, 504+200, one 502, then three');
        assert.deepEqual(waits, [60000, 1000, 1000, 2000]);
    } finally {
        await site.close();
    }
});

test('without a sleep of its own it waits for real', async () => {
    const site = await stub([{ status: 429, headers: { 'Retry-After': '1' } }, { status: 200 }]);
    try {
        const started = Date.now();
        assert.equal((await createClient({ baseUrl: site.url, key: KEY }).request('GET', '/x')).status, 200);
        assert.ok(Date.now() - started >= 900, 'about a second');
    } finally {
        await site.close();
    }
});

test('the key, and anything shaped like one, is taken out of messages', async () => {
    assert.equal(redact('nothing secret', ''), 'nothing secret', 'no key, nothing taken but what is shaped like one');
    assert.equal(redact('nothing secret'), 'nothing secret');
    assert.equal(redact(null), '');
    assert.equal(redact(undefined, KEY), '');
    assert.equal(redact('bad ' + KEY + ' and mk_test_abcdef1234', KEY), 'bad mk_… and mk_…');
    assert.equal(redact('oddly shaped: sekrit-123', 'sekrit-123'), 'oddly shaped: mk_…');
    await withStub([{ status: 401, body: { error: 'Invalid key ' + KEY } }], async ({ client }) => {
        await assert.rejects(client.request('GET', '/x'), (error) => !error.message.includes(KEY) && error.message.includes('mk_…'));
    });
});

test('a refusal whose JSON says nothing in words is told by its text; a 503 by its first 200 characters', async () => {
    const answers = [
        new Response('{"detail":"x"}', { status: 500 }),
        new Response('{"error":{"code":5}}', { status: 422 }),
        new Response('{"error":{"message":5}}', { status: 400 }),
        new Response('y'.repeat(300), { status: 503, headers: { 'retry-after': '120' } }),
    ];
    const client = createClient({ baseUrl: 'http://site.test', key: KEY, fetch: async () => answers.shift() });
    await assert.rejects(client.request('GET', '/a'), { message: '{"detail":"x"}' });
    await assert.rejects(client.request('GET', '/a'), { message: '{"error":{"code":5}}' });
    await assert.rejects(client.request('GET', '/a'), { message: '{"error":{"message":5}}' }, 'a message that is no text is not taken for one');
    await assert.rejects(client.request('GET', '/a'), { message: 'The site is unavailable for now: ' + 'y'.repeat(200) });
});

test('a connection lost with no cause says what was lost; an answer with no body at all is still read', async () => {
    const lost = createClient({ baseUrl: 'http://site.test', key: KEY, fetch: async () => { throw new Error('boom'); } });
    await assert.rejects(lost.request('POST', '/a'), (error) => error instanceof ApiError && error.lost && error.message === 'The connection to the site was lost: boom');
    const answers = [new Response(null, { status: 302, headers: { location: '/elsewhere' } }), new Response(null, { status: 502 }), new Response('{"ok":1}', { status: 200 })];
    const waits = [];
    const client = createClient({ baseUrl: 'http://site.test', key: KEY, fetch: async () => answers.shift(), sleep: async (ms) => { waits.push(ms); } });
    await assert.rejects(client.request('GET', '/a'), { message: 'The site answered with a redirect to /elsewhere; give its address exactly with --url.' });
    assert.deepEqual((await client.request('GET', '/a', { idempotent: true })).body, { ok: 1 });
    assert.deepEqual(waits, [1000]);
});
