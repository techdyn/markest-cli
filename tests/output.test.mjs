/**
 * How every command answers (cli/core/output): exit codes that each mean one
 * thing, text without control characters, one line of JSON, aligned columns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, jsonLine, printable, table } from '../src/core/output.mjs';

test('each exit code means one thing', () => {
    assert.deepEqual(EXIT, { OK: 0, FAILED: 1, USAGE: 2, AWAITING_APPROVAL: 3, REFUSED: 4 });
    assert.ok(Object.isFrozen(EXIT));
});

test('no escape sequence or other control character reaches a terminal', () => {
    assert.equal(printable('ok\ttab\nline'), 'ok\ttab\nline');
    assert.equal(printable('a\u001b[31mb\u0007c\u009bd\u007fe'), 'a[31mbcde');
    assert.equal(printable(null), '');
    assert.equal(printable(undefined), '');
    assert.equal(printable(42), '42');
});

test('JSON is one line', () => {
    assert.equal(jsonLine({ a: 'x\ny' }), '{"a":"x\\ny"}\n');
});

test('rows line up under their labels, one line each, the last column unpadded', () => {
    const text = table([{ id: 'A', title: 'First\nline', n: 3 }, { id: 'BBBB', title: 'Ü', n: null }], [
        { key: 'id', label: 'ID' }, { key: 'title', label: 'TITLE' }, { key: 'n', label: 'DOCS' },
    ]);
    assert.equal(text, 'ID    TITLE       DOCS\nA     First line  3\nBBBB  Ü\n');
    assert.equal(table([], [{ key: 'id', label: 'ID' }]), 'ID\n', 'the labels alone for no rows');
    assert.equal(table([{ id: 'a\u001b[2Jb' }], [{ key: 'id', label: 'ID' }]), 'ID\na[2Jb\n');
    assert.equal(table([{ a: 'one\r\n\n\ttwo', b: 'x' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]), 'A        B\none two  x\n', 'a run of breaks is one space');
    assert.equal(table([{ a: 'x', b: '' }], [{ key: 'a', label: 'LONGER' }, { key: 'b', label: 'B' }]), 'LONGER  B\nx\n', 'no line ends in spaces');
});
