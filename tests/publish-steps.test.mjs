/**
 * The requests every publish is made of (cli/publish/publish-steps): a refusal
 * stopping it at its stage, documents removed with one already gone taken as
 * done, settings applied only when asked, visibility applied or waiting, and an
 * update judged before anything is sent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/core/api-client.mjs';
import { applySettings, call, emptyResult, finishUpdate, lostCreate, planUpdate, publishVisibility, removeDocuments, sendDocuments, STATUS, Stop } from '../src/publish/publish-steps.mjs';

/** A client answering each request with the next of `answers`: a value, or an error to throw. */
function client(answers) {
    const sent = [];
    return {
        sent,
        async request(method, path, options) {
            sent.push({ method, path, options });
            const next = answers.shift();
            if (next instanceof Error) throw next;
            return next ?? { status: 200, body: {} };
        },
    };
}

test('a publish ends in a status named as its JSON says it, and starts knowing nothing but what the scan skipped', () => {
    assert.deepEqual(STATUS, {
        PUBLISHED: 'published', UPDATED: 'updated', UNCHANGED: 'unchanged', APPROVAL: 'approval_required',
        DRY_RUN: 'dry_run', INCOMPLETE: 'incomplete', FAILED: 'failed', REFUSED: 'refused',
    });
    const skipped = [{ path: '.env', reason: 'hidden' }];
    assert.deepEqual(emptyResult({ skipped }), {
        status: null, stage: null, id: null, url: null, approval_url: null, title: null, visibility: null, default_path: null,
        encrypted: false,
        documents: { created: 0, updated: 0, unchanged: 0, deleted: 0 },
        images: { uploaded: [], reused: [], refused: [], unshown: [] },
        skipped, warnings: [], errors: [], requests: 0, error: null,
    });
});

test('documents go in overwrites safe to repeat, the last answer kept; a refusal stops the publish at the documents', async () => {
    const payloads = [{ path: 'a.md', content: 'a' }, { path: 'b.md', content: 'b' }];
    const site = client([{ status: 200, body: { documents: 2 } }]);
    assert.deepEqual(await sendDocuments(site, 'ID', payloads), { status: 200, body: { documents: 2 } });
    assert.deepEqual(site.sent, [{ method: 'POST', path: '/api/v1/pastes/ID/documents', options: { json: { documents: payloads, overwrite: true }, idempotent: true } }]);
    const idle = client([]);
    assert.equal(await sendDocuments(idle, 'ID', []), null);
    assert.equal(idle.sent.length, 0, 'nothing to send, nothing sent');
    await assert.rejects(sendDocuments(client([new ApiError('Too large.', { status: 413 })]), 'ID', payloads), (error) => error instanceof Stop && error.stage === 'documents' && error.message === 'Too large.');
});

test('settings and visibility are each one request safe to repeat, stopping the publish at its own stage when refused', async () => {
    const site = client([{ status: 200, body: null }, { status: 200, body: {} }]);
    assert.equal(await applySettings(site, 'ID', { title: 'T' }), null, 'an answer with no body names no title');
    const result = {};
    await publishVisibility(site, 'ID', 'public', result);
    assert.equal(result.visibility, 'public');
    assert.deepEqual(site.sent, [
        { method: 'PATCH', path: '/api/v1/pastes/ID', options: { json: { title: 'T' }, idempotent: true } },
        { method: 'POST', path: '/api/v1/pastes/visibility', options: { json: { paste_id: 'ID', visibility: 'public' }, idempotent: true } },
    ]);
    await assert.rejects(applySettings(client([new ApiError('No title.', { status: 422 })]), 'ID', { title: 'T' }), (error) => error instanceof Stop && error.stage === 'settings' && error.message === 'No title.');
    await assert.rejects(publishVisibility(client([new ApiError('Not yours.', { status: 403 })]), 'ID', 'public', {}), (error) => error instanceof Stop && error.stage === 'visibility' && error.message === 'Not yours.');
});

test('a refusal stops the publish at its stage, said as asked; anything else goes up', async () => {
    await assert.rejects(call(client([new ApiError('No.', { status: 403 })]), 'create', 'POST', '/x', {}), (error) => error instanceof Stop && error.stage === 'create' && error.message === 'No.');
    await assert.rejects(call(client([new ApiError('No.', { status: 403 })]), 's', 'GET', '/x', {}, (error) => 'Because: ' + error.message), /^Error: Because: No\.$|Because: No\./);
    await assert.rejects(call(client([new TypeError('bug')]), 's', 'GET', '/x', {}), TypeError);
    assert.equal(lostCreate(new ApiError('Lost', { lost: true })), 'Lost. The artifact may have been created: look in My Artifacts before running this again.');
    assert.equal(lostCreate(new ApiError('Refused')), 'Refused');
});

test('documents are removed, one already gone taken as done; any other refusal stops it', async () => {
    const site = client([{ status: 200 }, new ApiError('gone', { status: 404 })]);
    assert.equal(await removeDocuments(site, 'ID', ['a.md', 'b.md']), 2);
    assert.deepEqual(site.sent.map((one) => [one.method, one.options.query.path, one.options.idempotent]), [['DELETE', 'a.md', true], ['DELETE', 'b.md', true]]);
    await assert.rejects(removeDocuments(client([new ApiError('Keep one.', { status: 422 })]), 'ID', ['a.md']), (error) => error instanceof Stop && error.stage === 'prune');
    await assert.rejects(removeDocuments(client([new TypeError('bug')]), 'ID', ['a.md']), TypeError);
});

test('settings are sent only when asked; visibility applies or waits for confirmation', async () => {
    const quiet = client([]);
    assert.equal(await applySettings(quiet, 'ID', {}), null);
    assert.equal(quiet.sent.length, 0);
    assert.equal(await applySettings(client([{ status: 200, body: { title: 'T' } }]), 'ID', { title: 'T' }), 'T');
    assert.equal(await applySettings(client([{ status: 200, body: {} }]), 'ID', { title: 'T' }), null);
    const result = { visibility: 'unlisted', approval_url: null };
    await publishVisibility(client([{ status: 200, body: {} }]), 'ID', 'private', result);
    assert.equal(result.visibility, 'private');
    await publishVisibility(client([{ status: 202, body: { approval_url: 'https://a' } }]), 'ID', 'public', result);
    assert.deepEqual(result, { visibility: 'private', approval_url: 'https://a' }, 'waiting, it is not public yet');
    await publishVisibility(client([{ status: 202, body: null }]), 'ID', 'public', result);
    assert.equal(result.approval_url, null);
});

test('an update is judged before anything is sent', () => {
    const remote = [{ path: 'README.md', content: 'a' }, { path: 'Old.md', content: 'o' }];
    const clean = planUpdate([{ path: 'README.md', content: 'b' }], remote, true);
    assert.equal(clean.stop, null);
    assert.deepEqual(clean.paths.remove.map((doc) => doc.path), ['Old.md']);
    const clash = planUpdate([{ path: 'old.md', content: 'x' }], remote, false);
    assert.match(clash.stop, /only in case or accents/);
    assert.deepEqual(clash.errors, [{ code: 'case_rename', path: 'old.md', target: 'Old.md' }]);
    // Over the site's own limit for one markdown document (DEFAULT_LIMITS.maxFileSize, held to PasteDocument::MAX_FILE_SIZE)
    const broken = planUpdate([{ path: 'big.md', content: 'x'.repeat(600 * 1024) }], remote, false);
    assert.match(broken.stop, /break the site's rules/);
});

test('an update is judged as the artifact will be: what pruning removes is not held against it, the rest in the artifact\'s order', () => {
    const big = 'x'.repeat(600 * 1024);
    const remote = [{ path: 'README.md', content: 'a' }, { path: 'big.md', content: big }];
    const local = [{ path: 'README.md', content: 'b' }];
    assert.deepEqual(planUpdate(local, remote, true).errors, [], 'pruned, the large document goes');
    assert.deepEqual(planUpdate(local, remote, false).errors.map((one) => [one.code, one.path]), [['file_size', 'big.md']], 'kept, it still counts');
    const reordered = planUpdate([{ path: 'b.md', content: big }, { path: 'a.md', content: 'a2' }], [{ path: 'a.md', content: 'a' }, { path: 'b.md', content: 'b' }], true);
    assert.deepEqual(reordered.errors.map((one) => [one.code, one.path, one.index]), [['file_size', 'b.md', 1]], 'b.md is second in the artifact');
});

test('an update finishes with the title and opening document asked for, and visibility through its door', async () => {
    const site = client([{ status: 200, body: { title: 'New' } }, { status: 200, body: {} }]);
    const ctx = { options: { title: 'New', defaultPath: 'b.md', visibility: 'private' }, title: 'New', wrote: false };
    const result = { title: 'Old', visibility: 'unlisted' };
    await finishUpdate(site, ctx, result, { id: 'ID', visibility: 'unlisted' });
    assert.deepEqual(site.sent.map((one) => [one.method, one.path, one.options.json]), [
        ['PATCH', '/api/v1/pastes/ID', { title: 'New', default_path: 'b.md' }], ['POST', '/api/v1/pastes/visibility', { paste_id: 'ID', visibility: 'private' }],
    ]);
    assert.equal(ctx.wrote, true);
    assert.equal(result.title, 'New');
    assert.equal(result.default_path, 'b.md');

    const nothing = client([]);
    const still = { options: { title: null, defaultPath: null, visibility: 'unlisted' }, wrote: false };
    await finishUpdate(nothing, still, { title: 'Old' }, { id: 'ID', visibility: 'unlisted' });
    assert.equal(nothing.sent.length, 0, 'nothing asked, nothing sent');
    assert.equal(still.wrote, false);
    const untitled = { options: { title: null, defaultPath: 'a.md', visibility: null }, wrote: false };
    const kept = { title: 'Kept' };
    await finishUpdate(client([{ status: 200, body: { title: null } }]), untitled, kept, { id: 'ID' });
    assert.equal(untitled.wrote, true, 'a change is a change though the site names no title');
    assert.equal(kept.title, 'Kept');
});
