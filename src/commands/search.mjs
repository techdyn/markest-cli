/**
 * @module cli/commands/search
 * @description `markest grep`: a regular expression - or a fixed string - over
 *              the documents of every artifact the account may change, or of
 *              those named, printed as grep prints: the artifact and path, the
 *              line number, the line, and context lines marked apart. Over the
 *              agent tools, which the plan's agent access opens. Artifacts
 *              encrypted end to end are passed over: the site holds only
 *              envelopes.
 *
 * @input The command's flags and pattern; a run's context
 * @output The exit code: 0 with matches, 1 without, as grep's
 * @dependencies cli/core/command-kit, cli/core/output
 */

import { answer, artifactsFrom, clientsFor } from '../core/command-kit.mjs';
import { EXIT, printable } from '../core/output.mjs';

const MODES = { content: 'content', files: 'files', count: 'count' };

/** The results as grep prints them. */
export function renderMatches(result, mode) {
    const out = [];
    for (const one of result.results ?? []) {
        const where = one.paste_id + ':' + printable(one.path);
        if (one.error) {
            out.push(where + ': ' + printable(one.error));
            continue;
        }
        if (mode === 'files') out.push(where);
        else if (mode === 'count') out.push(where + ':' + one.matches);
        else for (const line of one.lines ?? []) out.push(where + (line.match ? ':' : '-') + line.line + (line.match ? ':' : '-') + printable(line.text));
    }
    return out.length === 0 ? '' : out.join('\n') + '\n';
}

const grep = {
    name: 'grep',
    summary: 'Search your artifacts\' documents with a pattern',
    usage: 'markest grep <pattern> [--in <artifact>...] [-i] [--fixed]',
    help: `Search the documents of every artifact you may change - or those named
with --in - for a regular expression, and print what matched as grep does:
<artifact>:<path>:<line>:<text>, context lines with - for :.

Usage:
  markest grep <pattern> [options]

Options:
  --in <artifact>       Only this artifact (repeatable)
  --folder <name>       Only artifacts in this folder
  --glob <pattern>      Only documents whose path matches, such as **/*.md
  --fixed               The pattern is a plain string
  -i, --ignore-case     Upper and lower case alike
  -C, --context <n>     Lines of context around each match
  --files               Only which documents matched
  --count               Only how many matches each has
  --max <n>             At most this many matching lines
  --cursor <c>          The next page, from the last one

Exit code 0 with matches, 1 with none. Artifacts encrypted end to end are
passed over. Uses the site's agent tools: your plan must include agent
(MCP) access.
`,
    flags: {
        in: { type: 'string', multiple: true },
        folder: { type: 'string' },
        glob: { type: 'string' },
        fixed: { type: 'boolean' },
        'ignore-case': { type: 'boolean', short: 'i' },
        context: { type: 'string', short: 'C' },
        files: { type: 'boolean' },
        count: { type: 'boolean' },
        max: { type: 'string' },
        cursor: { type: 'string' },
    },
    parse(values, positionals) {
        const [pattern, ...extra] = positionals;
        if (pattern === undefined || pattern === '') return { usageError: 'Name what to look for: markest grep <pattern>' };
        if (extra.length > 0) return { usageError: 'One pattern; name artifacts with --in' };
        if (values.files && values.count) return { usageError: '--files or --count, not both' };
        // A folder, a glob or a cursor not given is undefined, which the request's JSON leaves out
        const args = { pattern, folder: values.folder, glob: values.glob, cursor: values.cursor };
        if ((values.in ?? []).length > 0) {
            const named = artifactsFrom(values.in, { usage: 'markest grep <pattern> --in <artifact>', max: 50 });
            if (named.usageError) return named;
            args.pastes = named.ids;
        }
        if (values.fixed) args.fixed_strings = true;
        if (values['ignore-case']) args.ignore_case = true;
        for (const [flag, field] of [['context', 'context'], ['max', 'max_results']]) {
            if (values[flag] === undefined) continue;
            if (!/^\d{1,4}$/.test(values[flag])) return { usageError: '--' + flag + ' is a number' };
            args[field] = Number(values[flag]);
        }
        const mode = values.files ? MODES.files : values.count ? MODES.count : MODES.content;
        args.output_mode = mode;
        return { args, mode };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        let found = 0;
        const code = await answer(ctx, async () => {
            const result = await agent.call('markest_grep', ctx.args, { reads: true });
            found = result.total_matches ?? (result.results ?? []).length;
            return result;
        }, (result) => {
            if (result.has_more) ctx.stderr.write('More matches: --cursor ' + result.next_cursor + '\n');
            return renderMatches(result, ctx.mode);
        });
        // A refusal is exit 1 already, and leaves found at 0
        return found === 0 ? EXIT.FAILED : code;
    },
};

export const commands = [grep];
