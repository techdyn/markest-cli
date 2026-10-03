/**
 * REGRESSION ANCHOR (D-20261002-04): the command's side of OAuth
 * (cli/auth/oauth) - the client Markest publishes for it, both places and both
 * scopes asked for, PKCE S256, every exchange a form that follows no redirect,
 * a refusal said with its OAuth code, a code waited for at the site's interval
 * and slower when told, and a sign-in ended on the site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    AuthError, DEVICE_GRANT, SCOPES, authorizeUrl, clientIdFor, exchangeCode, newState, pkce, pollDevice,
    refreshTokens, resourcesFor, revoke, startDevice,
} from '../src/auth/oauth.mjs';

const SITE = 'https://marke.st';

/** A fetch that records each request and answers from a list. */
function server(...answers) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, init, form: new URLSearchParams(init.body) });
        const answer = answers.shift() ?? { status: 200, body: {} };
        if (answer.throws) throw answer.throws;
        return new Response(answer.text ?? JSON.stringify(answer.body), { status: answer.status ?? 200 });
    };
    return { fetch, calls };
}

test('the command is the client Markest publishes for it, asking for both places', () => {
    assert.equal(clientIdFor(SITE), 'https://marke.st/.well-known/oauth-client-metadata/markest-cli.json');
    assert.deepEqual(resourcesFor(SITE), ['https://marke.st/mcp', 'https://marke.st/api/v1']);
    assert.equal(SCOPES, 'pastes.read pastes.write');
    assert.equal(DEVICE_GRANT, 'urn:ietf:params:oauth:grant-type:device_code');
});

test('PKCE is S256 of a fresh verifier, and every state is new', () => {
    const one = pkce();
    assert.match(one.verifier, /^[\w-]{43}$/);
    assert.equal(one.challenge, createHash('sha256').update(one.verifier).digest('base64url'));
    assert.notEqual(pkce().verifier, one.verifier);
    assert.match(newState(), /^[\w-]{22}$/);
    assert.notEqual(newState(), newState());
});

test('the authorization address asks for a code, both scopes, PKCE and each place once', () => {
    const url = new URL(authorizeUrl({ site: SITE, redirectUri: 'http://127.0.0.1:5/callback', state: 's', challenge: 'c' }));
    assert.equal(url.origin + url.pathname, 'https://marke.st/oauth/authorize');
    const q = url.searchParams;
    assert.deepEqual([q.get('response_type'), q.get('client_id'), q.get('redirect_uri'), q.get('scope'), q.get('state'), q.get('code_challenge'), q.get('code_challenge_method')],
        ['code', clientIdFor(SITE), 'http://127.0.0.1:5/callback', SCOPES, 's', 'c', 'S256']);
    assert.deepEqual(q.getAll('resource'), resourcesFor(SITE));
});

test('a code is exchanged as a form, following no redirect, for its tokens', async () => {
    const { fetch, calls } = server({ body: { access_token: 'a', refresh_token: 'r' } });
    assert.deepEqual(await exchangeCode({ site: SITE, code: 'k', verifier: 'v', redirectUri: 'http://127.0.0.1:5/callback', fetch, version: '9' }), { access_token: 'a', refresh_token: 'r' });
    const [call] = calls;
    assert.equal(call.url, 'https://marke.st/oauth/token');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.match(call.init.headers['User-Agent'], /^markest-cli\/9 node\//);
    assert.deepEqual(Object.fromEntries(call.form), { grant_type: 'authorization_code', code: 'k', client_id: clientIdFor(SITE), redirect_uri: 'http://127.0.0.1:5/callback', code_verifier: 'v' });
});

test('a refresh asks for every place its grant holds, by naming none', async () => {
    const { fetch, calls } = server({ body: { access_token: 'b' } });
    await refreshTokens({ site: SITE, refreshToken: 'r', fetch });
    assert.deepEqual(Object.fromEntries(calls[0].form), { grant_type: 'refresh_token', refresh_token: 'r', client_id: clientIdFor(SITE) });
    assert.deepEqual(calls[0].form.getAll('resource'), []);
});

test('a refusal is said with its OAuth code and description, and anything else by its status', async () => {
    const refused = server({ status: 400, body: { error: 'invalid_grant', error_description: 'This refresh token has already been used.' } });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: refused.fetch }), (error) => error instanceof AuthError && error.code === 'invalid_grant' && error.status === 400 && error.message === 'This refresh token has already been used.');
    const bare = server({ status: 400, body: { error: 'invalid_client' } });
    await assert.rejects(startDevice({ site: SITE, fetch: bare.fetch }), (error) => error.message === 'invalid_client' && error.code === 'invalid_client');
    const html = server({ status: 502, text: '<html>Bad gateway</html>' });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: html.fetch }), (error) => error.message === 'HTTP 502' && error.code === null);
    const empty = server({ status: 200, text: '' });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: empty.fetch }), /HTTP 200/);
    const redirected = server({ status: 302, text: '' });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: redirected.fetch }), /HTTP 302/);
    const lost = server({ throws: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: lost.fetch }), /The connection to the site was lost: ECONNREFUSED/);
    const vague = server({ throws: new Error('socket hang up') });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: vague.fetch }), /lost: socket hang up/);
});

test('a code to show is asked for with both places and both scopes', async () => {
    const { fetch, calls } = server({ body: { device_code: 'd', user_code: 'BCDF-GHJK' } });
    assert.equal((await startDevice({ site: SITE, fetch })).user_code, 'BCDF-GHJK');
    assert.equal(calls[0].url, 'https://marke.st/oauth/device_authorization');
    assert.equal(calls[0].form.get('client_id'), clientIdFor(SITE));
    assert.equal(calls[0].form.get('scope'), SCOPES);
    assert.deepEqual(calls[0].form.getAll('resource'), resourcesFor(SITE));
});

test('a code is waited for at the interval, five seconds slower when told, until its tokens come', async () => {
    const waits = [];
    const { fetch, calls } = server(
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        { status: 400, body: { error: 'authorization_pending' } },
        { body: { access_token: 'a' } },
    );
    const tokens = await pollDevice({ site: SITE, device: { device_code: 'd', interval: 2, expires_in: 600 }, fetch, sleep: async (ms) => { waits.push(ms); } });
    assert.deepEqual(tokens, { access_token: 'a' });
    assert.deepEqual(waits, [2000, 2000, 7000, 7000]);
    assert.deepEqual(Object.fromEntries(calls[0].form), { grant_type: DEVICE_GRANT, device_code: 'd', client_id: clientIdFor(SITE) });
});

test('a code cancelled or expired at the site ends the wait, and so does running out of time', async () => {
    const cancelled = server({ status: 400, body: { error: 'access_denied', error_description: 'The sign-in was cancelled.' } });
    await assert.rejects(pollDevice({ site: SITE, device: { device_code: 'd' }, fetch: cancelled.fetch, sleep: async () => {} }), (error) => error.code === 'access_denied');
    let clock = 0;
    const pending = server(...Array.from({ length: 10 }, () => ({ status: 400, body: { error: 'authorization_pending' } })));
    await assert.rejects(pollDevice({ site: SITE, device: { device_code: 'd', interval: 1, expires_in: 3 }, fetch: pending.fetch, now: () => clock, sleep: async (ms) => { clock += ms; } }),
        (error) => error.code === 'expired_token' && /expired before it was entered\. Run markest login again\./.test(error.message));
    assert.equal(pending.calls.length, 3, 'asked once a second - never faster - until the code lapsed');
    const broken = { fetch: async () => { throw new RangeError('not an AuthError'); } };
    await assert.rejects(pollDevice({ site: SITE, device: { device_code: 'd' }, fetch: broken.fetch, sleep: async () => {} }), /lost: not an AuthError/);
});

test('a code is waited for five seconds by default, ten minutes at most', async () => {
    const waits = [];
    let clock = 0;
    const { fetch } = server(...Array.from({ length: 200 }, () => ({ status: 400, body: { error: 'authorization_pending' } })));
    await assert.rejects(pollDevice({ site: SITE, device: { device_code: 'd' }, fetch, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } }), /expired/);
    assert.equal(waits[0], 5000);
    assert.equal(waits.length, 120);
});

test('a sign-in is ended on the site with its refresh token', async () => {
    const { fetch, calls } = server({ body: {} });
    await revoke({ site: SITE, token: 'r', fetch });
    assert.equal(calls[0].url, 'https://marke.st/oauth/revoke');
    assert.deepEqual(Object.fromEntries(calls[0].form), { token: 'r', token_type_hint: 'refresh_token', client_id: clientIdFor(SITE) });
});

test('a request names the command\'s version, 0 when none is known', async () => {
    const { fetch, calls } = server({ body: { access_token: 'a' } });
    await refreshTokens({ site: SITE, refreshToken: 'r', fetch });
    assert.match(calls[0].init.headers['User-Agent'], /^markest-cli\/0 node\/v/);
});

test('only a 2xx answer holding an object is taken: a 300, or a JSON that is no object, is refused', async () => {
    const three = server({ status: 300, body: { access_token: 'a' } });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: three.fetch }), (error) => error.message === 'HTTP 300');
    const number = server({ status: 200, text: '5' });
    await assert.rejects(refreshTokens({ site: SITE, refreshToken: 'r', fetch: number.fetch }), (error) => error.message === 'HTTP 200');
    const twoNineNine = server({ status: 299, body: { access_token: 'b' } });
    assert.deepEqual(await refreshTokens({ site: SITE, refreshToken: 'r', fetch: twoNineNine.fetch }), { access_token: 'b' });
});

test('waiting for a code takes its own pause when it is given none', async () => {
    const { fetch } = server({ body: { access_token: 'a' } });
    const started = Date.now();
    assert.deepEqual(await pollDevice({ site: SITE, device: { device_code: 'd', interval: 1 }, fetch }), { access_token: 'a' });
    assert.ok(Date.now() - started >= 900, 'it waited the interval before asking');
});
