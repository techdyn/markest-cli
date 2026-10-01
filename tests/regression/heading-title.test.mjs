/**
 * Regression (2026-10-01): a folder published without --title is named by its
 * opening document's first heading, and two headings named it wrongly. An empty
 * heading closed with hashes (`# #`) named the artifact "#", and a title ending
 * in a hash (`# Learning C#`) lost it, since closing hashes were taken with no
 * space before them. CommonMark takes them only after a space or tab.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTitle } from '../../src/publish/publish-plan.mjs';

const named = (content) => chooseTitle(null, { type: 'markdown', content }, 'my-folder');

test('an empty first heading names nothing, so the folder names the artifact', () => {
    for (const content of ['# #\n', '#  ##\n', '# \n', '#\n']) assert.equal(named(content), 'my-folder', JSON.stringify(content));
});

test('a hash that ends a title is kept; closing hashes come off only after a space', () => {
    assert.equal(named('# Learning C#\n'), 'Learning C#');
    assert.equal(named('# Learning C# ##\n'), 'Learning C#');
});
