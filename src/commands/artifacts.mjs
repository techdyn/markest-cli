/**
 * @module cli/commands/artifacts
 * @description The artifacts an account has: `markest list` (filtered, paged
 *              or all at once), `markest show` (one artifact's settings and its
 *              documents, without their text) and `markest delete` (one or more,
 *              only with `--yes`, as it cannot be undone). Over the REST API, with
 *              its permissions: list_own, read_own, delete_own.
 *
 * @input The commands' flags and artifacts; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/site-args, cli/core/output
 */

import { answer, artifactsFrom, clientsFor, when } from '../core/command-kit.mjs';
import { visibilityFrom } from '../core/site-args.mjs';
import { EXIT, jsonLine, printable, table } from '../core/output.mjs';

/** At most this many pages are read for `--all`: 100 a page, so 5,000 artifacts. */
export const MAX_PAGES = 50;

const visibilityOf = (paste) => paste.visibility + (paste.sealed ? ', encrypted' : '');

const list = {
    name: 'list',
    summary: 'List your artifacts, filtered by words, folder or visibility',
    usage: 'markest list [--search <words>] [--folder <name>] [--visibility <v>]',
    help: `List your artifacts, newest first.

Usage:
  markest list [options]

Options:
  --search <words>      Only those whose title or text holds them
  --folder <name>       Only those filed in this folder
  --visibility <v>      Only public, unlisted or private ones
  --limit <n>           At most this many (default 100)
  --offset <n>          Start after this many
  --all                 Every page, not only the first
  --json                The site's answer as one JSON object

Needs a key with list_own.
`,
    flags: {
        search: { type: 'string' },
        folder: { type: 'string' },
        visibility: { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
        all: { type: 'boolean' },
    },
    parse(values, positionals) {
        if (positionals.length > 0) return { usageError: 'list takes no artifact; to read one, markest show <artifact>' };
        const visibility = visibilityFrom(values.visibility);
        if (visibility.usageError) return visibility;
        const number = (flag) => (values[flag] === undefined ? null : /^\d+$/.test(values[flag]) ? Number(values[flag]) : NaN);
        const limit = number('limit');
        const offset = number('offset');
        if (Number.isNaN(limit) || limit === 0) return { usageError: '--limit is a number from 1' };
        if (Number.isNaN(offset)) return { usageError: '--offset is a number' };
        return { search: values.search ?? '', folder: values.folder ?? '', visibility: visibility.visibility, limit, offset: offset ?? 0, all: Boolean(values.all) };
    },
    needsKey: () => true,
    async run(ctx) {
        const { rest } = clientsFor(ctx);
        return answer(ctx, async () => {
            const query = { offset: String(ctx.offset) };
            if (ctx.search !== '') query.query = ctx.search;
            if (ctx.folder !== '') query.folder = ctx.folder;
            if (ctx.visibility) query.visibility = ctx.visibility;
            if (ctx.limit !== null) query.limit = String(ctx.limit);
            const first = (await rest.request('GET', '/api/v1/pastes', { query, idempotent: true })).body;
            const pastes = [...(first.pastes ?? [])];
            let page = first;
            for (let n = 1; ctx.all && page.has_more && page.next_offset !== undefined && n < MAX_PAGES; n++) {
                page = (await rest.request('GET', '/api/v1/pastes', { query: { ...query, offset: String(page.next_offset) }, idempotent: true })).body;
                pastes.push(...(page.pastes ?? []));
            }
            return { pastes, total: first.total ?? pastes.length, count: pastes.length, has_more: pastes.length < (first.total ?? 0) };
        }, (found) => {
            const rows = found.pastes.map((paste) => ({ ...paste, shown: visibilityOf(paste), updated: when(paste.updated_at) }));
            if (found.has_more) ctx.stderr.write(found.count + ' of ' + found.total + ' shown; --all for every one.\n');
            return table(rows, [
                { key: 'id', label: 'ID' }, { key: 'shown', label: 'VISIBILITY' }, { key: 'document_count', label: 'DOCS' },
                { key: 'updated', label: 'UPDATED (UTC)' }, { key: 'title', label: 'TITLE' },
            ]);
        });
    },
};

const show = {
    name: 'show',
    summary: 'One artifact\'s settings and documents',
    usage: 'markest show <artifact>',
    help: `Show one artifact: its title, address, visibility, folder, dates and
whether it is encrypted end to end, and its documents with their types and
sizes. To read a document, markest read.

Usage:
  markest show <artifact>

The artifact is its id or any of its addresses. Needs a key with read_own.
`,
    flags: {},
    parse(values, positionals) {
        return artifactsFrom(positionals, { usage: 'markest show <artifact>' });
    },
    needsKey: () => true,
    async run(ctx) {
        const { rest } = clientsFor(ctx);
        return answer(ctx, async () => {
            const paste = (await rest.request('GET', '/api/v1/pastes/' + ctx.ids[0], { idempotent: true })).body;
            // What a document says is read's to show; its length is enough here
            const documents = (paste.documents ?? []).map(({ content, ...doc }) => doc);
            return { ...paste, url: ctx.baseUrl + '/p/' + paste.id, documents };
        }, (paste) => {
            const lines = [
                printable(paste.title || '(untitled)'),
                '  ' + paste.url,
                '  ' + visibilityOf(paste) + (paste.folder ? ', in ' + printable(paste.folder) : ''),
                '  created ' + when(paste.created_at) + ', updated ' + when(paste.updated_at) + (paste.expires_at ? ', expires ' + when(paste.expires_at) : ''),
                '',
            ];
            const rows = paste.documents.map((doc) => ({ ...doc, opens: doc.path === paste.default_path ? '*' : '' }));
            return lines.join('\n') + '\n' + table(rows, [
                { key: 'opens', label: '' }, { key: 'path', label: 'PATH' }, { key: 'content_type', label: 'TYPE' }, { key: 'bytes', label: 'BYTES' }, { key: 'title', label: 'TITLE' },
            ]);
        });
    },
};

const remove = {
    name: 'delete',
    summary: 'Delete artifacts for good (needs --yes)',
    usage: 'markest delete <artifact>... --yes',
    help: `Delete one or more artifacts. This cannot be undone: their documents,
images, versions and comments go with them, and every link to them stops
working. Nothing is deleted without --yes.

Usage:
  markest delete <artifact>... --yes

Needs a key with delete_own.
`,
    flags: { yes: { type: 'boolean' } },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest delete <artifact>... --yes', max: 100 });
        if (named.usageError) return named;
        if (!values.yes) return { usageError: 'Deleting cannot be undone. Add --yes to delete ' + (named.ids.length === 1 ? 'it' : 'these ' + named.ids.length) + '.' };
        return named;
    },
    needsKey: () => true,
    async run(ctx) {
        const { rest } = clientsFor(ctx);
        const deleted = [];
        const code = await answer(ctx, async () => {
            for (const id of ctx.ids) {
                await rest.request('DELETE', '/api/v1/pastes/' + id, { idempotent: true });
                deleted.push(id);
            }
            return { deleted };
        }, (done) => done.deleted.map((id) => 'Deleted ' + id + '\n').join(''));
        // What went before a refusal is gone all the same, and is said - to a script too, as a line after the error
        if (code !== EXIT.OK && deleted.length > 0) {
            if (ctx.json) ctx.stdout.write(jsonLine({ deleted }));
            else ctx.stderr.write('Deleted before that: ' + deleted.join(', ') + '\n');
        }
        return code;
    },
};

export const commands = [list, show, remove];
