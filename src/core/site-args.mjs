/**
 * @module cli/core/site-args
 * @description What every command reads the same way: its flags beside the
 *              ones every command takes, the site - https, or http to this
 *              machine alone, so a key never travels in the clear - the API key,
 *              from the environment only, never a flag, so it stays out of shell
 *              history and process lists, and an artifact named by its id or by
 *              any of its addresses. Pure.
 *
 * @input argv; the environment; a reference to an artifact
 * @output `{ values, positionals }` or `{ usageError }`; the site's origin; the key; an id
 * @dependencies node:util
 */

import { parseArgs } from 'node:util';

export const DEFAULT_URL = 'https://marke.st';
export const VISIBILITIES = ['public', 'unlisted', 'private'];

/** The flags every command takes. */
export const GLOBAL_FLAGS = Object.freeze({
    url: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
});

/** A paste id: 26 characters of Crockford's alphabet (PasteUrlParser::ID_PATTERN). */
const ID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
/** The path segments a site address carries an id after (`/api/p/<id>` and `/api/v1/pastes/<id>` among them). */
const ID_ROUTES = new Set(['p', 'r', 'h', 'embed', 'pastes', 'artifacts']);
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The id in a bare id or in a site address naming an artifact, else null. */
export function pasteIdFrom(reference) {
    // Stryker disable next-line StringLiteral: equivalent - null or undefined is no id either way
    const text = String(reference ?? '').trim();
    if (ID.test(text)) return text.toUpperCase();
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    const segments = url.pathname.split('/');
    // Stryker disable next-line EqualityOperator,ArithmeticOperator: equivalent - past the last segment there is nothing to test
    for (let i = 0; i < segments.length - 1; i++) {
        if (ID_ROUTES.has(segments[i]) && ID.test(segments[i + 1])) return segments[i + 1].toUpperCase();
    }
    return null;
}

/** The site's origin with no trailing slash, or an error when the key could travel in the clear. */
export function siteUrl(raw) {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        return { error: 'The site address is not a URL: ' + raw };
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
        return { error: 'The site must be reached over https (http only to this machine): ' + url.origin };
    }
    return { url: url.origin };
}

/** The site a command speaks to: `--url`, else MARKEST_URL, else marke.st. */
export function siteFrom(values, env = {}) {
    return siteUrl(values.url ?? env.MARKEST_URL ?? DEFAULT_URL);
}

/** The API key, from the environment alone. */
export function keyFrom(env = {}) {
    return String(env.MARKEST_API_KEY || env.MARKEST_KEY || '');
}

/** A command's arguments read against its own flags and every command's. */
export function readFlags(argv, flags = {}) {
    try {
        const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL_FLAGS, ...flags }, allowPositionals: true, strict: true });
        return { values, positionals };
    } catch (error) {
        return { usageError: error.message };
    }
}

/** A visibility flag's value, or a usage error naming the choices. */
export function visibilityFrom(value, allowed = VISIBILITIES, flag = '--visibility') {
    if (value === undefined || value === null) return { visibility: null };
    if (!allowed.includes(value)) return { usageError: flag + ' is one of ' + allowed.join(', ') };
    return { visibility: value };
}
