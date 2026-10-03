/**
 * @module cli/core/command-kit
 * @description What the commands that speak to the site share: the artifacts
 *              named on the command line, by id or by any of their addresses;
 *              the clients a run uses, the REST API's and the agent tools'; one
 *              way to answer - one JSON object with `--json`, else the command's
 *              own words - with a refusal from the site said as it was said and
 *              exit 1; lengths of time as people type them (30m, 2h, 7d, 4w,
 *              never); and what was piped in.
 *
 * @input What was typed; a run's context `{ key, baseUrl, fetch, version, json, stdout, stderr, stdin }`
 * @output Ids or a usage error; clients; the exit code
 * @dependencies cli/core/site-args, cli/core/api-client, cli/core/agent-client, cli/core/output
 */

import { pasteIdFrom } from './site-args.mjs';
import { ApiError, createClient } from './api-client.mjs';
import { AgentError, createAgent } from './agent-client.mjs';
import { EXIT, jsonLine, printable } from './output.mjs';

/** The artifacts named, as ids, or why they cannot be. */
export function artifactsFrom(references, { usage, min = 1, max = 1 }) {
    if (references.length < min) return { usageError: 'Name the artifact: ' + usage };
    if (references.length > max) return { usageError: 'Too many arguments: ' + usage };
    const ids = [];
    for (const reference of references) {
        const id = pasteIdFrom(reference);
        // Said back without its fragment, where a key would be
        if (id === null) return { usageError: '"' + String(reference).split('#')[0] + '" is not an artifact\'s id or address' };
        ids.push(id);
    }
    return { ids };
}

/** Whether a run speaks to the site as an account: signed in, or with an API key. */
export function hasCredential(ctx) {
    return Boolean(ctx.auth?.present || ctx.key);
}

/** The clients one run speaks to the site with, carrying its sign-in or its key. */
export function clientsFor(ctx) {
    const rest = createClient({
        baseUrl: ctx.baseUrl,
        key: ctx.key ?? '',
        auth: ctx.auth?.present ? ctx.auth : null,
        fetch: ctx.fetch,
        version: ctx.version,
        onWait: ({ status, ms }) => ctx.stderr.write('The site asked to wait (' + status + '); trying again in ' + Math.round(ms / 1000) + ' s.\n'),
    });
    return { rest, agent: createAgent(rest) };
}

/** A command's own refusal, said as the site's are: exit 1, nothing more done. */
export class Refused extends Error {}

/** Whether an error is a refusal - the site's or a command's - to be said as it was said. */
export function isRefusal(error) {
    return error instanceof ApiError || error instanceof AgentError || error instanceof Refused;
}

/**
 * Do the work and answer: its value as one line of JSON with `--json`, else
 * what `render` makes of it. The site's refusal is said, and is exit 1;
 * anything else goes up to main.
 */
export async function answer(ctx, work, render = () => '') {
    let value;
    try {
        value = await work();
    } catch (error) {
        if (!isRefusal(error)) throw error;
        if (ctx.json) ctx.stdout.write(jsonLine({ error: error.message, status: error.status || null }));
        ctx.stderr.write('markest: ' + printable(error.message) + '\n');
        return EXIT.FAILED;
    }
    ctx.stdout.write(ctx.json ? jsonLine(value) : render(value));
    return EXIT.OK;
}

const UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** A length of time as seconds: `never` or 0 is none; a number alone is seconds. Null for anything else. */
export function secondsFrom(text) {
    // Stryker disable next-line StringLiteral: equivalent - nothing given is no length either way
    const value = String(text ?? '').trim().toLowerCase();
    if (value === 'never') return 0;
    const match = /^(\d{1,9})([smhdw]?)$/.exec(value);
    if (!match) return null;
    return Number(match[1]) * UNITS[match[2] || 's'];
}

/** Everything piped in, as text. */
export async function readAll(stream) {
    if (!stream) return '';
    const chunks = [];
    // Stryker disable next-line ConditionalExpression: equivalent - Buffer.from copies a buffer as it is
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString('utf8');
}

/** A date as people read it: the day and the minute, in UTC. */
export function when(iso) {
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent - an empty date is no date, said back as it came
    if (typeof iso !== 'string' || iso === '') return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 16).replace('T', ' ');
}
