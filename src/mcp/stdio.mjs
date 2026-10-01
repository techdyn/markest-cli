/**
 * @module cli/mcp/stdio
 * @description The Model Context Protocol's stdio transport: one JSON-RPC
 *              message a line on stdin, one answer a line on stdout, in the
 *              order the requests came, and nothing else ever written to stdout
 *              - anything to say goes to stderr. A blank line is passed over. It
 *              ends when stdin does.
 *
 * @input A readable stdin, a writable stdout, `handleLine(line)`
 * @output Answers on stdout; resolves when stdin ends
 * @dependencies node:readline
 */

import { createInterface } from 'node:readline';

export async function serveLines(input, output, handleLine) {
    const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
    let queue = Promise.resolve();
    for await (const line of lines) {
        if (line.trim() === '') continue;
        // In order: each answer waits for the one before it
        queue = queue.then(async () => {
            const answer = await handleLine(line);
            if (answer !== null) output.write(JSON.stringify(answer) + '\n');
        });
    }
    await queue;
}
