/**
 * @module cli/commands/keys
 * @description `markest keys`: the keys of artifacts encrypted end to end this
 *              machine keeps - listed by artifact, never shown; one kept from a
 *              link (`--add`), which is opened first so a wrong key is never
 *              kept; one forgotten (`--forget`). The link that shares one, key
 *              and all, is `markest link`'s to print.
 *
 * @input The command's flags; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/site-args, cli/core/output,
 *               cli/sealed/keyring, cli/sealed/sealing, cli/reading/artifact-source
 */

import { answer, clientsFor, Refused, when } from '../core/command-kit.mjs';
import { pasteIdFrom } from '../core/site-args.mjs';
import { printable, table } from '../core/output.mjs';
import { keyringFor } from '../sealed/keyring.mjs';
import { keyIn, openAll, withoutKey } from '../sealed/sealing.mjs';
import { ALL, fetchArtifact } from '../reading/artifact-source.mjs';

const keys = {
    name: 'keys',
    summary: 'The keys of encrypted artifacts this machine keeps',
    usage: 'markest keys [--add <link>] [--forget <artifact>]',
    help: `The keys of artifacts encrypted end to end this machine keeps, so they
are read and updated by id. A key is never shown here; markest link prints
the link that shares one.

Usage:
  markest keys                    The artifacts whose keys are kept
  markest keys --add <link>       Keep the key in a link (opened first)
  markest keys --forget <artifact>

Keys are kept in your account's settings folder, or the file MARKEST_KEYRING
names, readable by you alone. Whoever holds a key reads its artifact.
`,
    flags: { add: { type: 'string' }, forget: { type: 'string' } },
    parse(values, positionals) {
        if (positionals.length > 0) return { usageError: 'markest keys [--add <link>] [--forget <artifact>]' };
        if (values.add !== undefined && values.forget !== undefined) return { usageError: 'Add or forget, one at a time' };
        if (values.add !== undefined) {
            const id = pasteIdFrom(values.add);
            const key = keyIn(values.add);
            if (id === null || key === null) return { usageError: 'Give the artifact\'s whole link, the one ending #key=...' };
            // Not `key`: a run's `key` is the API key
            // Stryker disable next-line StringLiteral: equivalent - an action not list or forget is add
            return { action: 'add', id, artifactKey: key, reference: values.add };
        }
        if (values.forget !== undefined) {
            const id = pasteIdFrom(values.forget);
            if (id === null) return { usageError: '"' + withoutKey(values.forget) + '" is not an artifact\'s id or address' };
            return { action: 'forget', id };
        }
        return { action: 'list' };
    },
    // Stryker disable next-line ArrowFunction: equivalent - nothing is no key needed, as false is
    needsKey: () => false,
    async run(ctx) {
        const keyring = keyringFor(ctx);
        if (ctx.action === 'list') {
            return answer(ctx, async () => ({ path: keyring.path, keys: await keyring.list() }), (found) => {
                if (found.keys.length === 0) return 'No keys are kept on this machine.\n';
                ctx.stderr.write('Kept in ' + printable(found.path) + '\n');
                return table(found.keys.map((one) => ({ ...one, saved: when(one.saved_at) })), [
                    { key: 'id', label: 'ID' }, { key: 'site', label: 'SITE' }, { key: 'saved', label: 'KEPT (UTC)' }, { key: 'title', label: 'TITLE' },
                ]);
            });
        }
        if (ctx.action === 'forget') {
            return answer(ctx, async () => {
                if (!await keyring.forget(ctx.baseUrl, ctx.id)) throw new Refused('No key for ' + ctx.id + ' is kept for ' + ctx.baseUrl + '.');
                return { forgotten: ctx.id };
            }, () => 'Forgot the key of ' + ctx.id + '.\n');
        }
        return answer(ctx, async () => {
            // Opened first: a key that does not open it is never kept
            const { rest } = clientsFor(ctx);
            const artifact = await fetchArtifact(rest, { id: ctx.id, reference: ctx.reference, keyed: ctx.key !== '', pick: ALL });
            if (!artifact.sealed) throw new Refused('That artifact is not encrypted end to end: it needs no key.');
            await openAll(ctx.artifactKey, artifact.documents);
            await keyring.remember(ctx.baseUrl, ctx.id, ctx.artifactKey, artifact.title);
            return { kept: ctx.id, title: artifact.title };
        }, (done) => 'Kept the key of ' + printable(done.title ?? done.kept) + ' (' + done.kept + ').\n');
    },
};

export const commands = [keys];
