/**
 * @module cli/tests/support/fake-oauth
 * @description A stand-in for the site's OAuth server and one REST endpoint, on
 *              a real local port, behaving as the site's does (D-20261002-01,
 *              D-20261002-02): the consent screen answers with a code at once -
 *              or a refusal, as the test says - each code once and only with its
 *              PKCE verifier, refresh tokens rotated and a retired one refused,
 *              a device code pending until the test allows or cancels it,
 *              revocation ending a grant, and `GET /api/v1/pastes` answering only
 *              a live access token or a known key. Every request is recorded.
 *
 * @input `{ keys, scope, deviceInterval, deviceExpiresIn }` (null: a code that says nothing of its life)
 * @output `{ url, requests, ... }`: the controls a test turns, and close()
 * @dependencies node:http, node:crypto
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function startFakeOAuth({ keys = [], scope = 'pastes.read pastes.write', deviceInterval = 1, deviceExpiresIn = 600 } = {}) {
    const requests = [];
    const codes = new Map();
    const grants = new Map();
    const access = new Map();
    const devices = new Map();
    const state = { consent: 'allow', scope, tokensIssued: 0, refreshes: 0 };
    let base = '';

    const send = (res, status, body, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    };
    const oauthError = (res, error, description = error) => send(res, 400, { error, error_description: description });

    function issue(grant) {
        state.tokensIssued++;
        const token = 'eyJ' + b64({ alg: 'HS256' }).slice(3) + '.' + b64({ n: state.tokensIssued, g: grant.id }) + '.' + randomBytes(12).toString('base64url');
        const refresh = randomBytes(24).toString('hex');
        access.set(token, { grant: grant.id, live: true });
        grant.refresh = refresh;
        return { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: grant.scope };
    }

    function newGrant(resources) {
        const grant = { id: randomBytes(6).toString('hex'), scope: state.scope, resources, live: true, refresh: null };
        grants.set(grant.id, grant);
        return grant;
    }

    function handle(req, res, body) {
        const url = new URL(req.url, base);
        const form = new URLSearchParams(body);
        if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
            const redirect = url.searchParams.get('redirect_uri');
            const back = new URL(redirect);
            back.searchParams.set('state', url.searchParams.get('state') ?? '');
            back.searchParams.set('iss', base);
            if (state.consent === 'deny') {
                back.searchParams.set('error', 'access_denied');
            } else {
                const code = randomBytes(16).toString('hex');
                codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect, resources: url.searchParams.getAll('resource') });
                back.searchParams.set('code', code);
            }
            res.writeHead(302, { Location: back.toString() });
            return res.end();
        }
        if (req.method === 'POST' && url.pathname === '/oauth/token') {
            const grantType = form.get('grant_type');
            if (grantType === 'authorization_code') {
                const code = codes.get(form.get('code'));
                codes.delete(form.get('code'));
                if (!code) return oauthError(res, 'invalid_grant', 'This authorization code is unknown or has expired.');
                const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
                if (challenge !== code.challenge) return oauthError(res, 'invalid_grant', 'The PKCE code_verifier does not match the challenge.');
                if (form.get('redirect_uri') !== code.redirect) return oauthError(res, 'invalid_grant', 'redirect_uri does not match.');
                return send(res, 200, issue(newGrant(code.resources)));
            }
            if (grantType === 'refresh_token') {
                state.refreshes++;
                const grant = [...grants.values()].find((one) => one.refresh === form.get('refresh_token'));
                if (!grant || !grant.live) return oauthError(res, 'invalid_grant', 'This refresh token is unknown or has expired.');
                return send(res, 200, issue(grant));
            }
            if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
                const device = devices.get(form.get('device_code'));
                if (!device) return oauthError(res, 'expired_token');
                if (device.status === 'pending') {
                    device.asks++;
                    return oauthError(res, device.asks === 2 ? 'slow_down' : 'authorization_pending');
                }
                if (device.status === 'denied') return oauthError(res, 'access_denied', 'The sign-in was cancelled.');
                if (device.status === 'used') return oauthError(res, 'invalid_grant');
                device.status = 'used';
                return send(res, 200, issue(newGrant(device.resources)));
            }
            return oauthError(res, 'unsupported_grant_type');
        }
        if (req.method === 'POST' && url.pathname === '/oauth/device_authorization') {
            const code = randomBytes(32).toString('hex');
            const userCode = 'BCDF-GHJK';
            devices.set(code, { status: 'pending', asks: 0, resources: form.getAll('resource'), userCode });
            return send(res, 200, { device_code: code, user_code: userCode, verification_uri: base + '/oauth/device', verification_uri_complete: base + '/oauth/device?user_code=' + userCode, ...(deviceExpiresIn === null ? {} : { expires_in: deviceExpiresIn }), interval: deviceInterval });
        }
        if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
            const grant = [...grants.values()].find((one) => one.refresh === form.get('token'));
            if (grant) {
                grant.live = false;
                for (const one of access.values()) if (one.grant === grant.id) one.live = false;
            }
            return send(res, 200, {});
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/pastes') {
            const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
            const token = access.get(bearer);
            const grant = token ? grants.get(token.grant) : null;
            if (!(token?.live && grant?.live) && !keys.includes(bearer)) return send(res, 401, { error: 'Invalid API key.' });
            return send(res, 200, { pastes: [], total: 0, count: 0, offset: 0, has_more: false });
        }
        return send(res, 404, { error: 'No route ' + req.method + ' ' + url.pathname });
    }

    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const url = new URL(req.url, 'http://x');
            requests.push({ method: req.method, path: url.pathname, query: url.searchParams, form: new URLSearchParams(body), headers: req.headers });
            handle(req, res, body);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;

    return {
        url: base,
        requests,
        state,
        /** A browser that opens the address and follows the site's answer back to this machine, as a person allowing it would. */
        browser: async (address) => {
            const answer = await fetch(address, { redirect: 'manual' });
            const location = answer.headers.get('location');
            if (location) await fetch(location);
            return true;
        },
        allowDevice: () => { for (const device of devices.values()) device.status = 'allowed'; },
        denyDevice: () => { for (const device of devices.values()) device.status = 'denied'; },
        /** The grant's access tokens refused from now on, as when one lapses early. */
        expireAccess: () => { for (const one of access.values()) one.live = false; },
        endGrants: () => { for (const grant of grants.values()) grant.live = false; },
        liveGrants: () => [...grants.values()].filter((grant) => grant.live).length,
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
        }),
    };
}
