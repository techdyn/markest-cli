/**
 * @module cli/publish/sealed-publish
 * @description A folder published encrypted end to end (D-20261001-01): every
 *              document sealed on this machine with a new key, as the browser
 *              seals one - bound to its path and type, the type sent beside it -
 *              and the site handed envelopes alone. It is never public, holds no
 *              image and keeps no versions; the site says so too. The key is kept
 *              in this machine's key store the moment the artifact exists, and the
 *              address printed is the link that shares it, key and all. Updating
 *              one opens what the site holds with the key in `--update`'s link or
 *              the one kept here, compares the texts, and seals only what changed,
 *              each keeping the type it was sealed as.
 *
 * @input A client, the publish's context `{ options, plan, documents, defaultPath, title, baseUrl, keyring }`, its result
 * @output The result filled in; `Stop` at the stage a refusal came
 * @dependencies cli/shared, cli/publish/publish-plan, cli/publish/publish-steps,
 *               cli/sealed/sealing, cli/core/command-kit
 */

import { linkWithKey } from '../shared.mjs';
import { batchesOf, diffDocuments } from './publish-plan.mjs';
import { call, finishUpdate, lostCreate, planUpdate, removeDocuments, sendDocuments, Stop } from './publish-steps.mjs';
import { newKey, openAll, sealAll } from '../sealed/sealing.mjs';
import { Refused } from '../core/command-kit.mjs';

/** What a document is sealed as: its text, and the type the site would tell it by. */
const sealable = (doc, contentType = doc.type) => ({ path: doc.path, content: doc.content, contentType });

/** Keep the key; a store that cannot be written is a warning, as the link printed still holds it. */
async function keep(ctx, result, id, keyText, title) {
    if (!ctx.keyring) return;
    try {
        await ctx.keyring.remember(ctx.baseUrl, id, keyText, title);
    } catch (error) {
        result.warnings.push({ code: 'key_not_kept', path: ctx.keyring.path, target: error.message });
    }
}

export async function publishSealedNew(client, ctx, result) {
    const { options, documents, defaultPath, title } = ctx;
    const { text } = await newKey();
    // In order, the one it opens on first: the first request always carries it
    // Stryker disable next-line ArrayDeclaration: equivalent - a folder with no documents is refused before this
    const [first = [], ...rest] = batchesOf(await sealAll(text, documents.map((doc) => sealable(doc))));
    const body = { title, sealed: true, documents: first, default_path: defaultPath };
    if (options.visibility !== null) body.visibility = options.visibility;

    const created = await call(client, 'create', 'POST', '/api/v1/pastes', { json: body }, lostCreate);
    const id = created.body.id;
    // Kept before anything else can go wrong: without its key the artifact is lost to its owner too
    await keep(ctx, result, id, text, created.body.title);
    Object.assign(result, { id, url: linkWithKey(created.body.url, text), title: created.body.title, visibility: created.body.visibility, encrypted: true });
    result.documents.created = documents.length;
    for (const batch of rest) await sendDocuments(client, id, batch);
    result.default_path = defaultPath;
}

export async function publishSealedUpdate(client, ctx, result, paste) {
    const { options, plan, documents } = ctx;
    result.encrypted = true;
    const keyText = options.updateKey ?? (ctx.keyring ? await ctx.keyring.get(ctx.baseUrl, paste.id) : null);
    if (keyText === null) throw new Stop('plan', 'That artifact is encrypted end to end, and this machine keeps no key for it: give --update its whole link, the one ending #key=...');
    if (plan.send.length > 0) {
        result.errors.push(...plan.send.map((image) => ({ code: 'sealed_image', path: image.path })));
        throw new Stop('plan', 'An artifact encrypted end to end holds no image, and documents in the folder show some. Leave them out with --ignore.');
    }
    let remote;
    try {
        // Stryker disable next-line ArrayDeclaration: equivalent - the site's read of an artifact always lists its documents
        remote = await openAll(keyText, (paste.documents ?? []).map((doc) => ({ path: doc.path, title: doc.title, contentType: doc.content_type, content: doc.content })));
    } catch (error) {
        // Stryker disable next-line ConditionalExpression: equivalent - opening the site's documents fails only as a refusal
        if (error instanceof Refused) throw new Stop('plan', error.message);
        throw error;
    }
    const planned = planUpdate(documents, remote, options.prune);
    if (planned.stop) {
        result.errors.push(...planned.errors);
        throw new Stop('plan', planned.stop);
    }
    // The owner's: the key that opened it is kept, as the browser that edits one keeps it
    // Stryker disable next-line ConditionalExpression: equivalent - keeping again a key already kept changes only its date
    if (options.updateKey) await keep(ctx, result, paste.id, keyText, paste.title);
    result.url = linkWithKey(ctx.baseUrl + '/p/' + paste.id, keyText);
    const { paths } = planned;
    if (options.dryRun) {
        Object.assign(result.documents, { created: paths.add.length, updated: paths.change.length, unchanged: paths.unchanged.length, deleted: options.prune ? paths.remove.length : 0 });
        return;
    }
    const diff = diffDocuments(documents, remote);
    const typeThere = new Map(remote.map((doc) => [doc.path, doc.contentType]));
    const payloads = await sealAll(keyText, [...diff.add.map((doc) => sealable(doc)), ...diff.change.map((doc) => sealable(doc, typeThere.get(doc.path)))]);
    if (payloads.length > 0) {
        await sendDocuments(client, paste.id, payloads.map(({ title, ...payload }) => payload));
        ctx.wrote = true;
    }
    Object.assign(result.documents, { created: diff.add.length, updated: diff.change.length, unchanged: diff.unchanged.length });
    if (options.prune && diff.remove.length > 0) {
        result.documents.deleted = await removeDocuments(client, paste.id, diff.remove.map((doc) => doc.path));
        ctx.wrote = true;
    }
    await finishUpdate(client, ctx, result, paste);
}
