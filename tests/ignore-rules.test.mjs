import test from 'node:test';
import assert from 'node:assert/strict';
import { compileIgnore, readIgnoreLines } from '../src/publish/ignore-rules.mjs';
import { makeFolder } from './support/cli-harness.mjs';

test('ignore rules follow gitignore: anchoring, folders only, wildcards, negation, last match wins', () => {
    const rules = compileIgnore(['# comment', '', '*.log', '!keep.log', '/root-only.md', 'build/', 'docs/**/draft-*.md', 'a?.md', '**/tmp']);
    assert.equal(rules.ignores('x/y.log', false), true);
    assert.equal(rules.ignores('keep.log', false), false);
    assert.equal(rules.ignores('root-only.md', false), true);
    assert.equal(rules.ignores('sub/root-only.md', false), false);
    assert.equal(rules.ignores('build', true), true);
    assert.equal(rules.ignores('build', false), false, 'a trailing slash matches folders only');
    assert.equal(rules.ignores('docs/a/b/draft-1.md', false), true);
    assert.equal(rules.ignores('docs/final.md', false), false);
    assert.equal(rules.ignores('ab.md', false), true);
    assert.equal(rules.ignores('abc.md', false), false);
    assert.equal(rules.ignores('deep/down/tmp', true), true);
});

test('a line is a comment only when it starts with #, and a backslash takes a leading ! or # literally', () => {
    const rules = compileIgnore(['# notes.md', 'draft#', '\\!bang.md', '\\#tag.md']);
    assert.equal(rules.ignores('# notes.md', false), false, 'a comment matches nothing');
    assert.equal(rules.ignores('draft#', false), true, 'a # later in the line is part of the pattern');
    assert.equal(rules.ignores('!bang.md', false), true);
    assert.equal(rules.ignores('#tag.md', false), true);
    assert.equal(rules.ignores('\\!bang.md', false), false, 'the backslash itself is not part of the name');
});

test('trailing spaces are dropped, inner ones kept; extra slashes at either end count once', () => {
    const rules = compileIgnore(['my notes.md', 'padded.md   ', 'tabbed.md\t', '//twice.md', 'cache//', 'docs/build/']);
    assert.equal(rules.ignores('my notes.md', false), true);
    assert.equal(rules.ignores('mynotes.md', false), false);
    assert.equal(rules.ignores('padded.md', false), true);
    assert.equal(rules.ignores('tabbed.md', false), true);
    assert.equal(rules.ignores('twice.md', false), true);
    assert.equal(rules.ignores('sub/twice.md', false), false, 'a leading slash ties it to the root');
    assert.equal(rules.ignores('cache', true), true);
    assert.equal(rules.ignores('docs/build', true), true);
    assert.equal(rules.ignores('docs/build', false), false, 'a trailing slash matches folders only');
});

test('a pattern with a slash inside is tied to the root; a trailing ** is everything beneath; the whole path must match', () => {
    const rules = compileIgnore(['notes/today.md', 'logs/**', '*.log', 'out/']);
    assert.equal(rules.ignores('notes/today.md', false), true);
    assert.equal(rules.ignores('x/notes/today.md', false), false);
    assert.equal(rules.ignores('notestoday.md', false), false);
    assert.equal(rules.ignores('logs/2026/october.txt', false), true);
    assert.equal(rules.ignores('logs', true), false, 'the folder itself is not beneath itself');
    assert.equal(rules.ignores('notes.log.md', false), false);
    assert.equal(rules.ignores('outside', true), false);
});

test('the folder\'s own .markestignore is read line by line, whatever its line ends; none is no lines', async () => {
    const root = await makeFolder({ '.markestignore': 'a.md\nb.md\r\nc/\n', 'x.md': 'x' });
    assert.deepEqual(await readIgnoreLines(root), ['a.md', 'b.md', 'c/', '']);
    assert.deepEqual(await readIgnoreLines(await makeFolder({ 'x.md': 'x' })), []);
});
