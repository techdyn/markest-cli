/**
 * Regression (2026-10-01): `markest publish --update` reported what the folder
 * would make a new artifact, not what the update does. A dry run said it would
 * open on the folder's first document and showed the old title under --title,
 * and a failed update's JSON gave the folder's heading and first document as
 * the artifact's. An update changes only the title and opening document asked
 * for, so its report says those, or the artifact's own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from '../support/fake-markest.mjs';
import { makeFolder, run } from '../support/cli-harness.mjs';

test('an update says the artifact\'s own title and opening document unless others are asked for', async () => {
    const site = await startFakeMarkest();
    try {
        const paste = site.addPaste({ title: 'On the site', defaultPath: 'index.md', documents: [{ path: 'index.md', content: '# Index\n' }, { path: 'about.md', content: '# About\n' }] });
        const folder = await makeFolder({ 'about.md': '# About\n', 'index.md': '# Folder Heading\n' });
        const unasked = await run(['publish', folder, '--url', site.url, '--update', paste.id, '--dry-run']);
        assert.equal(unasked.stdout.split('\n')[0], 'Would publish "On the site", opening on (unchanged):');
        const asked = await run(['publish', folder, '--url', site.url, '--update', paste.id, '--dry-run', '--title', 'New name', '--default', 'about.md']);
        assert.equal(asked.stdout.split('\n')[0], 'Would publish "New name", opening on about.md:');
        assert.equal(site.writes().length, 0);
    } finally {
        await site.close();
    }
});

test('an update that cannot read the artifact claims no title or opening document', async () => {
    const site = await startFakeMarkest();
    try {
        const folder = await makeFolder({ 'index.md': '# Folder Heading\n' });
        const out = await run(['publish', folder, '--url', site.url, '--update', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--json']);
        assert.notEqual(out.code, 0);
        const result = JSON.parse(out.stdout);
        assert.deepEqual([result.title, result.default_path], [null, null]);
    } finally {
        await site.close();
    }
});
