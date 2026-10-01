/**
 * @module cli/commands/reading
 * @description Reading artifacts back: `markest read` prints one document's text
 *              exactly as it is, and `markest pull` writes every document into a
 *              folder at its path. With a key they read through the REST API,
 *              without one as a browser would, so a public, unlisted or signed
 *              link needs no account. A document named in the address opens
 *              unless another is named; else the one the artifact opens on.
 *
 * @input The commands' flags, artifact and document or folder; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/output, cli/reading/artifact-source,
 *               cli/reading/folder-writer, cli/reading/sealed-reading
 */

import { answer, artifactsFrom, clientsFor, Refused } from '../core/command-kit.mjs';
import { EXIT, jsonLine, printable } from '../core/output.mjs';
import { ALL, OPENING, chooseDocument, fetchArtifact, pathIn } from '../reading/artifact-source.mjs';
import { writeDocuments } from '../reading/folder-writer.mjs';
import { openIfSealed } from '../reading/sealed-reading.mjs';

const FORMATS = ['stored', 'markdown'];

/** The artifact as the site hands it over, opened where it is encrypted end to end. */
async function readArtifact(ctx, pick) {
    const { rest } = clientsFor(ctx);
    const artifact = await fetchArtifact(rest, { id: ctx.ids[0], reference: ctx.reference, keyed: ctx.key !== '', format: ctx.format, pick });
    return openIfSealed(artifact, ctx);
}

const read = {
    name: 'read',
    summary: 'Print one document of an artifact',
    usage: 'markest read <artifact> [<path>]',
    help: `Print one document of an artifact, exactly as it is, to stdout.

Usage:
  markest read <artifact> [<path>] [--format markdown]

The artifact is its id or any of its addresses; a document in the address
opens unless <path> names another, else the one the artifact opens on.
With MARKEST_API_KEY set, it reads what your key may; without, it reads
as a browser would, so a public, unlisted or signed link needs no account.
An artifact encrypted end to end is opened with the key in its link, or
the one this machine keeps for it (markest keys).

Options:
  --format markdown     An HTML document as markdown (needs a key)
  --remember            Keep the key in the link on this machine
  --json                The document and its type as one JSON object
`,
    flags: { format: { type: 'string' }, remember: { type: 'boolean' } },
    parse(values, positionals) {
        const [reference, path, ...extra] = positionals;
        if (extra.length > 0) return { usageError: 'One document at a time: markest read <artifact> [<path>]' };
        const named = artifactsFrom(reference === undefined ? [] : [reference], { usage: 'markest read <artifact> [<path>]' });
        if (named.usageError) return named;
        const format = values.format ?? 'stored';
        if (!FORMATS.includes(format)) return { usageError: '--format is stored or markdown' };
        return { ids: named.ids, reference, path: path ?? pathIn(reference, named.ids[0]), format, remember: Boolean(values.remember) };
    },
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        if (ctx.format === 'markdown' && ctx.key === '') {
            ctx.stderr.write('markest: --format markdown needs MARKEST_API_KEY: the site converts a document for a key.\n');
            return EXIT.USAGE;
        }
        return answer(ctx, async () => {
            const artifact = await readArtifact(ctx, ctx.path ?? OPENING);
            const path = chooseDocument(artifact, ctx.path);
            const doc = artifact.documents.find((one) => one.path === path);
            if (!doc) throw new Refused('There is no document "' + ctx.path + '" in it. It holds: ' + artifact.documents.map((one) => one.path).join(', '));
            return { id: artifact.id, path: doc.path, content_type: doc.contentType, content: doc.content, encrypted: artifact.sealed };
        }, (doc) => doc.content);
    },
};

const pull = {
    name: 'pull',
    summary: 'Write every document of an artifact into a folder',
    usage: 'markest pull <artifact> <folder>',
    help: `Write every document of an artifact into a folder, each at its path.

Usage:
  markest pull <artifact> <folder> [--force]

A file already in the folder is left alone unless --force; a path that
would land outside the folder, or go through a link, is refused, and then
nothing is written. Images stay on the site, where the documents show them.
An artifact encrypted end to end is opened as markest read opens one.
stdout lists the paths written.

Options:
  --force               Replace files already there
  --remember            Keep the key in the link on this machine
  --json                What was written as one JSON object
`,
    flags: { force: { type: 'boolean' }, remember: { type: 'boolean' } },
    parse(values, positionals) {
        const [reference, folder, ...extra] = positionals;
        if (folder === undefined || extra.length > 0) return { usageError: 'Name the artifact and the folder: markest pull <artifact> <folder>' };
        // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent - one reference is always given here, so the usage is never said
        const named = artifactsFrom([reference], { usage: 'markest pull <artifact> <folder>' });
        if (named.usageError) return named;
        return { ids: named.ids, reference, folder, force: Boolean(values.force), remember: Boolean(values.remember) };
    },
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        let refused = [];
        const code = await answer(ctx, async () => {
            const artifact = await readArtifact(ctx, ALL);
            const outcome = await writeDocuments(ctx.folder, artifact.documents, { force: ctx.force });
            refused = outcome.refused;
            if (refused.length > 0) {
                throw new Refused('Nothing was written: ' + refused.map((one) => one.path + ' (' + one.reason + ')').join(', ')
                    + (refused.some((one) => one.reason === 'exists') ? '. --force replaces files already there.' : '.'));
            }
            return { id: artifact.id, folder: ctx.folder, written: outcome.written, encrypted: artifact.sealed };
        }, (done) => {
            ctx.stderr.write('Wrote ' + done.written.length + ' documents to ' + printable(ctx.folder) + '\n');
            return done.written.map((path) => printable(path) + '\n').join('');
        });
        // A refusal always fails the run, so refusals alone decide
        if (ctx.json && refused.length > 0) ctx.stdout.write(jsonLine({ refused }));
        return code;
    },
};

export const commands = [read, pull];
