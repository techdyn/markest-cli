/**
 * @module cli/reading/artifact-source
 * @description An artifact's documents as the site hands them over. With a key,
 *              through the REST API - which reads what the key may: its own,
 *              its workspace's, or anything public or unlisted. With none,
 *              through the public API, as a browser would read it, carrying a
 *              signed link's `exp` and `sig` so a private artifact shared that
 *              way opens too. Either way a document is its path, title, type and
 *              text exactly as stored - an envelope, for one encrypted end to
 *              end, which is the sealing's to open.
 *
 * @input A client; `{ id, reference, keyed, format, pick }`
 * @output `{ id, title, defaultPath, sealed, documents: [{ path, title, contentType, content }] }`
 * @dependencies cli/shared
 */

import { isEnvelope } from '../shared.mjs';

/** A signed link's `exp` and `sig`, which every request about its artifact carries. */
export function signedQuery(reference) {
    let url;
    try {
        // Stryker disable next-line StringLiteral: equivalent - no reference is no address either way
        url = new URL(String(reference ?? ''));
    } catch {
        return {};
    }
    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');
    return exp !== null && sig !== null ? { exp, sig } : {};
}

/** The document a reference's address names, if it names one: `/p/<id>/<path>`. */
export function pathIn(reference, id) {
    let url;
    try {
        // Stryker disable next-line StringLiteral: equivalent - no reference is no address either way
        url = new URL(String(reference ?? ''));
    } catch {
        return null;
    }
    // Stryker disable next-line StringLiteral: equivalent - an id has one length, so its address with no path after names none
    const at = url.pathname.toUpperCase().indexOf('/P/' + id + '/');
    if (at === -1) return null;
    const rest = url.pathname.slice(at + 4 + id.length);
    if (rest === '') return null;
    try {
        return decodeURIComponent(rest);
    } catch {
        return rest;
    }
}

/** Which document opens: the one asked for, else the one it opens on, else its first. */
export function chooseDocument(artifact, asked) {
    const paths = artifact.documents.map((doc) => doc.path);
    if (asked !== null && asked !== undefined) return paths.includes(asked) ? asked : null;
    if (artifact.defaultPath && paths.includes(artifact.defaultPath)) return artifact.defaultPath;
    return paths[0] ?? null;
}

/** Which documents to fetch: every one, or the one it opens on; a path names one. */
export const ALL = Symbol('every document');
export const OPENING = Symbol('the document it opens on');

/**
 * The artifact, with every document's text or only the chosen one's - the
 * others listed with no text - as the public API is asked one at a time.
 */
// Stryker disable next-line StringLiteral: equivalent - no reference and an empty one carry no signature alike
export async function fetchArtifact(client, { id, reference = null, keyed, format = 'stored', pick = ALL }) {
    if (keyed) {
        const query = format === 'markdown' ? { format: 'markdown' } : {};
        const body = (await client.request('GET', '/api/v1/pastes/' + id, { query, idempotent: true })).body;
        return {
            id,
            title: body.title ?? null,
            defaultPath: body.default_path ?? null,
            sealed: Boolean(body.sealed),
            documents: (body.documents ?? []).map((doc) => ({ path: doc.path, title: doc.title ?? null, contentType: doc.content_type, content: String(doc.content ?? '') })),
        };
    }
    const signed = signedQuery(reference);
    const manifest = (await client.request('GET', '/api/p/' + id + '/manifest', { query: signed, idempotent: true })).body;
    const artifact = {
        id,
        title: manifest.title ?? null,
        defaultPath: manifest.defaultPath ?? null,
        documents: (manifest.documents ?? []).map((doc) => ({ path: doc.path, title: doc.title ?? null, contentType: doc.contentType, content: null })),
    };
    // Stryker disable next-line ConditionalExpression: equivalent - with every document asked for, none is chosen
    const chosen = pick === ALL ? null : chooseDocument(artifact, pick === OPENING ? null : pick);
    for (const doc of artifact.documents) {
        if (pick !== ALL && doc.path !== chosen) continue;
        // Stryker disable next-line StringLiteral: equivalent - the site hands a document over as text whatever is accepted
        const raw = await client.request('GET', '/api/p/' + id + '/doc', { query: { ...signed, path: doc.path }, accept: 'text/plain, text/markdown, */*', idempotent: true });
        doc.content = raw.text;
    }
    // The public manifest does not say; its envelopes do
    const fetched = artifact.documents.filter((doc) => doc.content !== null);
    artifact.sealed = fetched.length > 0 && fetched.every((doc) => isEnvelope(doc.content));
    return artifact;
}
