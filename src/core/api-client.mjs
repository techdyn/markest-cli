/**
 * @module cli/api-client
 * @description The tool's requests to the site. Each carries the key as a
 *              Bearer token, and one made with no key carries no credential; no
 *              redirect is followed, so the key never goes to another address. A 429 waits as long as `Retry-After` asks (5 s
 *              when it says nothing, a minute at most, editor/image-transfer's
 *              rule) and is tried again, up to five times; a 503 does too, unless
 *              it asks for longer than a minute - the site is being updated -
 *              when the command stops and says so. A lost connection, a 502 or a
 *              504 is tried again twice, and only for a request that is safe to
 *              repeat. The key, and anything shaped like one, is removed from
 *              every message the client passes on.
 *
 * @input `{ baseUrl, key, fetch, sleep, timeoutMs, onWait, version }`
 * @output `{ request(method, path, options) -> { status, body, text }, requests }`; ApiError
 * @dependencies cli/shared
 */

import { retryAfterMs } from '../shared.mjs';

const KEY_SHAPE = /mk_[a-z]+_[0-9a-f]{8,}/g;
const MAX_WAITS = 5;
const MAX_WAIT_SECONDS = 60;
const RETRIES = [1000, 2000];

export class ApiError extends Error {
    constructor(message, { status = 0, body = null, lost = false } = {}) {
        super(message);
        this.status = status;
        this.body = body;
        this.lost = lost;
    }
}

/** A message with the key, and anything shaped like one, taken out. */
// Stryker disable next-line StringLiteral: equivalent - every caller passes the client's key, so the default is never read
export function redact(text, key = '') {
    let out = String(text ?? '');
    if (key !== '') out = out.split(key).join('mk_…');
    return out.replace(KEY_SHAPE, 'mk_…');
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a refusal says: the REST API's `error`, or a JSON-RPC error's `message`. */
function messageOf(parsed) {
    const error = parsed?.error;
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    return null;
}

export function createClient({ baseUrl, key, fetch = globalThis.fetch, sleep = pause, timeoutMs = 120000, onWait = () => {}, version = '0' }) {
    const client = { requests: 0 };

    async function once(method, path, { json, body, contentType, query, accept, headers: extra }) {
        const url = new URL(baseUrl + path);
        for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
        const headers = {
            Accept: accept ?? 'application/json',
            'User-Agent': 'markest-cli/' + version + ' node/' + process.version,
            ...(extra ?? {}),
        };
        // No key, no credential: what needs none - a draft, a public read - goes without one
        if (key !== '') headers.Authorization = 'Bearer ' + key;
        let payload = body;
        if (json !== undefined) {
            payload = JSON.stringify(json);
            headers['Content-Type'] = 'application/json';
        } else if (contentType) {
            headers['Content-Type'] = contentType;
        }
        client.requests++;
        return fetch(url, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    }

    async function answerOf(response) {
        const text = await response.text();
        let parsed = null;
        try {
            // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent - JSON.parse refuses an empty text, which the catch reads as nothing too
            parsed = text === '' ? null : JSON.parse(text);
        } catch {
            // Not JSON: the answer is its text alone, and parsed stays null
        }
        return { text, parsed };
    }

    client.request = async function request(method, path, options = {}) {
        let waits = 0;
        let retries = 0;
        for (;;) {
            let response;
            try {
                response = await once(method, path, options);
            } catch (error) {
                if (options.idempotent && retries < RETRIES.length) {
                    await sleep(RETRIES[retries++]);
                    continue;
                }
                throw new ApiError(redact('The connection to the site was lost: ' + (error.cause?.code ?? error.message), key), { lost: true });
            }
            const status = response.status;
            if (status >= 300 && status < 400) {
                await response.body?.cancel();
                throw new ApiError('The site answered with a redirect to ' + redact(response.headers.get('location') ?? 'elsewhere', key)
                    + '; give its address exactly with --url.', { status });
            }
            if (status === 429 || status === 503) {
                const seconds = Number(response.headers.get('retry-after'));
                const { text, parsed } = await answerOf(response);
                const message = redact(messageOf(parsed) ?? text.slice(0, 200), key);
                if ((status === 503 && Number.isFinite(seconds) && seconds > MAX_WAIT_SECONDS) || waits >= MAX_WAITS) {
                    throw new ApiError(status === 503 ? 'The site is unavailable for now: ' + message : 'Too many requests: ' + message, { status, body: parsed });
                }
                const wait = retryAfterMs(response.headers.get('retry-after'));
                onWait({ status, ms: wait });
                waits++;
                await sleep(wait);
                continue;
            }
            if ((status === 502 || status === 504) && options.idempotent && retries < RETRIES.length) {
                await response.body?.cancel();
                await sleep(RETRIES[retries++]);
                continue;
            }
            const { text, parsed } = await answerOf(response);
            // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent - fetch hands over no status under 200, and a 300 is a redirect, refused above
            if (status >= 200 && status < 300) return { status, body: parsed, text };
            throw new ApiError(redact(messageOf(parsed) ?? (text.slice(0, 200) || 'HTTP ' + status), key), { status, body: parsed });
        }
    };

    return client;
}
