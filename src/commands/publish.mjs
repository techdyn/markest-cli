/**
 * @module cli/commands/publish
 * @description `markest publish <folder>`: a folder as one artifact, or an
 *              artifact published before updated from it. What was asked is
 *              read here; the folder is read by publish/folder-scan, sent by
 *              publish/publish-run and reported by publish/publish-report. A
 *              new artifact's dry run asks the site nothing, so it needs no key.
 *
 * @input The command's flags and folder; `{ key, baseUrl, stdout, stderr, fetch, version }`
 * @output The exit code
 * @dependencies node:fs/promises, cli/core/site-args, cli/core/api-client,
 *               cli/publish/folder-scan, cli/publish/ignore-rules,
 *               cli/publish/publish-run, cli/publish/publish-report,
 *               cli/sealed/keyring, cli/sealed/sealing
 */

import { stat } from 'node:fs/promises';
import { pasteIdFrom, visibilityFrom } from '../core/site-args.mjs';
import { createClient } from '../core/api-client.mjs';
import { EXIT } from '../core/output.mjs';
import { scanFolder } from '../publish/folder-scan.mjs';
import { readIgnoreLines } from '../publish/ignore-rules.mjs';
import { publish } from '../publish/publish-run.mjs';
import { exitCodeFor, renderHuman, renderJson } from '../publish/publish-report.mjs';
import { keyringFor } from '../sealed/keyring.mjs';
import { keyIn } from '../sealed/sealing.mjs';

export const HELP = `Publish a folder as one Markest artifact.

Usage:
  markest publish <folder> [options]

Every document keeps its folder; the artifact opens on the README or index;
images the documents show are uploaded and their references pointed at them.
The address of the artifact is printed on stdout.

Options:
  --title <text>          Its title (default: the opening document's heading)
  --default <path>        The document it opens on
  --visibility <v>        public, unlisted or private (default: your account's)
  --sealed                Encrypt it end to end, on this machine: the site
                          holds only ciphertext; the address printed carries
                          the key, which is kept here too (markest keys).
                          Never public; no images
  --update <id|url>       Change an artifact you published before: only what
                          changed is sent. One encrypted end to end is opened
                          with the key in this link, or the one kept here
  --prune                 With --update: remove documents gone from the folder
  --ignore <pattern>      Leave out what matches (repeatable; also .markestignore)
  --include-output        Send build, dist, vendor, coverage and target folders
  --allow-file <path>     Send a file that looks like it holds a secret
  --dry-run               Say what would be sent, and send nothing
  --json                  Print one JSON object instead
  --url <site>            The site (default https://marke.st, or MARKEST_URL)

It acts as your sign-in (markest login), else the API key in MARKEST_API_KEY
(or MARKEST_KEY). Creating needs create_paste, or a sign-in allowed to write;
--update also read_own; --prune also delete_own.

Exit codes: 0 done, 1 failed or partly done, 2 usage, 3 waiting for you to
confirm publishing, 4 the folder cannot be published as it is (nothing sent).
`;

export const FLAGS = {
    title: { type: 'string' },
    visibility: { type: 'string' },
    default: { type: 'string' },
    update: { type: 'string' },
    prune: { type: 'boolean' },
    ignore: { type: 'string', multiple: true },
    'allow-file': { type: 'string', multiple: true },
    'include-output': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    sealed: { type: 'boolean' },
};

/** What was asked, or why it cannot be done as asked. */
export function parse(values, positionals) {
    const [folder, ...extra] = positionals;
    if (folder === undefined) return { usageError: 'Name the folder to publish: markest publish <folder>' };
    if (extra.length > 0) return { usageError: 'One folder at a time; also given: ' + extra.join(' ') };
    const visibility = visibilityFrom(values.visibility);
    if (visibility.usageError) return visibility;
    let update = null;
    if (values.update !== undefined) {
        update = pasteIdFrom(values.update);
        if (update === null) return { usageError: '--update takes an artifact id or its address' };
    }
    if (values.prune && update === null) return { usageError: '--prune removes documents from an artifact, so it needs --update' };
    if (values.sealed && visibility.visibility === 'public') return { usageError: 'An artifact encrypted end to end is never public: unlisted or private' };
    return {
        folder,
        options: {
            title: values.title ?? null,
            visibility: visibility.visibility,
            defaultPath: values.default ?? null,
            update,
            prune: Boolean(values.prune),
            ignore: values.ignore ?? [],
            allowFiles: values['allow-file'] ?? [],
            includeOutput: Boolean(values['include-output']),
            dryRun: Boolean(values['dry-run']),
            json: Boolean(values.json),
            sealed: Boolean(values.sealed),
            // A sealed artifact's key, when --update's link carries one (none without --update); never said back
            updateKey: keyIn(values.update),
        },
    };
}

/** A dry run of a new artifact asks the site nothing. */
export function needsKey({ options }) {
    return !(options.dryRun && options.update === null);
}

export async function run({ folder, options, key, auth, vault, baseUrl, env, stdout, stderr, fetch, version }) {
    const info = await stat(folder).catch(() => null);
    if (info === null || !info.isDirectory()) {
        stderr.write('markest: ' + folder + ' is not a folder.\n');
        return EXIT.USAGE;
    }
    const ignoreLines = [...await readIgnoreLines(folder), ...options.ignore];
    const scan = await scanFolder(folder, { ignoreLines, includeOutput: options.includeOutput, allowFiles: options.allowFiles });
    const log = (line) => stderr.write(line + '\n');
    // The run's sign-in, or its key, as every command's client carries it
    const client = createClient({
        baseUrl,
        key,
        auth: auth?.present ? auth : null,
        fetch,
        version,
        onWait: ({ status, ms }) => log('The site asked to wait (' + status + '); trying again in ' + Math.round(ms / 1000) + ' s.'),
    });
    const result = await publish({ scan, options, baseUrl }, { client, log: options.json ? () => {} : log, keyring: keyringFor({ env, vault }) });
    if (options.json) {
        stdout.write(renderJson(result));
    } else {
        const text = renderHuman(result);
        stderr.write(text.stderr);
        stdout.write(text.stdout);
    }
    return exitCodeFor(result);
}

export const command = {
    name: 'publish',
    summary: 'Publish a folder as one artifact, or update one from it',
    usage: 'markest publish <folder> [options]',
    help: HELP,
    flags: FLAGS,
    parse,
    needsKey,
    run,
};
