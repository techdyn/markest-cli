/**
 * The stdio transport (cli/mcp/stdio): one message a line, answers in the order
 * asked whatever each takes, blank lines passed over, nothing written for a
 * notification, and done when stdin is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { serveLines } from '../src/mcp/stdio.mjs';

test('each line is answered in turn, in the order asked, and nothing else is written', async () => {
    const written = [];
    const input = Readable.from(['{"n":1}\n\n{"n":2}\r\n', '{"n":', '3}\n{"note":true}\n']);
    const delays = { 1: 30, 2: 0, 3: 10 };
    await serveLines(input, { write: (text) => written.push(text) }, async (line) => {
        const message = JSON.parse(line);
        if (message.note) return null;
        await new Promise((resolve) => setTimeout(resolve, delays[message.n]));
        return { answer: message.n };
    });
    assert.deepEqual(written, ['{"answer":1}\n', '{"answer":2}\n', '{"answer":3}\n'], 'in order, one line each, a message split across chunks joined');
});

test('it ends when stdin does', async () => {
    const written = [];
    await serveLines(Readable.from([]), { write: (text) => written.push(text) }, async () => ({}));
    assert.deepEqual(written, []);
});

test('a line of spaces is no message, and every line reaches the handler byte for byte, as a pipe brings it and never as a terminal would edit it', async () => {
    const seen = [];
    await serveLines(Readable.from([' \t \n', 'ab\bc\x7fd\n', '\tlead\n']), { write() {} }, async (line) => {
        seen.push(line);
        return null;
    });
    assert.deepEqual(seen, ['ab\bc\x7fd', '\tlead']);
});
