/**
 * @module cli/commands/history
 * @description An artifact's version history, where it keeps one: `markest
 *              versions` lists the versions, or shows one and a document as it
 *              kept it (REST, read_own, the owner's); `markest diff` shows what
 *              changed between two, and `markest restore` brings one back - the
 *              whole of it or one document - as a new version (the agent tools,
 *              which the plan's agent access opens).
 *
 * @input The commands' flags, artifact and version numbers; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/output
 */

import { answer, artifactsFrom, clientsFor, when } from '../core/command-kit.mjs';
import { printable, table } from '../core/output.mjs';

const NUMBER = /^[1-9]\d{0,8}$/;

/** Lists of documents a version records, and the word for each (VersionPayload::describe). */
const DOCUMENT_CHANGES = { added: 'added', removed: 'removed', modified: 'edited', retitled: 'retitled', renamed: 'renamed' };

/**
 * What a version changed, in a few words, read as the site records it
 * (VersionChanges::between): the title and the opening document as a pair of
 * before and after, the documents as lists, reordering as a flag.
 */
export function changesIn(changes) {
    // Nothing recorded says nothing; a value that is not an object has none of the fields below, so says nothing too
    if (!changes) return '';
    const parts = [];
    if (Array.isArray(changes.title)) parts.push('title');
    if (Array.isArray(changes.default_document)) parts.push('opening document');
    for (const [key, word] of Object.entries(DOCUMENT_CHANGES)) {
        if (Array.isArray(changes[key]) && changes[key].length > 0) parts.push(changes[key].length + ' ' + word);
    }
    if (changes.reordered) parts.push('reordered');
    return parts.join(', ');
}

const versions = {
    name: 'versions',
    summary: 'An artifact\'s versions, one version, or a document as it was',
    usage: 'markest versions <artifact> [<number>] [--path <path>]',
    help: `An artifact's version history, where it keeps one (markest set
<artifact> --versions on).

Usage:
  markest versions <artifact>                     Every version, newest first
  markest versions <artifact> <number>            One version's documents
  markest versions <artifact> <number> --path p   A document as it kept it

Needs a key with read_own, on an artifact you own.
`,
    flags: { path: { type: 'string' } },
    parse(values, positionals) {
        const [reference, number, ...extra] = positionals;
        if (extra.length > 0) return { usageError: 'markest versions <artifact> [<number>] [--path <path>]' };
        const named = artifactsFrom(reference === undefined ? [] : [reference], { usage: 'markest versions <artifact> [<number>]' });
        if (named.usageError) return named;
        if (number !== undefined && !NUMBER.test(number)) return { usageError: 'A version is its number: 1, 2, 3 ...' };
        if (values.path !== undefined && number === undefined) return { usageError: '--path reads a document as one version kept it: name the version' };
        return { ids: named.ids, number: number === undefined ? null : Number(number), path: values.path ?? null };
    },
    needsKey: () => true,
    async run(ctx) {
        const { rest } = clientsFor(ctx);
        const base = '/api/v1/pastes/' + ctx.ids[0] + '/versions';
        if (ctx.number === null) {
            return answer(ctx, async () => (await rest.request('GET', base, { idempotent: true })).body, (body) => {
                if (!body.track_versions && (body.versions ?? []).length === 0) return 'It keeps no versions. markest set ' + ctx.ids[0] + ' --versions on keeps them from now.\n';
                return table((body.versions ?? []).map((one) => ({ ...one, at: when(one.created_at), changed: changesIn(one.changes) })), [
                    { key: 'number', label: 'VERSION' }, { key: 'at', label: 'SAVED (UTC)' }, { key: 'source', label: 'FROM' }, { key: 'document_count', label: 'DOCS' },
                    { key: 'changed', label: 'CHANGES' }, { key: 'title', label: 'TITLE' },
                ]);
            });
        }
        const query = ctx.path === null ? {} : { path: ctx.path };
        return answer(ctx, async () => (await rest.request('GET', base + '/' + ctx.number, { query, idempotent: true })).body, (body) => {
            if (ctx.path !== null) return String(body.document?.content ?? '');
            return 'Version ' + body.number + ' (' + when(body.created_at) + ', ' + printable(body.source) + '): ' + printable(body.title ?? '') + '\n'
                + table((body.documents ?? []).map((doc) => ({ ...doc, opens: doc.path === body.default_path ? '*' : '' })), [
                    { key: 'opens', label: '' }, { key: 'path', label: 'PATH' }, { key: 'content_type', label: 'TYPE' }, { key: 'title', label: 'TITLE' },
                ]);
        });
    },
};

const diff = {
    name: 'diff',
    summary: 'What changed between two versions of an artifact',
    usage: 'markest diff <artifact> <from> [<to>] [--path <path>]',
    help: `What changed between versions, as a unified diff.

Usage:
  markest diff <artifact> <from> [<to>]       From one version to another
  markest diff <artifact> --changes <n>       What version <n> changed

A version is its number, or "current" for the artifact as it is now;
<to> is the artifact as it is now unless named. markest versions lists them.

Options:
  --path <path>        One document only, or those matching a glob
  --stat               Only which documents changed, and by how many lines
  --context <n>        Lines of context around each change (default 3)

Uses the site's agent tools: your plan must include agent (MCP) access.
`,
    flags: { path: { type: 'string' }, stat: { type: 'boolean' }, context: { type: 'string' }, changes: { type: 'string' } },
    parse(values, positionals) {
        const usage = 'markest diff <artifact> <from> [<to>], or markest diff <artifact> --changes <n>';
        const [reference, from, to, ...extra] = positionals;
        if (extra.length > 0) return { usageError: usage };
        const named = artifactsFrom(reference === undefined ? [] : [reference], { usage });
        if (named.usageError) return named;
        const side = (value) => (value === undefined ? undefined : value === 'current' ? 'current' : NUMBER.test(value) ? Number(value) : null);
        if (side(from) === null || side(to) === null || side(values.changes) === null) return { usageError: 'A version is its number, or current' };
        // The site compares from a version, or shows what one version changed: one of the two is named
        if ((from === undefined) === (values.changes === undefined)) return { usageError: 'Name the versions: ' + usage };
        if (values.context !== undefined && !/^\d{1,3}$/.test(values.context)) return { usageError: '--context is a number of lines' };
        // What is not named is undefined, which the request's JSON leaves out; --changes and <to> are never both named
        const args = { paste_id: named.ids[0], from: side(from), to: side(values.changes ?? to), path: values.path };
        if (values.stat) args.stat_only = true;
        if (values.context !== undefined) args.context = Number(values.context);
        return { ids: named.ids, args };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, () => agent.call('markest_diff_versions', ctx.args, { reads: true }), (result) => {
            const head = (result.files ?? []).map((file) => printable(file.status + ' ' + file.path + (file.old_path ? ' (was ' + file.old_path + ')' : '')) + '  +' + (file.added ?? 0) + ' -' + (file.removed ?? 0)).join('\n');
            const body = typeof result.diff === 'string' && result.diff !== '' ? '\n' + result.diff : '';
            return 'Version ' + result.from + ' to ' + result.to + '\n' + (head || 'No document changed.') + '\n' + body + (body.endsWith('\n') || body === '' ? '' : '\n');
        });
    },
};

const restore = {
    name: 'restore',
    summary: 'Bring back a version, or one document from it, as a new version',
    usage: 'markest restore <artifact> <number> [--path <path>]',
    help: `Bring back a version as a new version: the whole artifact as it was, or
with --path one document as it was. Nothing is lost; the version it
replaces stays in the history.

Usage:
  markest restore <artifact> <number> [--path <path>]

Uses the site's agent tools: your plan must include agent (MCP) access.
`,
    flags: { path: { type: 'string' } },
    parse(values, positionals) {
        const [reference, number, ...extra] = positionals;
        if (number === undefined || extra.length > 0) return { usageError: 'markest restore <artifact> <number> [--path <path>]' };
        // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent - a number is named only after an artifact, so exactly one is given and the usage is never said
        const named = artifactsFrom([reference], { usage: 'markest restore <artifact> <number>' });
        if (named.usageError) return named;
        if (!NUMBER.test(number)) return { usageError: 'A version is its number: 1, 2, 3 ...' };
        // A path not named is undefined, which the request's JSON leaves out
        return { ids: named.ids, args: { paste_id: named.ids[0], number: Number(number), path: values.path } };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, () => agent.call('markest_restore_version', ctx.args), (result) => 'Restored ' + (result.path ? printable(result.path) + ' from ' : '') + 'version ' + result.restored_from
            + (result.version ? ', saved as version ' + result.version : '') + '.\n');
    },
};

export const commands = [versions, diff, restore];
