/**
 * @module cli/commands/mcp
 * @description `markest mcp`: a Model Context Protocol server on stdio, for an
 *              agent client to start - Claude Code, Claude Desktop, Cursor,
 *              Codex, VS Code - offering the tools for artifacts encrypted end to
 *              end alone (D-20261001-01), beside the remote Markest connector,
 *              which offers the rest. Its stdout is the protocol's and nothing
 *              else's; the site and the API key come from the environment the
 *              client starts it with, MARKEST_URL and MARKEST_API_KEY.
 *
 * @input A run's context; JSON-RPC on stdin
 * @output JSON-RPC on stdout; exit 0 when stdin ends
 * @dependencies cli/core/command-kit, cli/core/output, cli/mcp/json-rpc, cli/mcp/stdio, cli/mcp/sealed-tools
 */

import { isRefusal } from '../core/command-kit.mjs';
import { EXIT } from '../core/output.mjs';
import { createRpc } from '../mcp/json-rpc.mjs';
import { serveLines } from '../mcp/stdio.mjs';
import { INSTRUCTIONS, sealedTools } from '../mcp/sealed-tools.mjs';

const HELP = `Run a Model Context Protocol server on stdio with the tools for Markest
artifacts encrypted end to end, which the remote Markest connector cannot
open: create, read, add or replace documents, remove documents, give the
link, keep a key. They seal and open on this machine; Markest gets only
ciphertext. Text an agent reads through them passes through its
conversation, so its model provider sees it.

Usage:
  markest mcp

An agent client starts it. For Claude Code:
  claude mcp add markest-sealed -e MARKEST_API_KEY=mk_live_... -- markest mcp

The site is MARKEST_URL (default https://marke.st); the API key,
MARKEST_API_KEY, is needed to create and change artifacts, not to read
one by its link. Keys are kept as markest keys keeps them.
`;

export const command = {
    name: 'mcp',
    summary: 'A local MCP server with the tools for encrypted artifacts',
    usage: 'markest mcp',
    help: HELP,
    flags: {},
    parse(values, positionals) {
        return positionals.length > 0 ? { usageError: 'markest mcp takes nothing: an agent client starts it' } : {};
    },
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        // Nothing on stdout but the protocol: whatever the tools would print goes to stderr
        const quiet = { ...ctx, stdout: ctx.stderr };
        const rpc = createRpc({ name: 'markest-sealed', version: ctx.version, instructions: INSTRUCTIONS, tools: sealedTools(quiet), isRefusal });
        await serveLines(ctx.stdin, ctx.stdout, rpc.handleLine);
        return EXIT.OK;
    },
};
