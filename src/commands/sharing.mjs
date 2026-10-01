/**
 * @module cli/commands/sharing
 * @description Who reads an artifact and how: `markest link` (its address, or a
 *              signed link to a private one), `markest collaborators` (list, add,
 *              remove by address), `markest fork` (a copy into the account),
 *              `markest views` (how often it was read, within what the plan
 *              shows) and `markest preview` (the picture it shows where it is
 *              listed). Over the agent tools, which the plan's agent access
 *              opens; `markest link` without `--signed` asks the site nothing.
 *              An artifact encrypted end to end is shared by a link carrying its
 *              key, which the sealing adds.
 *
 * @input The commands' flags and artifacts; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/output, cli/sealed/link-key
 */

import { answer, artifactsFrom, clientsFor, when } from '../core/command-kit.mjs';
import { EXIT, jsonLine, printable, table } from '../core/output.mjs';
import { withKnownKey } from '../sealed/link-key.mjs';

const AGENT_NOTE = 'Uses the site\'s agent tools: your plan must include agent (MCP) access.';
/** What a signed link may last (SignedLinkTools): 1 hour to 90 days. */
export const LINK_LIFETIMES = { '1h': 3600, '1d': 86400, '7d': 604800, '30d': 2592000, '90d': 7776000 };

const link = {
    name: 'link',
    summary: 'An artifact\'s link, or a signed link to a private one',
    usage: 'markest link <artifact> [--signed] [--expires <1h|1d|7d|30d|90d>]',
    help: `Print the link that shares an artifact.

Usage:
  markest link <artifact> [--path <path>]
  markest link <artifact> --signed [--expires <1h|1d|7d|30d|90d>]

A private artifact opens for someone else only by a signed link, which
works until it expires (7 days by default) and opens every document. For
an artifact encrypted end to end the link carries its key, when this
machine keeps it: whoever has the link can read it.

Options:
  --path <path>         Open on this document
  --signed              A signed link, for a private artifact (agent tools:
                        your plan must include agent (MCP) access)
  --expires <length>    How long a signed link works
`,
    flags: { signed: { type: 'boolean' }, expires: { type: 'string' }, path: { type: 'string' } },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest link <artifact>' });
        if (named.usageError) return named;
        if (values.expires !== undefined && !values.signed) return { usageError: '--expires is for a signed link: add --signed' };
        if (values.expires !== undefined && !(values.expires in LINK_LIFETIMES)) return { usageError: '--expires is one of ' + Object.keys(LINK_LIFETIMES).join(', ') };
        return { ids: named.ids, reference: positionals[0], signed: Boolean(values.signed), expiresIn: LINK_LIFETIMES[values.expires ?? '7d'], path: values.path ?? null };
    },
    needsKey: (asked) => asked.signed,
    async run(ctx) {
        const id = ctx.ids[0];
        if (!ctx.signed) {
            const url = await withKnownKey(ctx.baseUrl + '/p/' + id + (ctx.path ? '/' + ctx.path.split('/').map(encodeURIComponent).join('/') : ''), id, ctx);
            ctx.stdout.write(ctx.json ? jsonLine({ id, url }) : url + '\n');
            return EXIT.OK;
        }
        const { agent } = clientsFor(ctx);
        const args = { paste_id: id, expires_in: ctx.expiresIn };
        if (ctx.path) args.path = ctx.path;
        return answer(ctx, async () => {
            const result = await agent.call('markest_create_signed_link', args);
            return { ...result, url: await withKnownKey(result.url, id, ctx) };
        }, (result) => {
            ctx.stderr.write('Anyone with this link can read it until ' + when(result.expires_at) + ' UTC' + (result.password_protected ? ', with its password' : '') + '.\n');
            return result.url + '\n';
        });
    },
};

const collaborators = {
    name: 'collaborators',
    summary: 'List, add or remove an artifact\'s collaborators',
    usage: 'markest collaborators <artifact> [--add <email>...] [--remove <email>...]',
    help: `The people who may read an artifact, private ones included, by the
address they sign in with.

Usage:
  markest collaborators <artifact>                  List them
  markest collaborators <artifact> --add <email>...
  markest collaborators <artifact> --remove <email>...

${AGENT_NOTE}
`,
    flags: { add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true } },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest collaborators <artifact>' });
        if (named.usageError) return named;
        const add = values.add ?? [];
        const remove = values.remove ?? [];
        if (add.length > 0 && remove.length > 0) return { usageError: 'Add or remove, one at a time' };
        const bad = [...add, ...remove].find((email) => !/^[^@\s]+@[^@\s]+$/.test(email));
        if (bad !== undefined) return { usageError: '"' + bad + '" is not an email address' };
        return { ids: named.ids, add, remove };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        const tool = ctx.add.length > 0 ? 'markest_add_collaborators' : ctx.remove.length > 0 ? 'markest_remove_collaborators' : 'markest_list_collaborators';
        const args = { paste_id: ctx.ids[0] };
        if (ctx.add.length > 0) args.emails = ctx.add;
        if (ctx.remove.length > 0) args.emails = ctx.remove;
        return answer(ctx, () => agent.call(tool, args, { reads: tool === 'markest_list_collaborators' }), (result) => {
            const people = result.collaborators ?? [];
            if (people.length === 0) return 'No collaborators.\n';
            return table(people.map((one) => ({ ...one, since: when(one.added_at) })), [{ key: 'email', label: 'EMAIL' }, { key: 'since', label: 'ADDED (UTC)' }]);
        });
    },
};

const fork = {
    name: 'fork',
    summary: 'Copy artifacts into your account',
    usage: 'markest fork <artifact>... [--title <t>] [--visibility <unlisted|private>]',
    help: `Copy one or more artifacts you can read into your account: every
document with its type, and the images they show, within your plan. A copy
is unlisted unless --visibility private.

Usage:
  markest fork <artifact>... [--title <t>] [--visibility <unlisted|private>] [--folder <f>]

${AGENT_NOTE}
`,
    flags: { title: { type: 'string' }, visibility: { type: 'string' }, folder: { type: 'string' } },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest fork <artifact>...', max: 10 });
        if (named.usageError) return named;
        if (values.visibility !== undefined && !['unlisted', 'private'].includes(values.visibility)) return { usageError: '--visibility is unlisted or private' };
        if (values.title !== undefined && named.ids.length > 1) return { usageError: '--title names one copy: fork one artifact at a time to name it' };
        // A flag not given is undefined, which JSON leaves out of the request
        const args = { pastes: named.ids, title: values.title, visibility: values.visibility, folder: values.folder };
        return { ids: named.ids, args };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, () => agent.call('markest_fork_paste', ctx.args), (result) => (result.forks ?? [])
            .map((one) => (one.url ?? one.error ?? JSON.stringify(one)) + '\n').join(''));
    },
};

const views = {
    name: 'views',
    summary: 'How often your artifacts were read',
    usage: 'markest views <artifact>... [--days <n>] [--by-day] [--by-document]',
    help: `How often your artifacts were read, within the days your plan shows.
A reading is counted once, never yours, an administrator's or a machine's.

Usage:
  markest views <artifact>... [--days <n>] [--by-day] [--by-document]

${AGENT_NOTE}
`,
    flags: { days: { type: 'string' }, 'by-day': { type: 'boolean' }, 'by-document': { type: 'boolean' } },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest views <artifact>...', max: 50 });
        if (named.usageError) return named;
        const args = { paste_ids: named.ids };
        if (values.days !== undefined) {
            if (!/^\d{1,3}$/.test(values.days) || Number(values.days) < 1 || Number(values.days) > 366) return { usageError: '--days is 1 to 366' };
            args.days = Number(values.days);
        }
        if (values['by-day']) args.by_day = true;
        if (values['by-document']) args.by_document = true;
        return { ids: named.ids, args };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, () => agent.call('markest_get_views', ctx.args, { reads: true }), (result) => {
            const out = ['Views ' + result.since + ' to ' + result.until + ' (' + result.timezone + ')'];
            // Stryker disable next-line ArrayDeclaration: equivalent - a row with no fields draws an empty line, which trimEnd takes off, and has no days or documents
            const artifacts = result.artifacts ?? [];
            out.push(table(artifacts, [{ key: 'views', label: 'VIEWS' }, { key: 'embed_views', label: 'EMBEDDED' }, { key: 'paste_id', label: 'ID' }, { key: 'title', label: 'TITLE' }]).trimEnd());
            for (const artifact of artifacts) {
                if (artifact.by_day) out.push(printable(artifact.title) + ' by day:\n' + table(artifact.by_day, [{ key: 'date', label: 'DATE' }, { key: 'views', label: 'VIEWS' }, { key: 'embed_views', label: 'EMBEDDED' }]).trimEnd());
                if (artifact.by_document) out.push(printable(artifact.title) + ' by document:\n' + table(artifact.by_document, [{ key: 'views', label: 'VIEWS' }, { key: 'path', label: 'PATH' }]).trimEnd());
            }
            return out.join('\n') + '\n';
        });
    },
};

const preview = {
    name: 'preview',
    summary: 'The picture an artifact shows where it is listed',
    usage: 'markest preview <artifact> [--image <id>] [--mode <auto|pinned|off>]',
    help: `The picture an artifact shows on Explore, profiles and the feed: chosen
from its images (auto), one you pin, or none (off).

Usage:
  markest preview <artifact>                 Which it shows
  markest preview <artifact> --image <id>    Pin one of its images
  markest preview <artifact> --mode <auto|off>

${AGENT_NOTE}
`,
    flags: { image: { type: 'string' }, mode: { type: 'string' } },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest preview <artifact>' });
        if (named.usageError) return named;
        if (values.mode !== undefined && !['auto', 'pinned', 'off'].includes(values.mode)) return { usageError: '--mode is auto, pinned or off' };
        // A flag not given is undefined, which JSON leaves out of the request
        const args = { paste_id: named.ids[0], image_id: values.image, mode: values.mode };
        return { ids: named.ids, args, setting: values.image !== undefined || values.mode !== undefined };
    },
    needsKey: () => true,
    async run(ctx) {
        const { agent } = clientsFor(ctx);
        return answer(ctx, () => agent.call(ctx.setting ? 'markest_set_preview' : 'markest_get_preview', ctx.args, { reads: !ctx.setting }),
            (result) => 'Preview: ' + result.mode + (result.image ? ', ' + printable(result.image.name ?? result.image.id) + ' ' + printable(result.image.url ?? result.image.path) : '') + '\n');
    },
};

export const commands = [link, collaborators, fork, views, preview];
