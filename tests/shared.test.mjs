/**
 * The door to the site's own rules (cli/shared) hands on what the command
 * relies on, and an envelope it seals is one the site and the browser take.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '../src/shared.mjs';

test('the door hands on every rule the command relies on', () => {
    for (const name of ['validatePath', 'normalizePath', 'isAcceptedFile', 'extensionOf', 'dirname', 'basename', 'detectContentType', 'isContentType',
        'DocumentStore', 'byteLength', 'ignoredFolder', 'reviewFolder', 'retryAfterMs', 'isEnvelope', 'keyText', 'keyBytes', 'createKey', 'keyFromText',
        'sealDocument', 'openDocument', 'SealBroken', 'keyFromHash', 'keyFromInput', 'linkWithKey']) {
        assert.equal(typeof shared[name], 'function', name);
    }
    for (const name of ['TYPE_MARKDOWN', 'TYPE_HTML', 'TYPE_CODE', 'SEAL_PREFIX', 'KEY_FRAGMENT']) assert.equal(typeof shared[name], 'string', name);
    assert.ok(Array.isArray(shared.IMAGE_TYPES) && shared.IMAGE_TYPES.includes('image/png'));
    assert.equal(typeof shared.DEFAULT_LIMITS.maxFileSize, 'number');
});

test('an envelope sealed through the door is the site\'s shape, opens only with its key, path and type, and the key rides in a link', async () => {
    const { text, key } = await shared.createKey();
    assert.match(text, /^[A-Za-z0-9_-]{43}$/);
    const doc = { path: 'notes/plan.md', contentType: shared.TYPE_MARKDOWN, content: '# The plan\n' };
    const envelope = await shared.sealDocument(key, doc);
    assert.ok(envelope.startsWith(shared.SEAL_PREFIX));
    assert.ok(shared.isEnvelope(envelope));
    // SealedEnvelope::PATTERN, the site's check
    assert.match(envelope, /^MKSEAL1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(await shared.openDocument(await shared.keyFromText(text), { ...doc, content: envelope }), doc.content);
    await assert.rejects(shared.openDocument(key, { ...doc, path: 'moved.md', content: envelope }), shared.SealBroken, 'bound to its path');
    await assert.rejects(shared.openDocument(key, { ...doc, contentType: shared.TYPE_CODE, content: envelope }), shared.SealBroken, 'and its type');
    const link = shared.linkWithKey('https://marke.st/p/01ARZ3NDEKTSV4RRFFQ69G5FAV/plan.md#old', text);
    assert.equal(link, 'https://marke.st/p/01ARZ3NDEKTSV4RRFFQ69G5FAV/plan.md#' + shared.KEY_FRAGMENT + '=' + text);
    assert.equal(shared.keyFromInput(link), text);
    assert.equal(shared.keyFromInput(text), text);
    assert.equal(shared.keyFromInput('https://marke.st/p/x#key=short'), null);
});
