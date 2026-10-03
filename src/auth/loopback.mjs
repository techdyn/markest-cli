/**
 * @module cli/auth/loopback
 * @description Where the browser hands the code back: a server on 127.0.0.1 -
 *              never another interface - on whatever port the system gives
 *              (RFC 8252 7.3), answering `/callback` once with a page that says
 *              to go back to the terminal, and nothing else. An answer without
 *              the state it was asked with is turned away and the wait goes
 *              on; one with it must name the issuer that sent it (RFC 9207).
 *              The server closes as soon as it has an answer, or when the wait
 *              runs out.
 *
 * @input The state asked with, the site's issuer, how long to wait
 * @output `{ ready, answer, close() }`: ready gives the redirect URI once listening; answer is
 *         `{ code }`, or `{ error, code? }`
 * @dependencies node:http
 */

import { createServer } from 'node:http';

const PAGE = (title, line) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2328;background:#fff}'
    + '@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}</style></head><body><h1>' + title + '</h1><p>' + line + '</p></body></html>';

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Why a sign-in came back without a code, in words. */
function refusal(error, description) {
    if (error === 'access_denied') return 'The sign-in was cancelled in the browser.';
    return 'The site refused the sign-in: ' + (description || error) + '.';
}

export function listen({ state, issuer, timeoutMs = 300000 }) {
    // A promise settles once: the first answer, the wait running out or a stop is the outcome
    let finish;
    const answer = new Promise((resolve) => { finish = resolve; });

    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method !== 'GET' || url.pathname !== '/callback') {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not here.');
            return;
        }
        const params = url.searchParams;
        // An answer to another sign-in - a page that found the port, say - is
        // turned away and the wait goes on, or anything could end it (found by
        // the review of 2026-10-02)
        if (params.get('state') !== state) {
            response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(PAGE('Not this sign-in', 'This is not the sign-in the command started. Go back to your terminal.'));
            return;
        }
        let outcome;
        // Markest names itself on every answer (RFC 9207), so an answer that does not is not its own
        if (params.get('iss') !== issuer) outcome = { error: params.has('iss') ? 'The answer came from ' + params.get('iss') + ', not ' + issuer + '.' : 'The answer did not say which site sent it.' };
        else if (params.has('error')) outcome = { error: refusal(params.get('error'), params.get('error_description')), code: params.get('error') };
        else if (!params.get('code')) outcome = { error: 'The answer held no code.' };
        else outcome = { code: params.get('code') };

        const signedIn = outcome.error === undefined;
        response.writeHead(signedIn ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(signedIn
            ? PAGE('Signed in to Markest', 'You can close this tab and go back to your terminal.')
            : PAGE('Not signed in', escapeHtml(outcome.error) + ' Go back to your terminal.'));
        finish(outcome);
    });

    const timer = setTimeout(() => finish({ error: 'No answer came from the browser in ' + Math.round(timeoutMs / 60000) + ' minutes.' }), timeoutMs);
    const close = () => {
        clearTimeout(timer);
        server.close();
        server.closeAllConnections();
    };
    answer.then(close);

    const listening = new Promise((resolve, reject) => {
        server.once('error', (error) => {
            finish({ error: error.message });
            reject(error);
        });
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

    return {
        ready: listening.then((port) => ({ redirectUri: 'http://127.0.0.1:' + port + '/callback' })),
        answer,
        close: () => finish({ error: 'Stopped.' }),
    };
}
