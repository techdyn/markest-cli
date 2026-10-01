/**
 * @module cli/commands/conversation
 * @description The conversation under artifacts: `markest comments` reads the
 *              threads - on one artifact, or on every one the account owns -
 *              `markest reply` answers a comment, and `markest resolve` resolves
 *              threads or reopens them. Over the agent tools, so the plan's
 *              agent access opens them, and the site's own rules apply: who may
 *              resolve, how many replies an hour. A reply's text may be piped in
 *              with `-`.
 *
 * @input The commands' flags, artifact and comment ids; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/output
 */

import { answer, artifactsFrom, clientsFor, readAll, Refused, when } from '../core/command-kit.mjs';
import { printable } from '../core/output.mjs';

const STATUSES = ['unresolved', 'resolved', 'all'];
const COMMENT = /^[0-9A-Z]{26}$/i;
const AGENT_NOTE = 'Uses the site\'s agent tools: your plan must include agent (MCP) access.';

/** Who wrote it, and whether that is the artifact's owner or you. */
const who = (author) => (author ? printable(author.name ?? 'Someone') + (author.is_you ? ' (you)' : author.is_owner ? ' (owner)' : '') : '(deleted)');
const quoted = (text, prefix) => printable(text).split('\n').map((line) => prefix + line).join('\n');

/** A thread as a person reads it: where it is, the first comment, then its replies, each with the id to answer it by. */
export function renderThread(thread) {
    const lines = ['On "' + printable(thread.paste_title ?? '') + '" ' + printable(thread.url ?? '') + (thread.resolved ? '  (resolved)' : thread.awaiting_answer ? '  (awaiting an answer)' : '')];
    lines.push('  [' + thread.id + '] ' + who(thread.author) + ', ' + when(thread.created_at));
    lines.push(quoted(thread.deleted ? '(deleted)' : thread.body ?? '', '  > '));
    if (thread.replies_not_shown > 0) lines.push('    (' + thread.replies_not_shown + ' earlier replies not shown)');
    for (const reply of thread.replies ?? []) {
        lines.push('    [' + reply.id + '] ' + who(reply.author) + ', ' + when(reply.created_at));
        lines.push(quoted(reply.deleted ? '(deleted)' : reply.body ?? '', '    > '));
    }
    return lines.join('\n') + '\n';
}

const comments = {
    name: 'comments',
    summary: 'Read the comment threads on your artifacts',
    usage: 'markest comments [<artifact>] [--status <s>]',
    help: `Read the comment threads under an artifact, or under every artifact you
own. Each comment shows the id to answer it by: markest reply <id> <text>.

Usage:
  markest comments [<artifact>] [options]

Options:
  --status <s>          unresolved (the default), resolved or all
  --since <date>        Only threads with a comment at or after this ISO date
  --limit <n>           Threads per page, 1-50 (default 20)
  --cursor <c>          The next page, from the last one

${AGENT_NOTE}
`,
    flags: { status: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } },
    parse(values, positionals) {
        const named = positionals.length === 0 ? { ids: [] } : artifactsFrom(positionals, { usage: 'markest comments [<artifact>]' });
        if (named.usageError) return named;
        // An artifact, a date or a cursor not given is undefined, which the request's JSON leaves out
        const args = { paste_id: named.ids[0], since: values.since, cursor: values.cursor };
        if (values.status !== undefined) {
            if (!STATUSES.includes(values.status)) return { usageError: '--status is ' + STATUSES.join(', ') };
            args.status = values.status;
        }
        if (values.limit !== undefined) {
            if (!/^\d{1,2}$/.test(values.limit) || Number(values.limit) < 1 || Number(values.limit) > 50) return { usageError: '--limit is 1 to 50' };
            args.limit = Number(values.limit);
        }
        return { ids: named.ids, args };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, () => agent.call('markest_list_comments', ctx.args, { reads: true }), (result) => {
            const threads = result.threads ?? [];
            if (threads.length === 0) return 'No ' + (result.status === 'all' ? '' : (result.status ?? 'unresolved') + ' ') + 'threads.\n';
            if (result.has_more) ctx.stderr.write(threads.length + ' of ' + result.total + ' threads; the next page: --cursor ' + result.next_cursor + '\n');
            return threads.map(renderThread).join('\n');
        });
    },
};

const reply = {
    name: 'reply',
    summary: 'Answer a comment',
    usage: 'markest reply <comment-id> <text|->',
    help: `Answer a comment: the first comment of a thread, or a reply in it.

Usage:
  markest reply <comment-id> <text> [--resolve]
  markest reply <comment-id> - < answer.txt

The text is plain; - reads it from stdin. markest comments shows the ids.

Options:
  --resolve             Also mark the thread resolved

${AGENT_NOTE}
`,
    flags: { resolve: { type: 'boolean' } },
    parse(values, positionals) {
        const [id, ...words] = positionals;
        // With no comment id there are no words either
        if (words.length === 0) return { usageError: 'markest reply <comment-id> <text|->' };
        if (!COMMENT.test(id)) return { usageError: '"' + id + '" is not a comment id: markest comments shows them' };
        return { commentId: id.toUpperCase(), text: words.join(' '), resolve: Boolean(values.resolve) };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, async () => {
            const body = ctx.text === '-' ? (await readAll(ctx.stdin)).replace(/\s+$/, '') : ctx.text;
            if (body.trim() === '') throw new Refused('There is nothing to say: the reply is empty.');
            const one = { comment_id: ctx.commentId, body };
            if (ctx.resolve) one.resolve = true;
            return agent.call('markest_reply_to_comments', { replies: [one] });
        }, (result) => 'Replied' + (ctx.resolve ? ' and resolved the thread' : '') + '. ' + result.left_this_hour + ' more replies this hour.\n');
    },
};

const resolve = {
    name: 'resolve',
    summary: 'Resolve comment threads, or reopen them',
    usage: 'markest resolve <comment-id>... [--reopen]',
    help: `Resolve comment threads, or reopen them with --reopen. A thread is
named by any comment in it. Its artifact's owner, or the thread's author,
may resolve it.

Usage:
  markest resolve <comment-id>... [--reopen]

${AGENT_NOTE}
`,
    flags: { reopen: { type: 'boolean' } },
    parse(values, positionals) {
        if (positionals.length === 0) return { usageError: 'markest resolve <comment-id>... [--reopen]' };
        const bad = positionals.find((id) => !COMMENT.test(id));
        if (bad !== undefined) return { usageError: '"' + bad + '" is not a comment id: markest comments shows them' };
        return { commentIds: positionals.map((id) => id.toUpperCase()), resolved: !values.reopen };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, () => agent.call('markest_resolve_comments', { comment_ids: ctx.commentIds, resolved: ctx.resolved }),
            () => (ctx.resolved ? 'Resolved ' : 'Reopened ') + ctx.commentIds.length + (ctx.commentIds.length === 1 ? ' thread' : ' threads') + '.\n');
    },
};

export const commands = [comments, reply, resolve];
