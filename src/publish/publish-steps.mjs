/**
 * @module cli/publish/publish-steps
 * @description The requests every publish is made of, in the clear or sealed:
 *              one request whose refusal stops the publish at its stage, saying
 *              why; documents sent in overwrites of a size a lost one costs
 *              little to repeat; documents gone from the folder removed, one
 *              already gone being what was asked; the title and opening document
 *              set; visibility through the site's one door, whose answer may
 *              be to wait for the account holder's confirmation; and what an
 *              update would send, judged before anything is.
 *
 * @input A client; the artifact's id; what to send
 * @output The site's answers; `Stop` at the stage a refusal came; an update's plan
 * @dependencies cli/core/api-client, cli/publish/publish-plan
 */

import { ApiError } from '../core/api-client.mjs';
import { batchesOf, diffDocuments, preflight } from './publish-plan.mjs';

export const STATUS = Object.freeze({
    PUBLISHED: 'published',
    UPDATED: 'updated',
    UNCHANGED: 'unchanged',
    APPROVAL: 'approval_required',
    DRY_RUN: 'dry_run',
    INCOMPLETE: 'incomplete',
    FAILED: 'failed',
    REFUSED: 'refused',
});

/** What a publish says, before anything is known. */
export function emptyResult(scan) {
    return {
        status: null,
        stage: null,
        id: null,
        url: null,
        approval_url: null,
        title: null,
        visibility: null,
        default_path: null,
        encrypted: false,
        documents: { created: 0, updated: 0, unchanged: 0, deleted: 0 },
        images: { uploaded: [], reused: [], refused: [], unshown: [] },
        skipped: scan.skipped,
        warnings: [],
        errors: [],
        requests: 0,
        error: null,
    };
}

export class Stop extends Error {
    constructor(stage, message) {
        super(message);
        this.stage = stage;
    }
}

/** Run one request; a refusal stops the publish at `stage`, saying why. */
export async function call(client, stage, method, path, options, explain = (error) => error.message) {
    try {
        return await client.request(method, path, options);
    } catch (error) {
        if (error instanceof ApiError) throw new Stop(stage, explain(error));
        throw error;
    }
}

/** Documents in as many overwrites as their size needs; every one is safe to repeat. */
export async function sendDocuments(client, id, payloads) {
    let answer = null;
    for (const batch of batchesOf(payloads)) {
        answer = await call(client, 'documents', 'POST', '/api/v1/pastes/' + id + '/documents', { json: { documents: batch, overwrite: true }, idempotent: true });
    }
    return answer;
}

/** Documents removed; one already gone - a repeat of a request whose answer was lost - is what was asked for. */
export async function removeDocuments(client, id, paths) {
    let removed = 0;
    for (const path of paths) {
        try {
            await client.request('DELETE', '/api/v1/pastes/' + id + '/documents', { query: { path }, idempotent: true });
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error instanceof ApiError ? new Stop('prune', error.message) : error;
        }
        removed++;
    }
    return removed;
}

/** The title and opening document, where asked; the title the site kept. */
export async function applySettings(client, id, settings) {
    if (Object.keys(settings).length === 0) return null;
    const answer = await call(client, 'settings', 'PATCH', '/api/v1/pastes/' + id, { json: settings, idempotent: true });
    return answer.body?.title ?? null;
}

/** Visibility through the one door: applied, or waiting for the account holder's confirmation. */
export async function publishVisibility(client, id, visibility, result) {
    const answer = await call(client, 'visibility', 'POST', '/api/v1/pastes/visibility', { json: { paste_id: id, visibility }, idempotent: true });
    if (answer.status === 202) result.approval_url = answer.body?.approval_url ?? null;
    else result.visibility = visibility;
}

/** What a create says when its answer was lost: it may have been made. */
export const lostCreate = (error) => (error.lost ? error.message + '. The artifact may have been created: look in My Artifacts before running this again.' : error.message);

/** Local documents against the artifact's, as `diffDocuments` sees them, and what may not be sent. */
export function planUpdate(documents, remote, prune) {
    const paths = diffDocuments(documents, remote);
    if (paths.conflicts.length > 0) return { paths, errors: paths.conflicts, stop: 'A document differs from one already in the artifact only in case or accents; rename it there first.' };
    const kept = prune ? remote.filter((doc) => !paths.remove.includes(doc)) : remote;
    const merged = new Map(kept.map((doc) => [doc.path, doc]));
    for (const doc of documents) merged.set(doc.path, doc);
    // An update keeps the artifact's own opening document, so none is checked: preflight checks one only when told it is missing
    const errors = preflight([...merged.values()].map((doc) => ({ path: doc.path, content: doc.content })));
    return { paths, errors, stop: errors.length > 0 ? 'The artifact would break the site\'s rules once updated.' : null };
}

/** The title and opening document asked for, and visibility through its door. */
export async function finishUpdate(client, ctx, result, paste) {
    const { options } = ctx;
    const settings = {};
    if (options.title !== null) settings.title = ctx.title;
    if (options.defaultPath !== null) settings.default_path = options.defaultPath;
    if (Object.keys(settings).length > 0) {
        result.title = (await applySettings(client, paste.id, settings)) ?? result.title;
        ctx.wrote = true;
    }
    if (options.visibility !== null && options.visibility !== paste.visibility) {
        await publishVisibility(client, paste.id, options.visibility, result);
        ctx.wrote = true;
    }
    result.default_path = options.defaultPath;
}
