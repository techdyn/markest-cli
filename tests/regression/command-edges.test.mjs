/**
 * Regression (2026-10-01), two commands found wanting by mutation testing:
 * `markest images --add` took a file named `notes.constructor` or
 * `notes.__proto__` for an image, since its extension check also matched the
 * names every object inherits; and `markest delete --json` refused partway
 * said only the error, so a script could not tell which artifacts were
 * already gone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from '../support/fake-markest.mjs';
import { against, makeFolder } from '../support/cli-harness.mjs';

const MISSING = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

test('a file is an image only by an extension of its own, never one every object inherits', async () => {
    const site = await startFakeMarkest();
    try {
        const paste = site.addPaste({ title: 'P' });
        const folder = await makeFolder({ 'notes.constructor': 'x', 'notes.__proto__': 'x' });
        for (const name of ['notes.constructor', 'notes.__proto__']) {
            const out = await against(site)(['images', paste.id, '--add', folder + '/' + name]);
            assert.equal(out.code, 2, name);
            assert.match(out.stderr, /is not an image the site keeps/);
        }
        assert.equal(site.writes().length, 0);
    } finally {
        await site.close();
    }
});

test('a delete refused partway tells a script which artifacts are already gone', async () => {
    const site = await startFakeMarkest();
    try {
        const gone = site.addPaste({ title: 'Gone' });
        const out = await against(site)(['delete', gone.id, MISSING, '--yes', '--json']);
        assert.equal(out.code, 1);
        assert.deepEqual(out.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)), [{ error: 'Paste not found.', status: 404 }, { deleted: [gone.id] }]);
    } finally {
        await site.close();
    }
});
