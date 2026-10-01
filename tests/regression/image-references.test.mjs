/**
 * Regression (2026-10-01): mutation testing of image-refs found the publish command
 * reading documents otherwise than CommonMark and the browser read them, so an image
 * a document shows was missed or something else was taken for one: a backslash
 * escape kept in a destination, a blank line hidden by a backslash before it, a blank
 * line holding spaces or written with Windows line endings, an escaped "!" read as an
 * image, a character reference kept in an HTML attribute, and a page's module script
 * never warned about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { imageTargets, localWarnings, rewriteImageRefs } from '../../src/publish/image-refs.mjs';

const md = (text) => imageTargets(text, 'a.md', 'markdown');
const warnings = (text, path, type) => localWarnings(text, path, type, new Set()).map((w) => w.code + ':' + w.target);

test('a backslash escape in a markdown destination is undone, as CommonMark undoes it', () => {
    assert.deepEqual(md('![a](chart\\_v2.png)\n[r]: shot\\(1\\).png'), ['chart_v2.png', 'shot(1).png']);
});

test('a backslash at the end of a line does not hide the blank line after it', () => {
    assert.deepEqual(md('![a\\\n\nb](x.png)'), []);
});

test('a script beside a page is warned about whatever its file is called', () => {
    assert.deepEqual(warnings('<script type="module" src="app.mjs"></script>', 'i.html', 'html'), ['html_local_resource:app.mjs']);
});

test('a blank line holding spaces or tabs, or written with Windows line endings, ends a paragraph', () => {
    for (const text of ['![a\n  \nb](x.png)', '![a\n\t\nb](x.png)', '![a\r\n\r\nb](x.png)', '![a](\n  \nx.png)']) {
        assert.deepEqual(md(text), [], JSON.stringify(text));
    }
    // One Windows line ending is one line ending: these still stand.
    assert.deepEqual(md('![a\r\nb](x.png)\r\n![c]( \r\n y.png \r\n "T")\r\n[r]:\r\n  z.png\r\n'), ['x.png', 'y.png', 'z.png']);
});

test('an escaped "!" is a "!" before a link, not an image, and an escaped backslash escapes nothing', () => {
    const text = '\\![a](x.png)';
    assert.deepEqual(md(text), []);
    assert.equal(rewriteImageRefs(text, 'a.md', 'markdown', new Map([['x.png', '/img/P/X']])), text);
    assert.deepEqual(warnings(text, 'a.md', 'markdown'), ['image_link:x.png'], 'said as any link to an image is');
    assert.deepEqual(md('\\\\![a](y.png)'), ['y.png']);
    assert.deepEqual(warnings('\\\\[b](z.png)', 'a.md', 'markdown'), ['image_link:z.png']);
});

test('a character reference in an HTML attribute is decoded before the file is looked for', () => {
    const page = '<img src="a&amp;b.png"><img srcset="c&#38;d.png 1x, e&#x26;f.png 2x">';
    assert.deepEqual(imageTargets(page, 'i.html', 'html'), ['a&b.png', 'c&d.png', 'e&f.png']);
    const addresses = new Map([['a&b.png', '/img/P/A'], ['c&d.png', '/img/P/C'], ['e&f.png', '/img/P/E']]);
    assert.equal(rewriteImageRefs(page, 'i.html', 'html', addresses), '<img src="/img/P/A"><img srcset="/img/P/C 1x, /img/P/E 2x">');
});
