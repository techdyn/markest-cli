/**
 * @module cli/commands/draft
 * @description `markest draft <file|folder>`: publish without an account. The
 *              site keeps such an artifact unlisted for a day unless the person
 *              it is for claims it by the link printed on stderr, and holds it to
 *              its own limits - a few markdown or code documents, no HTML page,
 *              no image - which the site states and the command checks first, so
 *              a folder that cannot go is refused with nothing sent. The folder
 *              is read as `markest publish` reads one: nothing hidden, generated
 *              or secret. No key is sent, even when one is set.
 *
 * @input The command's flags and file or folder; a run's context
 * @output The exit code
 * @dependencies node:fs/promises, node:path, cli/core/command-kit, cli/core/output,
 *               cli/core/api-client, cli/publish/folder-scan, cli/publish/ignore-rules,
 *               cli/publish/publish-plan, cli/shared
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { answer, Refused } from '../core/command-kit.mjs';
import { createClient } from '../core/api-client.mjs';
import { EXIT, printable } from '../core/output.mjs';
import { scanFolder } from '../publish/folder-scan.mjs';
import { readIgnoreLines } from '../publish/ignore-rules.mjs';
import { chooseDefault, chooseTitle, orderDocuments } from '../publish/publish-plan.mjs';
import { byteLength, detectContentType, TYPE_HTML } from '../shared.mjs';

/** The documents a file or a folder offers, as the publish reads them. */
async function documentsOf(path, info) {
    if (info.isFile()) {
        const content = await readFile(path, 'utf8');
        const name = basename(path);
        return { name, documents: [{ path: name, content, type: detectContentType(content, name) }], images: [] };
    }
    const scan = await scanFolder(path, { ignoreLines: await readIgnoreLines(path) });
    return { name: scan.name, documents: scan.documents, images: scan.images };
}

/** Why the site would refuse it, before anything is sent. */
export function draftProblems(documents, limits) {
    const problems = [];
    if (documents.length === 0) problems.push('there is no document to publish');
    if (documents.length > limits.max_documents) problems.push(documents.length + ' documents, where a draft holds ' + limits.max_documents);
    const total = documents.reduce((sum, doc) => sum + byteLength(doc.content), 0);
    if (total > limits.max_total_bytes) problems.push(Math.ceil(total / 1024) + ' KB, where a draft holds ' + Math.floor(limits.max_total_bytes / 1024) + ' KB');
    const pages = documents.filter((doc) => doc.type === TYPE_HTML);
    if (pages.length > 0 && limits.html === false) problems.push('an HTML page, which a draft cannot hold: ' + pages.map((doc) => doc.path).join(', '));
    return problems;
}

const draft = {
    name: 'draft',
    summary: 'Publish a file or folder without an account',
    usage: 'markest draft <file|folder> [--title <t>] [--default <path>]',
    help: `Publish a file or a small folder without an account. It is live at once
at the address printed on stdout, unlisted, and removed after a day unless
it is claimed: the claim link on stderr moves it into the account of
whoever opens it while signed in, once - give it only to that person.

Usage:
  markest draft <file|folder> [--title <t>] [--default <path>]

The site holds a draft to its limits: a few markdown or code documents,
no HTML page and no image. The folder is read as markest publish reads
one. The site may have publishing without an account turned off.

Options:
  --title <text>        Its title (default: the opening document's heading)
  --default <path>      The document it opens on
  --json                The site's answer as one JSON object
`,
    flags: { title: { type: 'string' }, default: { type: 'string' } },
    parse(values, positionals) {
        if (positionals.length !== 1) return { usageError: 'Name one file or folder: markest draft <file|folder>' };
        return { target: positionals[0], title: values.title ?? null, defaultPath: values.default ?? null };
    },
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        const info = await stat(ctx.target).catch(() => null);
        if (info === null || (!info.isFile() && !info.isDirectory())) {
            ctx.stderr.write('markest: ' + ctx.target + ' is not a file or a folder.\n');
            return EXIT.USAGE;
        }
        // No credential, whatever is set: a draft belongs to no account
        const client = createClient({ baseUrl: ctx.baseUrl, key: '', fetch: ctx.fetch, version: ctx.version });
        let refused = false;
        const code = await answer(ctx, async () => {
            const limits = (await client.request('GET', '/api/v1/drafts', { idempotent: true })).body;
            if (!limits.enabled) throw new Refused('This site has publishing without an account turned off. Create an account and an API key, then markest publish.');
            const offered = await documentsOf(ctx.target, info);
            const paths = offered.documents.map((doc) => doc.path);
            const defaultPath = chooseDefault(paths, ctx.defaultPath);
            if (ctx.defaultPath !== null && defaultPath === null) throw new Refused('There is no document ' + ctx.defaultPath + ' to open on.');
            const documents = orderDocuments(offered.documents, defaultPath);
            const problems = draftProblems(documents, limits);
            if (problems.length > 0) {
                refused = true;
                throw new Refused('A draft cannot hold this: ' + problems.join('; ') + '. Nothing was sent.');
            }
            if (offered.images.length > 0) ctx.stderr.write('Left out ' + offered.images.length + ' images: a draft holds none.\n');
            // The documents are ordered with the opening one first
            const title = chooseTitle(ctx.title, documents[0], offered.name);
            const body = { title, default_path: defaultPath, documents: documents.map((doc) => ({ path: doc.path, content: doc.content })) };
            return (await client.request('POST', '/api/v1/drafts', { json: body })).body;
        }, (published) => {
            ctx.stderr.write('Live until ' + printable(published.expires_at) + ' unless claimed. Give this claim link only to whoever should own it:\n  '
                + printable(published.claim_url) + '\n');
            return published.url + '\n';
        });
        if (refused) return EXIT.REFUSED;
        return code;
    },
};

export const commands = [draft];

