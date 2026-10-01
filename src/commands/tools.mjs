/**
 * @module cli/commands/tools
 * @description Every agent tool the site has, from the command line, so the
 *              tool can never fall behind the site: `markest tools` lists those
 *              the key may use, and `markest call` runs any one with arguments
 *              as JSON - given, or piped in with `-` - printing its answer as
 *              JSON. Over the agent tools, which the plan's agent access opens.
 *
 * @input The commands' flags, tool name and arguments; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/output
 */

import { answer, clientsFor, readAll, Refused } from '../core/command-kit.mjs';
import { jsonLine, printable } from '../core/output.mjs';

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A tool's description, cut to its first sentence for a list. */
export function firstSentence(text) {
    const one = String(text ?? '').replace(/\s+/g, ' ').trim();
    // A sentence that ends the text is the whole text, so only one followed by a space is looked for
    const end = one.search(/[.!?]\s/);
    return printable(end === -1 ? one : one.slice(0, end + 1));
}

const tools = {
    name: 'tools',
    summary: 'The site\'s agent tools your key may use',
    usage: 'markest tools [<name>]',
    help: `The site's agent tools your key may use, each with what it does; with a
name, that tool's arguments as JSON Schema. Run one with markest call.

Usage:
  markest tools [<name>]

Uses the site's agent tools: your plan must include agent (MCP) access.
`,
    flags: {},
    parse(values, positionals) {
        if (positionals.length > 1) return { usageError: 'markest tools [<name>]' };
        const [name] = positionals;
        if (name === undefined) return { tool: null };
        if (!NAME.test(name)) return { usageError: '"' + name + '" is not a tool\'s name' };
        return { tool: name };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, async () => {
            const all = await agent.tools();
            if (ctx.tool === null) return { tools: all.map((one) => ({ name: one.name, title: one.title ?? null, description: one.description ?? '', read_only: Boolean(one.annotations?.readOnlyHint) })) };
            const one = all.find((tool) => tool.name === ctx.tool);
            if (!one) throw new Refused('There is no tool "' + ctx.tool + '" this key may use: markest tools lists them.');
            return one;
        }, (result) => {
            if (ctx.tool !== null) return printable(result.description ?? '') + '\n\nArguments:\n' + JSON.stringify(result.inputSchema ?? {}, null, 2) + '\n';
            const width = Math.max(0, ...result.tools.map((one) => one.name.length));
            return result.tools.map((one) => one.name.padEnd(width) + '  ' + (one.read_only ? '' : '* ') + firstSentence(one.description)).join('\n') + '\n\n* changes something\n';
        });
    },
};

const call = {
    name: 'call',
    summary: 'Run any of the site\'s agent tools, with JSON arguments',
    usage: 'markest call <tool> [<json>|-]',
    help: `Run any of the site's agent tools, with its arguments as one JSON
object - given, or piped in with - - and print its answer as JSON.

Usage:
  markest call <tool> '{"paste_id": "01J..."}'
  echo '{"query": "plan"}' | markest call search -

markest tools lists the tools, and markest tools <tool> its arguments.
Uses the site's agent tools: your plan must include agent (MCP) access.
`,
    flags: {},
    parse(values, positionals) {
        const [tool, json, ...extra] = positionals;
        if (tool === undefined || extra.length > 0) return { usageError: 'markest call <tool> [<json>|-]' };
        if (!NAME.test(tool)) return { usageError: '"' + tool + '" is not a tool\'s name' };
        if (json === undefined || json === '-') return { tool, fromStdin: json === '-', args: {} };
        let args;
        try {
            args = JSON.parse(json);
        } catch {
            return { usageError: 'The arguments are not JSON: ' + json };
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) return { usageError: 'The arguments are one JSON object' };
        return { tool, fromStdin: false, args };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, async () => {
            let args = ctx.args;
            if (ctx.fromStdin) {
                const text = await readAll(ctx.stdin);
                try {
                    args = JSON.parse(text);
                } catch {
                    throw new Refused('What arrived on stdin is not JSON.');
                }
                if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Refused('The arguments are one JSON object.');
            }
            return agent.call(ctx.tool, args);
        }, (result) => jsonLine(result));
    },
};

export const commands = [tools, call];
