/**
 * @module cli/publish/publish-run
 * @description A publish, request by request. A new artifact is one create
 *              carrying every document, then each image the documents show as
 *              its own bytes, then one overwrite of the documents
 *              that show them, pointed at the addresses the uploads answered. A
 *              public one with images is created unlisted and published last,
 *              through the one visibility door, so a confirmation covers the
 *              finished artifact. An artifact already there is
 *              read, its images listed - which also proves it is the caller's -
 *              and only what changed is sent: new images, then added and changed
 *              documents in one overwrite; documents gone from the folder are
 *              removed only with `--prune`, and no image is ever removed. A
 *              create is never repeated after a lost connection; a lost image
 *              upload is looked for by its SHA-256 before it is sent again. One
 *              encrypted end to end - asked for, or found when updating - is
 *              publish/sealed-publish's.
 *
 * @input The scan, the options, the site; a client and the key store
 * @output The result publish/publish-report renders
 * @dependencies node:fs/promises, cli/shared, cli/publish/publish-plan, cli/publish/image-refs,
 *               cli/publish/publish-steps, cli/publish/sealed-publish, cli/core/api-client
 */

import { readFile } from 'node:fs/promises';
import { basename } from '../shared.mjs';
import { batchesOf, chooseDefault, chooseTitle, diffDocuments, documentPayload, orderDocuments, planImages, preflight } from './publish-plan.mjs';
import { localWarnings, rewriteImageRefs } from './image-refs.mjs';
import { call, emptyResult, finishUpdate, lostCreate, planUpdate, publishVisibility, removeDocuments, sendDocuments, STATUS, Stop } from './publish-steps.mjs';
import { publishSealedNew, publishSealedUpdate } from './sealed-publish.mjs';
import { ApiError } from '../core/api-client.mjs';

export { STATUS };

const IMAGE_REFUSALS = new Set([400, 403, 413, 415, 422]);

/** The images the documents show, uploaded or found already there, as the addresses documents should hold. */
async function sendImages(client, id, plan, existing, result, log) {
    const addresses = new Map();
    const byHash = new Map();
    for (const image of existing) {
        // A copy the proxy made can vanish with the page it came from; only an upload is reused.
        if (image.source === 'upload' && image.sha256 && !byHash.has(image.sha256)) byHash.set(image.sha256, image);
    }
    const place = (sha256, where) => {
        for (const [path, image] of plan.byPath) if (image.sha256 === sha256) addresses.set(path, where);
    };
    for (const image of plan.send) {
        const there = byHash.get(image.sha256);
        if (there) {
            result.images.reused.push({ path: image.path, id: there.id });
            place(image.sha256, there.path);
            continue;
        }
        log('Uploading ' + image.path);
        let answer;
        try {
            answer = await client.request('PUT', '/api/v1/pastes/' + id + '/images', {
                body: await readFile(image.onDisk), contentType: image.contentType, query: { name: basename(image.path) },
            });
        } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            if (error.lost) {
                // It may have arrived: look before sending it again.
                const listed = await call(client, 'images', 'GET', '/api/v1/pastes/' + id + '/images', { idempotent: true });
                // Stryker disable next-line ArrayDeclaration: equivalent - a string in place of no images is no upload either, so nothing is found
                const arrived = (listed.body?.images ?? []).find((one) => one.source === 'upload' && one.sha256 === image.sha256);
                if (arrived) {
                    result.images.uploaded.push({ path: image.path, id: arrived.id, path_on_site: arrived.path });
                    place(image.sha256, arrived.path);
                    continue;
                }
                answer = await call(client, 'images', 'PUT', '/api/v1/pastes/' + id + '/images', {
                    body: await readFile(image.onDisk), contentType: image.contentType, query: { name: basename(image.path) },
                });
            } else if (IMAGE_REFUSALS.has(error.status)) {
                result.images.refused.push({ path: image.path, status: error.status, error: error.message });
                continue;
            } else {
                throw new Stop('images', error.message);
            }
        }
        result.images.uploaded.push({ path: image.path, id: answer.body.id, path_on_site: answer.body.path });
        place(image.sha256, answer.body.path);
    }
    return addresses;
}

async function publishNew(client, ctx, result) {
    const { options, plan, documents, defaultPath, title } = ctx;
    const holdPublic = options.visibility === 'public' && plan.send.length > 0;
    // The documents come in order with the one it opens on first, so the first request always carries it
    // Stryker disable next-line ArrayDeclaration: equivalent - a folder with no documents is refused before this
    const [first = [], ...rest] = batchesOf(documents.map((doc) => documentPayload(doc)));
    const body = { title, documents: first, default_path: defaultPath };
    if (options.visibility !== null) body.visibility = holdPublic ? 'unlisted' : options.visibility;

    const created = await call(client, 'create', 'POST', '/api/v1/pastes', { json: body }, lostCreate);
    const id = created.body.id;
    Object.assign(result, { id, url: created.body.url, title: created.body.title, visibility: created.body.visibility });
    if (created.status === 202) result.approval_url = created.body.approval_url ?? null;
    result.documents.created = documents.length;

    for (const batch of rest) await sendDocuments(client, id, batch);

    // Stryker disable next-line ArrayDeclaration: equivalent - a string in place of no images is no upload, so nothing is reused
    const addresses = await sendImages(client, id, plan, [], result, ctx.log);
    const rewritten = [];
    for (const doc of documents) {
        const content = rewriteImageRefs(doc.content, doc.path, doc.type, addresses);
        if (content !== doc.content) rewritten.push({ path: doc.path, content });
    }
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent - no documents to send is no request either way
    if (rewritten.length > 0) await sendDocuments(client, id, rewritten);
    if (holdPublic) await publishVisibility(client, id, 'public', result);
    result.default_path = defaultPath;
}

async function publishUpdate(client, ctx, result) {
    const { options, plan, documents } = ctx;
    const id = options.update;
    const readError = (error) => error.status === 403
        ? 'Updating needs a key with the read_own permission, so only what changed is sent: ' + error.message
        : error.status === 404 ? 'There is no artifact ' + id + ' that this key can read.' : error.message;
    const paste = (await call(client, 'read', 'GET', '/api/v1/pastes/' + id, { idempotent: true }, readError)).body;
    const listed = await call(client, 'read', 'GET', '/api/v1/pastes/' + id + '/images', { idempotent: true },
        (error) => (error.status === 404 ? 'You can only update artifacts you own.' : readError(error)));
    Object.assign(result, { id, url: ctx.baseUrl + '/p/' + id, title: result.title ?? paste.title, visibility: paste.visibility });
    if (paste.sealed) return publishSealedUpdate(client, ctx, result, { ...paste, id });
    if (options.sealed) throw new Stop('plan', 'That artifact is not encrypted end to end, and one is encrypted only when it is made: publish the folder as a new one with --sealed.');

    const remote = paste.documents ?? [];
    const byPath = new Map(remote.map((doc) => [doc.path, doc]));
    const planned = planUpdate(documents, remote, options.prune);
    if (planned.stop) {
        result.errors.push(...planned.errors);
        throw new Stop('plan', planned.stop);
    }
    const { paths } = planned;
    if (options.dryRun) {
        // Stryker disable next-line ArrayDeclaration: equivalent - a string in place of no images is no upload, so nothing is taken as there
        const unsent = plan.send.filter((image) => !(listed.body?.images ?? []).some((one) => one.source === 'upload' && one.sha256 === image.sha256));
        result.images.uploaded = unsent.map((image) => ({ path: image.path, id: null, path_on_site: null }));
        Object.assign(result.documents, { created: paths.add.length, updated: paths.change.length, unchanged: paths.unchanged.length, deleted: options.prune ? paths.remove.length : 0 });
        return;
    }

    // Stryker disable next-line ArrayDeclaration: equivalent - a string in place of no images is no upload, so nothing is reused
    const addresses = await sendImages(client, id, plan, listed.body?.images ?? [], result, ctx.log);
    ctx.wrote = result.images.uploaded.length > 0;
    const rewritten = documents.map((doc) => ({ ...doc, content: rewriteImageRefs(doc.content, doc.path, doc.type, addresses) }));
    const diff = diffDocuments(rewritten, remote);
    const payloads = [...diff.add.map((doc) => documentPayload(doc)), ...diff.change.map((doc) => documentPayload(doc, byPath.get(doc.path)))];
    if (payloads.length > 0) {
        await sendDocuments(client, id, payloads);
        ctx.wrote = true;
    }
    Object.assign(result.documents, { created: diff.add.length, updated: diff.change.length, unchanged: diff.unchanged.length });
    if (options.prune && diff.remove.length > 0) {
        result.documents.deleted = await removeDocuments(client, id, diff.remove.map((doc) => doc.path));
        ctx.wrote = true;
    }
    await finishUpdate(client, ctx, result, { ...paste, id });
}

/** Everything the publish decides before asking the site anything. */
export function planPublish(scan, options) {
    const images = planImages(scan.documents, scan.images);
    const paths = images.documents.map((doc) => doc.path);
    // An update changes the opening document only when asked; unasked, this one only proves there is one
    const defaultPath = chooseDefault(paths, options.defaultPath);
    const documents = orderDocuments(images.documents, options.update !== null ? null : defaultPath);
    const title = chooseTitle(options.title, documents.find((doc) => doc.path === defaultPath), scan.name);
    const sending = new Set([...images.shown]);
    const warnings = documents.flatMap((doc) => localWarnings(doc.content, doc.path, doc.type, sending));
    const errors = preflight(documents, { defaultPath, fatal: scan.fatal });
    // An artifact encrypted end to end holds no image: one shown would be kept in the clear
    if (options.sealed) for (const image of images.send) errors.push({ code: 'sealed_image', path: image.path });
    // Stryker disable next-line MethodExpression: equivalent - no document shows an image nothing shows, so its address is never looked up
    images.byPath = new Map(scan.images.filter((image) => images.shown.has(image.path)).map((image) => [image.path, image]));
    return { plan: images, documents, defaultPath, title, warnings, errors };
}

export async function publish({ scan, options, baseUrl }, { client, log = () => {}, keyring = null }) {
    const result = emptyResult(scan);
    const planned = planPublish(scan, options);
    result.warnings = planned.warnings;
    result.images.unshown = planned.plan.unshown;
    // An update changes only the title and opening document asked for: the rest is the artifact's, not the folder's
    const keeps = (asked) => options.update !== null && asked === null;
    result.title = keeps(options.title) ? null : planned.title;
    result.default_path = keeps(options.defaultPath) ? null : planned.defaultPath;
    result.encrypted = Boolean(options.sealed);
    if (planned.errors.length > 0) {
        Object.assign(result, { status: STATUS.REFUSED, stage: 'plan', errors: planned.errors, error: 'The folder cannot be published as it is; nothing was sent.' });
        return result;
    }
    if (options.dryRun && options.update === null) {
        result.documents.created = planned.documents.length;
        result.images.uploaded = planned.plan.send.map((image) => ({ path: image.path, id: null, path_on_site: null }));
        result.status = STATUS.DRY_RUN;
        return result;
    }
    const ctx = { ...planned, options, baseUrl, log, keyring, wrote: false };
    try {
        if (options.update !== null) await publishUpdate(client, ctx, result);
        else if (options.sealed) await publishSealedNew(client, ctx, result);
        else await publishNew(client, ctx, result);
    } catch (error) {
        if (!(error instanceof Stop)) throw error;
        Object.assign(result, { status: error.stage === 'plan' ? STATUS.REFUSED : STATUS.FAILED, stage: error.stage, error: error.message });
        result.requests = client.requests;
        return result;
    }
    result.requests = client.requests;
    if (options.dryRun) result.status = STATUS.DRY_RUN;
    else if (result.images.refused.length > 0) result.status = STATUS.INCOMPLETE;
    else if (result.approval_url) result.status = STATUS.APPROVAL;
    else if (options.update === null) result.status = STATUS.PUBLISHED;
    else result.status = ctx.wrote ? STATUS.UPDATED : STATUS.UNCHANGED;
    return result;
}
