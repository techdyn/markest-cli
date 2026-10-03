/**
 * REGRESSION ANCHOR (D-20261002-04): where the browser hands the code back
 * (cli/auth/loopback) - 127.0.0.1 alone, on a port the system gives, /callback
 * once, an answer to another sign-in turned away while the wait goes on, the
 * code taken only from the issuer that names itself, and nothing left
 * listening.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Server, createServer, connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { listen } from '../src/auth/loopback.mjs';

const ISSUER = 'https://marke.st';

test('the operating system binds the callback to IPv4 loopback alone', async (t) => {
    const original = Server.prototype.listen;
    let server;
    t.mock.method(Server.prototype, 'listen', function (...args) {
        server = this;
        return original.apply(this, args);
    });
    const listener = listen({ state: 'S', issuer: ISSUER });
    t.after(() => listener.close());
    const { redirectUri } = await listener.ready;
    assert.deepEqual(server.address(), {
        address: '127.0.0.1', family: 'IPv4', port: Number(new URL(redirectUri).port),
    });
});

async function answered(query, { state = 'S', path = '/callback' } = {}) {
    const listener = listen({ state, issuer: ISSUER });
    const { redirectUri } = await listener.ready;
    const page = await fetch(redirectUri.replace('/callback', path) + '?' + new URLSearchParams(query));
    return { listener, redirectUri, page, text: await page.text() };
}

test('the code comes back to a port on 127.0.0.1 alone, and the page says to go back to the terminal', async () => {
    const { listener, redirectUri, page, text } = await answered({ code: 'C', state: 'S', iss: ISSUER });
    assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(text, /<h1>Signed in to Markest<\/h1><p>You can close this tab and go back to your terminal\.<\/p>/);
    assert.deepEqual(await listener.answer, { code: 'C' });
    await assert.rejects(fetch(redirectUri + '?code=X&state=S'), 'nothing is left listening');
});

test('an answer to another sign-in is turned away and the wait goes on (found by the review of 2026-10-02)', async () => {
    const listener = listen({ state: 'S', issuer: ISSUER });
    const { redirectUri } = await listener.ready;
    for (const query of ['?code=X&state=other&iss=' + ISSUER, '?error=access_denied', '?code=X']) {
        const page = await fetch(redirectUri + query);
        assert.equal(page.status, 400, query);
        assert.match(await page.text(), /This is not the sign-in the command started\. Go back to your terminal\./);
    }
    const settled = await Promise.race([listener.answer, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50))]);
    assert.equal(settled, 'still waiting', 'none of them ended it');
    await (await fetch(redirectUri + '?code=C&state=S&iss=' + encodeURIComponent(ISSUER))).text();
    assert.deepEqual(await listener.answer, { code: 'C' });
});

test('an answer from another issuer, or naming none, or with no code, is refused', async () => {
    const cases = [
        [{ code: 'C', state: 'S', iss: 'https://evil.example' }, 'The answer came from https://evil.example, not https://marke.st.'],
        [{ code: 'C', state: 'S' }, 'The answer did not say which site sent it.'],
        [{ state: 'S', iss: ISSUER }, 'The answer held no code.'],
        [{ state: 'S', iss: ISSUER, error: 'access_denied' }, 'The sign-in was cancelled in the browser.'],
        [{ state: 'S', iss: ISSUER, error: 'invalid_target', error_description: 'resource must be https://marke.st/mcp' }, 'The site refused the sign-in: resource must be https://marke.st/mcp.'],
        [{ state: 'S', iss: ISSUER, error: 'server_error' }, 'The site refused the sign-in: server_error.'],
    ];
    for (const [query, said] of cases) {
        const { listener, page, text } = await answered(query);
        assert.equal(page.status, 400, said);
        const outcome = await listener.answer;
        assert.equal(outcome.error, said);
        if (query.error) assert.equal(outcome.code, query.error, 'the OAuth refusal code is preserved');
        assert.ok(text.includes('Not signed in') && text.includes('Go back to your terminal.'), said);
    }
});

test('the page says what went wrong without letting it be read as markup', async () => {
    const { text } = await answered({ state: 'S', iss: ISSUER, error: 'x', error_description: '<script>alert(1)</script>"\'&' });
    assert.ok(!text.includes('<script>'));
    assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
});

test('anything but GET /callback is not answered, and the code is taken once', async () => {
    const listener = listen({ state: 'S', issuer: ISSUER });
    const { redirectUri } = await listener.ready;
    const other = await fetch(redirectUri.replace('/callback', '/favicon.ico'));
    assert.equal(other.status, 404);
    const posted = await fetch(redirectUri + '?code=C&state=S', { method: 'POST' });
    assert.equal(posted.status, 404);
    await (await fetch(redirectUri + '?code=C&state=S&iss=' + encodeURIComponent(ISSUER))).text();
    assert.deepEqual(await listener.answer, { code: 'C' });
});

test('a wait that runs out, or is stopped, says so', async () => {
    const slow = listen({ state: 'S', issuer: ISSUER, timeoutMs: 60000 * 2 + 20 });
    await slow.ready;
    slow.close();
    assert.deepEqual(await slow.answer, { error: 'Stopped.' });
    const short = listen({ state: 'S', issuer: ISSUER, timeoutMs: 30 });
    await short.ready;
    assert.deepEqual(await short.answer, { error: 'No answer came from the browser in 0 minutes.' });
    const minutes = listen({ state: 'S', issuer: ISSUER });
    await minutes.ready;
    minutes.close();
    assert.equal((await minutes.answer).error, 'Stopped.');
});

test('each page the listener answers is a whole page of its own, never cached; anything else is plain', async () => {
    const listener = listen({ state: 'S', issuer: ISSUER });
    const { redirectUri } = await listener.ready;

    const elsewhere = await fetch(redirectUri.replace('/callback', '/x'));
    assert.equal(elsewhere.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await elsewhere.text(), 'Not here.');

    const stray = await fetch(redirectUri + '?state=nope');
    assert.equal(stray.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(stray.headers.get('cache-control'), 'no-store');
    const strayText = await stray.text();
    assert.ok(strayText.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not this sign-in</title><style>body{'), strayText);
    assert.ok(strayText.endsWith('<h1>Not this sign-in</h1><p>This is not the sign-in the command started. Go back to your terminal.</p></body></html>'));

    const page = await fetch(redirectUri + '?code=C&state=S&iss=' + encodeURIComponent(ISSUER));
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await page.text(), /^<!doctype html>.*<title>Signed in to Markest<\/title><style>body\{font:16px\/1\.5 system-ui,sans-serif;.*@media \(prefers-color-scheme:dark\)/s);
    assert.deepEqual(await listener.answer, { code: 'C' });
});

test('closing the callback clears its timer so the command exits naturally', () => {
    const module = new URL('../src/auth/loopback.mjs', import.meta.url).href;
    const program = 'const { listen } = await import(' + JSON.stringify(module) + '); const one = listen({ state: "S", issuer: "https://example.invalid" }); await one.ready; one.close(); await one.answer;';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { timeout: 2000, encoding: 'utf8' });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
});

test('closing the callback also closes a connection still sending its request', async (t) => {
    const listener = listen({ state: 'S', issuer: ISSUER });
    t.after(() => listener.close());
    const { redirectUri } = await listener.ready;
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(redirectUri).port) });
    t.after(() => socket.destroy());
    const errors = [];
    socket.on('error', (error) => errors.push(error.code));
    await once(socket, 'connect');
    socket.write('GET /callback HTTP/1.1\r\nHost: localhost\r\n');
    const closed = new Promise((resolve) => socket.once('close', () => resolve('closed')));
    listener.close();
    assert.equal(await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('still connected'), 250))]), 'closed');
    assert.ok(errors.every((code) => code === 'ECONNRESET'), 'a forced close may reset the connection');
});

test('a callback that cannot bind reports the failure and ends its wait', async (t) => {
    const occupied = createServer();
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    t.after(() => occupied.close());
    const port = occupied.address().port;
    const original = Server.prototype.listen;
    t.mock.method(Server.prototype, 'listen', function (...args) {
        return original.call(this, port, '127.0.0.1', args.at(-1));
    });
    const listener = listen({ state: 'S', issuer: ISSUER });
    t.after(() => listener.close());
    await assert.rejects(listener.ready, (error) => error.code === 'EADDRINUSE');
    const outcome = await Promise.race([listener.answer, new Promise((resolve) => setTimeout(() => resolve({ error: 'still waiting' }), 50))]);
    assert.match(outcome.error, /EADDRINUSE/, 'the failed listener leaves no five-minute wait');
});
