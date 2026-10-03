/**
 * @module cli/auth/oauth
 * @description The command's side of signing in to Markest over OAuth 2.1
 *              (D-20261002-04): it is the client Markest publishes a document
 *              for (`markest-cli`), asks for the agent tools and the REST API at
 *              once - `resource` once for each (RFC 8707, D-20261002-01) - with
 *              both scopes, and proves each code with PKCE (S256). A code comes
 *              back to a port on this machine; where no browser opens, a code is
 *              shown for its person to type at marke.st and the site is asked
 *              until it is (RFC 8628, D-20261002-02). Tokens are refreshed, and
 *              a sign-in is ended on the site (RFC 7009). Every request is a
 *              form, follows no redirect, and is said back without a token.
 *
 * @input The site; what each step needs; a fetch and a sleep
 * @output The authorization address; token responses; AuthError
 * @dependencies node:crypto
 */

import { createHash, randomBytes } from 'node:crypto';

/** Both scopes: the person signing in may untick one. */
export const SCOPES = 'pastes.read pastes.write';

/** The device code grant (RFC 8628). */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The client Markest publishes for this command, on the site signed in to. */
export const clientIdFor = (site) => site + '/.well-known/oauth-client-metadata/markest-cli.json';

/** The places a token is for: the agent tools and the REST API. */
export const resourcesFor = (site) => [site + '/mcp', site + '/api/v1'];

/** A refusal from the authorization server: its OAuth error code, and why. */
export class AuthError extends Error {
    constructor(message, { code = null, status = 0 } = {}) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const base64url = (bytes) => bytes.toString('base64url');

/** A PKCE verifier and its S256 challenge. */
export function pkce() {
    const verifier = base64url(randomBytes(32));
    return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** A state to match the answer to the question. */
export const newState = () => base64url(randomBytes(16));

/** The address the browser is sent to. */
export function authorizeUrl({ site, redirectUri, state, challenge }) {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientIdFor(site),
        redirect_uri: redirectUri,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    for (const resource of resourcesFor(site)) query.append('resource', resource);
    return site + '/oauth/authorize?' + query.toString();
}

/** A form POST to the authorization server: its JSON answer, or the refusal it said. */
async function post(site, path, fields, { fetch = globalThis.fetch, version = '0', resources = false } = {}) {
    const form = new URLSearchParams(fields);
    if (resources) for (const resource of resourcesFor(site)) form.append('resource', resource);
    let response;
    try {
        response = await fetch(site + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'markest-cli/' + version + ' node/' + process.version },
            body: form.toString(),
            redirect: 'manual',
            signal: AbortSignal.timeout(30000),
        });
    } catch (error) {
        throw new AuthError('The connection to the site was lost: ' + (error.cause?.code ?? error.message));
    }
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text === '' ? null : JSON.parse(text);
    } catch {
        // Not JSON: refused below by its status
    }
    // fetch hands over no status under 200; a redirect is never followed, so a 3xx is a refusal
    if (response.status < 300 && parsed !== null && typeof parsed === 'object') return parsed;
    const code = typeof parsed?.error === 'string' ? parsed.error : null;
    const why = typeof parsed?.error_description === 'string' ? parsed.error_description : (code ?? 'HTTP ' + response.status);
    throw new AuthError(why, { code, status: response.status });
}

/** The tokens a code is exchanged for, as it came back to this machine. */
export function exchangeCode({ site, code, verifier, redirectUri, ...options }) {
    return post(site, '/oauth/token', { grant_type: 'authorization_code', code, client_id: clientIdFor(site), redirect_uri: redirectUri, code_verifier: verifier }, options);
}

/** A fresh pair for a refresh token, for every place its grant holds. */
export function refreshTokens({ site, refreshToken, ...options }) {
    return post(site, '/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientIdFor(site) }, options);
}

/** A code to show, where no browser opens. */
export function startDevice({ site, ...options }) {
    return post(site, '/oauth/device_authorization', { client_id: clientIdFor(site), scope: SCOPES }, { ...options, resources: true });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the site at its interval until the code is typed and allowed: its
 * tokens, or why not - cancelled, expired - as an AuthError.
 */
export async function pollDevice({ site, device, sleep = pause, now = Date.now, ...options }) {
    let interval = Math.max(1, Number(device.interval) || 5);
    const until = now() + (Number(device.expires_in) || 600) * 1000;
    for (;;) {
        await sleep(interval * 1000);
        try {
            return await post(site, '/oauth/token', { grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: clientIdFor(site) }, options);
        } catch (error) {
            // Only the waiting answers go on; anything else, the site's or not, ends the wait
            if (error.code === 'slow_down') interval += 5;
            else if (error.code !== 'authorization_pending') throw error;
            if (now() >= until) throw new AuthError('The code expired before it was entered. Run markest login again.', { code: 'expired_token' });
        }
    }
}

/** End a sign-in on the site: its refresh token and every access token from it. */
export async function revoke({ site, token, ...options }) {
    await post(site, '/oauth/revoke', { token, token_type_hint: 'refresh_token', client_id: clientIdFor(site) }, options);
}
