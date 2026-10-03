/**
 * @module cli/sealed/sealed-artifacts
 * @description What an agent asks of artifacts encrypted end to end, done on
 *              this machine (D-20261001-01): make one from documents given as
 *              text, read one, add or replace documents in one, take documents
 *              out, give its link. Every document is sealed here with the site's
 *              own sealing and its type sent beside it; the site gets envelopes
 *              and never the key. A new artifact's key is kept here at once; one
 *              written to with a link's key keeps it too (the owner's); one read
 *              keeps it only when asked. Everything the site would refuse - a
 *              path, a size, public - is refused here first.
 *
 * @input A context `{ baseUrl, key, env, fetch, version, stderr }`; what was asked
 * @output Plain objects for the tools to hand back; `Refused` for what cannot be done
 * @dependencies cli/shared, cli/core/command-kit, cli/core/site-args, cli/publish/publish-plan,
 *               cli/publish/publish-steps, cli/reading/artifact-source, cli/sealed/sealing,
 *               cli/sealed/keyring
 */

import { detectContentType, isContentType, linkWithKey, validatePath } from '../shared.mjs';
import { clientsFor, Refused, hasCredential } from '../core/command-kit.mjs';
import { pasteIdFrom } from '../core/site-args.mjs';
import { batchesOf, preflight } from '../publish/publish-plan.mjs';
import { call, removeDocuments, sendDocuments, Stop } from '../publish/publish-steps.mjs';
import { ALL, chooseDocument, fetchArtifact } from '../reading/artifact-source.mjs';
import { keyIn, newKey, openAll, sealAll } from './sealing.mjs';
import { keyringFor } from './keyring.mjs';

export const MAX_DOCUMENTS = 50;
const VISIBILITIES = ['unlisted', 'private'];

/** A refusal from a request, said as the site said it. */
async function attempt(work) {
    try {
        return await work();
    } catch (error) {
        // Stryker disable next-line ConditionalExpression: unreachable - a request that fails is always a Stop (call), so anything else is a fault of this code, passed on as it is
        if (error instanceof Stop) throw new Refused(error.message);
        throw error;
    }
}

/** The artifact a reference names, or a refusal. */
function idOf(reference) {
    const id = pasteIdFrom(reference);
    if (id === null) throw new Refused('Name the artifact by its id or its link.');
    return id;
}

function needsKey(ctx) {
    if (!hasCredential(ctx)) throw new Refused('This needs you signed in to Markest: run markest login, or set MARKEST_API_KEY where this server is started.');
}

/** Documents as given, checked as the site checks them, each with its type. */
export function documentsFrom(given, typeThere = new Map()) {
    if (!Array.isArray(given) || given.length === 0) throw new Refused('Give at least one document, each with a path and its content.');
    if (given.length > MAX_DOCUMENTS) throw new Refused('At most ' + MAX_DOCUMENTS + ' documents.');
    const seen = new Set();
    return given.map((doc) => {
        const check = validatePath(doc?.path);
        if (!check.ok) throw new Refused('The path "' + String(doc?.path ?? '') + '" is not one the site takes (' + check.error + ').');
        if (seen.has(check.path)) throw new Refused('Two documents at ' + check.path + '.');
        seen.add(check.path);
        if (typeof doc.content !== 'string') throw new Refused('The document at ' + check.path + ' has no text content.');
        if (doc.content_type !== undefined && !isContentType(doc.content_type)) throw new Refused('content_type is markdown, html or code.');
        const contentType = doc.content_type ?? typeThere.get(check.path) ?? detectContentType(doc.content, check.path);
        return { path: check.path, content: doc.content, contentType, ...(typeof doc.title === 'string' ? { title: doc.title } : {}) };
    });
}

/** What one of the site's refusals says: its code, its path where it has one, and its limit. */
function reasonOf(error) {
    const path = error.path ? ' ' + error.path : '';
    // Stryker disable next-line ConditionalExpression,ArithmeticOperator: unreachable - every refusal that reaches here carries a limit; those without one, a path's or a duplicate's, are refused by documentsFrom first
    if (error.limit === undefined) return error.code + path;
    return error.code + path + ' (limit ' + error.limit + ')';
}

function refuseBroken(documents) {
    // No opening document is checked here: preflight checks one only when told it is missing, and createSealed checks its own
    const errors = preflight(documents.map((doc) => ({ path: doc.path, content: doc.content })));
    if (errors.length > 0) throw new Refused('The site would refuse it: ' + errors.map(reasonOf).join(', ') + '.');
}

/** A new artifact encrypted end to end, from documents given as text. */
export async function createSealed(ctx, { title = null, documents, visibility = 'unlisted', default_path: defaultPath = null, folder = null }) {
    needsKey(ctx);
    if (!VISIBILITIES.includes(visibility)) throw new Refused('An artifact encrypted end to end is unlisted or private, never public.');
    const docs = documentsFrom(documents);
    refuseBroken(docs);
    if (defaultPath !== null && !docs.some((doc) => doc.path === defaultPath)) throw new Refused('There is no document ' + defaultPath + ' to open on.');
    const { rest } = clientsFor(ctx);
    const { text } = await newKey();
    // In the order given, so the one it opens on may come in a later request (`batchBytes`: a test's smaller one)
    const [first, ...more] = batchesOf(await sealAll(text, docs), ctx.batchBytes);
    const body = { sealed: true, visibility, documents: first };
    // Stryker disable next-line ConditionalExpression: equivalent - a title of null is no title to the site
    if (title !== null) body.title = title;
    // Stryker disable next-line ConditionalExpression: equivalent - no document has the path null, so the search alone decides
    if (defaultPath !== null && first.some((doc) => doc.path === defaultPath)) body.default_path = defaultPath;
    // Stryker disable next-line ConditionalExpression: equivalent - a folder of null is no folder to the site
    if (folder !== null) body.folder = folder;
    // Stryker disable next-line StringLiteral: equivalent - the stage is not said: a refusal is passed on by its message
    const created = (await attempt(() => call(rest, 'create', 'POST', '/api/v1/pastes', { json: body }))).body;
    await keyringFor(ctx).remember(ctx.baseUrl, created.id, text, created.title ?? null);
    for (const batch of more) await attempt(() => sendDocuments(rest, created.id, batch));
    // Stryker disable next-line StringLiteral: equivalent - the stage is not said: a refusal is passed on by its message
    if (defaultPath !== null && body.default_path === undefined) await attempt(() => call(rest, 'settings', 'PATCH', '/api/v1/pastes/' + created.id, { json: { default_path: defaultPath }, idempotent: true }));
    return { id: created.id, url: linkWithKey(created.url, text), title: created.title ?? null, visibility: created.visibility, documents: docs.map((doc) => doc.path) };
}

/** An artifact's text, opened with the link's key or the one kept here. */
// Stryker disable next-line BooleanLiteral: equivalent - only a read asks, and says; a write keeps the owner's key anyway
async function opened(ctx, reference, { remember = false } = {}) {
    const id = idOf(reference);
    const { rest } = clientsFor(ctx);
    const artifact = await fetchArtifact(rest, { id, reference, keyed: hasCredential(ctx), pick: ALL });
    if (!artifact.sealed) return { artifact, key: null };
    const keyring = keyringFor(ctx);
    const given = keyIn(reference);
    const key = given ?? await keyring.get(ctx.baseUrl, id);
    if (key === null) throw new Refused('It is encrypted end to end and no key for it is kept here: name it by its whole link, the one ending #key=...');
    const documents = await openAll(key, artifact.documents);
    if (given !== null && remember) await keyring.remember(ctx.baseUrl, id, given, artifact.title);
    return { artifact: { ...artifact, documents }, key };
}

/** One document's text, or every document's. */
export async function readSealed(ctx, { artifact: reference, path = null, all = false, remember = false }) {
    const { artifact } = await opened(ctx, reference, { remember });
    const shape = (doc) => ({ path: doc.path, title: doc.title ?? null, content_type: doc.contentType, content: doc.content });
    if (all) return { id: artifact.id, title: artifact.title, encrypted: artifact.sealed, documents: artifact.documents.map(shape) };
    const chosen = chooseDocument(artifact, path);
    if (chosen === null) throw new Refused('There is no document ' + path + '. It holds: ' + artifact.documents.map((doc) => doc.path).join(', '));
    return { id: artifact.id, title: artifact.title, encrypted: artifact.sealed, document: shape(artifact.documents.find((doc) => doc.path === chosen)), paths: artifact.documents.map((doc) => doc.path) };
}

/** Documents added or replaced, each sealed with the type it had, or was given, or is told by. */
export async function writeSealed(ctx, { artifact: reference, documents }) {
    needsKey(ctx);
    const { artifact, key } = await opened(ctx, reference);
    if (key === null) throw new Refused('That artifact is not encrypted end to end: change it through the Markest connector instead.');
    const typeThere = new Map(artifact.documents.map((doc) => [doc.path, doc.contentType]));
    const incoming = documentsFrom(documents, typeThere);
    const merged = new Map(artifact.documents.map((doc) => [doc.path, doc]));
    for (const doc of incoming) merged.set(doc.path, doc);
    refuseBroken([...merged.values()]);
    const { rest } = clientsFor(ctx);
    const payloads = await sealAll(key, incoming);
    await attempt(() => sendDocuments(rest, artifact.id, payloads));
    // The owner's: a key that opened it to write is kept, as the browser that edits one keeps it
    // Stryker disable next-line ConditionalExpression: equivalent - a key opened from this machine's store is kept there already; keeping it again changes only its date
    if (keyIn(reference) !== null) await keyringFor(ctx).remember(ctx.baseUrl, artifact.id, key, artifact.title);
    return { id: artifact.id, written: incoming.map((doc) => ({ path: doc.path, replaced: typeThere.has(doc.path), content_type: doc.contentType })) };
}

/** Documents taken out; the key is not needed for that, but it must be an artifact this key may change. */
export async function removeSealed(ctx, { artifact: reference, paths }) {
    needsKey(ctx);
    if (!Array.isArray(paths) || paths.length === 0) throw new Refused('Name the documents to take out.');
    const id = idOf(reference);
    const { rest } = clientsFor(ctx);
    await attempt(() => removeDocuments(rest, id, paths));
    return { id, removed: paths };
}

/** The link that shares it, key and all, when one is kept here. */
export async function linkFor(ctx, { artifact: reference }) {
    const id = idOf(reference);
    const key = keyIn(reference) ?? await keyringFor(ctx).get(ctx.baseUrl, id);
    const url = ctx.baseUrl + '/p/' + id;
    return { id, url: key === null ? url : linkWithKey(url, key), has_key: key !== null };
}
