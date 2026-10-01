/**
 * @module cli/commands/settings
 * @description What decides how an artifact is read, changed from the command
 *              line: `markest set` - its title, folder, tags, opening document,
 *              expiry, password, burning after reading, version history and
 *              copies of its outside images - and `markest visibility`, through
 *              the site's one visibility door, so making one public waits for
 *              the account holder's confirmation where the account asks for it
 *              (exit 3, the link to confirm on stderr). A password is read from
 *              stdin, never a flag, so it stays out of shell history.
 *
 * @input The commands' flags and artifacts; a run's context
 * @output The exit code
 * @dependencies cli/core/command-kit, cli/core/site-args, cli/core/output
 */

import { answer, artifactsFrom, clientsFor, readAll, secondsFrom, when } from '../core/command-kit.mjs';
import { VISIBILITIES } from '../core/site-args.mjs';
import { EXIT, printable } from '../core/output.mjs';

const SWITCHES = { on: true, off: false };

const set = {
    name: 'set',
    summary: 'Change an artifact\'s title, folder, expiry, password and more',
    usage: 'markest set <artifact> [options]',
    help: `Change how an artifact is kept and read. Only what is named changes.

Usage:
  markest set <artifact> [options]

Options:
  --title <text>          Its title
  --folder <name>         File it in a folder ("" for none)
  --tags <a,b>            Its tags, comma-separated ("" for none)
  --default <path>        The document it opens on
  --expires <when>        30m, 12h, 7d, 4w, or never - within your plan
  --password-stdin        Protect it with the password piped in
  --no-password           Remove its password
  --burn / --no-burn      Burn after the first reading, or not
  --versions <on|off>     Keep a version history of its saves
  --proxy-images <on|off> Keep copies of the outside images it shows

Visibility has its own command: markest visibility. Needs a key with
create_paste.
`,
    flags: {
        title: { type: 'string' },
        folder: { type: 'string' },
        tags: { type: 'string' },
        default: { type: 'string' },
        expires: { type: 'string' },
        'password-stdin': { type: 'boolean' },
        'no-password': { type: 'boolean' },
        burn: { type: 'boolean' },
        'no-burn': { type: 'boolean' },
        versions: { type: 'string' },
        'proxy-images': { type: 'string' },
    },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest set <artifact> [options]' });
        if (named.usageError) return named;
        const changes = {};
        if (values.title !== undefined) changes.title = values.title;
        if (values.folder !== undefined) changes.folder = values.folder;
        if (values.tags !== undefined) changes.tags = values.tags;
        if (values.default !== undefined) changes.default_path = values.default;
        if (values.expires !== undefined) {
            const seconds = secondsFrom(values.expires);
            if (seconds === null) return { usageError: '--expires is a length such as 30m, 12h, 7d or 4w, or never' };
            changes.expires_in = seconds;
        }
        if (values['password-stdin'] && values['no-password']) return { usageError: '--password-stdin and --no-password ask for opposite things' };
        if (values['no-password']) changes.password = null;
        if (values.burn && values['no-burn']) return { usageError: '--burn and --no-burn ask for opposite things' };
        if (values.burn || values['no-burn']) changes.burn_after_reading = Boolean(values.burn);
        for (const [flag, field] of [['versions', 'track_versions'], ['proxy-images', 'proxy_images']]) {
            if (values[flag] === undefined) continue;
            if (!(values[flag] in SWITCHES)) return { usageError: '--' + flag + ' is on or off' };
            changes[field] = SWITCHES[values[flag]];
        }
        if (Object.keys(changes).length === 0 && !values['password-stdin']) return { usageError: 'Nothing to change: name at least one option. markest help set lists them.' };
        return { ids: named.ids, changes, passwordFromStdin: Boolean(values['password-stdin']) };
    },
    needsKey: () => true,
    async run(ctx) {
        const changes = { ...ctx.changes };
        if (ctx.passwordFromStdin) {
            const password = (await readAll(ctx.stdin)).replace(/\r?\n$/, '');
            if (password === '') {
                ctx.stderr.write('markest: no password arrived on stdin; nothing was changed.\n');
                return EXIT.USAGE;
            }
            changes.password = password;
        }
        const { rest } = clientsFor(ctx);
        return answer(ctx, async () => (await rest.request('PATCH', '/api/v1/pastes/' + ctx.ids[0], { json: changes, idempotent: true })).body, (paste) => [
            'Changed ' + printable(paste.title || paste.id),
            '  ' + paste.visibility + (paste.folder ? ', in ' + printable(paste.folder) : '') + ', opens on ' + printable(paste.default_path ?? '(its first document)'),
            '  ' + (paste.expires_at ? 'expires ' + when(paste.expires_at) : 'never expires') + (paste.password_protected ? ', password protected' : '')
                + (paste.burn_after_reading ? ', burns after reading' : '') + (paste.track_versions ? ', keeps versions' : ''),
        ].join('\n') + '\n');
    },
};

const visibility = {
    name: 'visibility',
    summary: 'Make artifacts public, unlisted or private',
    usage: 'markest visibility <public|unlisted|private> <artifact>...',
    help: `Make one or more artifacts public, unlisted or private.

Usage:
  markest visibility <public|unlisted|private> <artifact>...

Restricting applies at once. Making one public may wait for you to confirm
it in a browser, as your account asks: the link to confirm is printed on
stderr, the exit code is 3, and nothing is public until you approve it. An
artifact encrypted end to end is never public. Needs a key with create_paste.
`,
    flags: {},
    parse(values, positionals) {
        const [wanted, ...rest] = positionals;
        if (!VISIBILITIES.includes(wanted)) return { usageError: 'Say which first: markest visibility <' + VISIBILITIES.join('|') + '> <artifact>...' };
        const named = artifactsFrom(rest, { usage: 'markest visibility <' + VISIBILITIES.join('|') + '> <artifact>...', max: 100 });
        return named.usageError ? named : { ids: named.ids, visibility: wanted };
    },
    needsKey: () => true,
    async run(ctx) {
        const { rest } = clientsFor(ctx);
        let waiting = null;
        const code = await answer(ctx, async () => {
            const result = await rest.request('POST', '/api/v1/pastes/visibility', { json: { paste_ids: ctx.ids, visibility: ctx.visibility }, idempotent: true });
            if (result.status === 202) waiting = result.body;
            return result.body;
        }, (result) => {
            if (waiting) return '';
            const changed = (result.changed ?? []).length;
            return (changed === 0 ? 'Nothing to change: already ' + ctx.visibility : 'Made ' + changed + ' ' + ctx.visibility) + '.\n';
        });
        if (waiting) {
            ctx.stderr.write('Making ' + (ctx.ids.length === 1 ? 'it' : 'these') + ' public needs your confirmation: open ' + printable(waiting.approval_url)
                + '\nNothing is public until you approve it.\n');
            return EXIT.AWAITING_APPROVAL;
        }
        return code;
    },
};

export const commands = [set, visibility];
