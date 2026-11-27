/**
 * @module cli/commands/secrets
 * @description `markest secret`: the secret slots of an artifact. `secret list`
 *              shows them - name, state, whether agents may ask for the value,
 *              the document - and never a value. `secret set` puts a value into
 *              the slot of that name from an environment variable, a file or
 *              standard input, so a credential goes from where it lives into the
 *              artifact without being printed anywhere: not on success, not in a
 *              refusal, not with `--json`. With `--sealed` the value is sealed
 *              here, with the key this machine keeps for the artifact (made and
 *              kept first when there is none), and the site gets an envelope.
 *              `secret run` uses secrets without showing them (secret-run).
 *              Over the REST API: GET and PUT /api/v1/pastes/{id}/secrets,
 *              POST .../secrets/{name}/use.
 *
 * @input The command's flags and arguments; a run's context
 * @output The exit code
 * @dependencies node:fs/promises, cli/core/command-kit, cli/core/output,
 *               cli/commands/secret-run, cli/sealed/keyring, cli/sealed/sealing
 */

import { readFile } from 'node:fs/promises';
import { answer, artifactsFrom, clientsFor, isRefusal, readAll, Refused } from '../core/command-kit.mjs';
import { EXIT, printable, table } from '../core/output.mjs';
import { keyringFor } from '../sealed/keyring.mjs';
import { newKey, sealAll } from '../sealed/sealing.mjs';
import { parseRun, RUN_USAGE, runSecret } from './secret-run.mjs';

/** What the browser binds a sealed secret to (assets/js/secret-fence-model.js SEALED_FIELD): path and type, byte for byte. */
const SEALED_FIELD = Object.freeze({ path: '', contentType: 'secret' });
const USAGE = 'markest secret list <artifact>  |  markest secret set <artifact> <name> [--env <VAR> | --file <path>] [--sealed]  |  ' + RUN_USAGE;

const secret = {
    name: 'secret',
    summary: 'List an artifact\'s secret slots, or fill one without showing it',
    usage: 'markest secret <list|set|run> <artifact> ...',
    help: `The secret slots of an artifact: a markdown fence opened as
\`\`\`secret <name> holds a credential the document needs and no reader sees.

Usage:
  markest secret list <artifact>
  markest secret set <artifact> <name> [--env <VAR> | --file <path>] [--sealed]
  markest secret run <artifact> --env <VAR>=<secret name> [--env ...] [--wait] -- <command> [args...]

list shows each slot's name, state (empty, held or sealed), whether agents
may ask for its value, and its document. It never shows a value.

set puts a value into the slot with that name. This is the way to fill a slot
an agent left empty (a fence opened as \`\`\`secret <name> with nothing in it):
run it yourself, so the value never enters the agent's context. The value is
never printed, not on success, not in an error, not with --json. It comes
from exactly one of:
  --env <VAR>      The environment variable VAR (it must be set and not empty)
  --file <path>    The file, read as UTF-8
  (neither)        Standard input, which must be piped in, not typed
One trailing line ending is dropped from a file or from input.

Options:
  --env <VAR>      Take the value from an environment variable
  --file <path>    Take the value from a file
  --sealed         Seal the value on this machine before it is sent, so the
                   site only ever holds an envelope. The key this machine keeps
                   for the artifact is used; with none, a new one is made and
                   kept first (markest link <artifact> prints the link that
                   carries it). Whoever opens the artifact needs that key.

A slot holds up to 16384 bytes, and no line that begins a code fence.
Needs a key or sign-in that may change the artifact.

run uses secrets without showing them: it fetches each named secret, runs
the command after -- with the values in its environment (added to the current
one), and exits with the command's own exit code. This is the way for an agent
to use a credential without it entering the agent's context, for example
  markest secret run <id> --env STRIPE_KEY="Stripe key" -- npm run deploy
The values go only into the command's environment. This command never prints
one, and the command's stdout and stderr pass through a masker that replaces
each value (also its base64 and URL-encoded forms, and each line of 8 or more
characters of a multi-line value) with [secret]. A value under 4 characters is
not masked (it says so). Masking is a guard against accidental display, not a
guarantee: a command that transforms the value - reverses it, splits it - can
still reveal it, so do not run commands whose job is to print their
environment (env, printenv, set, echo of a variable you do not trust).
  --env <VAR>=<name>  Give the secret called <name> to the command as VAR; once
                      for each secret (a variable name is letters, digits and
                      _, and is not given twice)
  --wait              When a secret needs the person's approval, print its link
                      and ask again every 3 seconds, for up to 5 minutes
The command is started directly, not through a shell: for pipes, quotes or a
shell script, name the shell: -- sh -c '...' or -- cmd /c ... (on Windows a
program such as npm is a .cmd shim, so -- cmd /c npm ...).

What can be used this way: a sealed secret, whose key this machine keeps (see
markest keys), and a secret whose fence is opened as \`\`\`secret ask, which the
person approves each time (the value is single use). One closed to agents and
scripts is refused. Every secret is fetched before the command starts; if one
is refused or needs approval nothing is run, and any secret already handed over
in this run has been spent and will need approving again.

Exit codes of run: the command's own; 2 asked wrongly (nothing was fetched);
3 approval is needed (or did not come in time) and nothing was run; 1 a secret
was refused or could not be opened, or the command could not be started or was
ended by a signal.
`,
    flags: { env: { type: 'string', multiple: true }, file: { type: 'string' }, sealed: { type: 'boolean' }, wait: { type: 'boolean' } },
    parse(values, positionals, env = {}, { afterDashes = null } = {}) {
        const [action, ...rest] = afterDashes === null ? positionals : positionals.slice(0, positionals.length - afterDashes.length);
        if (action === 'run') return parseRun(values, positionals, afterDashes, (references) => artifactsFrom(references, { usage: 'markest secret run <artifact> --env <VAR>=<name> -- <command>' }));
        if (values.wait) return { usageError: '--wait belongs to run: ' + RUN_USAGE };
        if (afterDashes !== null && afterDashes.length > 0) return { usageError: 'Nothing is given after -- here; it is for the command run by secret run' };
        if ((values.env ?? []).length > 1) return { usageError: 'Give --env once' };
        values = { ...values, env: values.env?.[0] };
        if (action === 'list') {
            if (values.env !== undefined || values.file !== undefined || values.sealed) return { usageError: 'list takes no --env, --file or --sealed: ' + USAGE };
            const named = artifactsFrom(rest, { usage: 'markest secret list <artifact>' });
            if (named.usageError) return named;
            return { action, ids: named.ids };
        }
        if (action !== 'set') return { usageError: 'Say what to do: ' + USAGE };
        const named = artifactsFrom(rest.slice(0, 1), { usage: 'markest secret set <artifact> <name>' });
        if (named.usageError) return named;
        if (rest.length < 2) return { usageError: 'Name the slot: markest secret set <artifact> <name>' };
        if (rest.length > 2) return { usageError: 'Too many arguments (quote a name with spaces): markest secret set <artifact> <name>' };
        if (values.env !== undefined && values.file !== undefined) return { usageError: 'Give the value from --env or --file, not both' };
        if (values.env !== undefined && (env[values.env] ?? '') === '') return { usageError: 'The environment variable ' + printable(values.env) + ' is not set, or is empty' };
        return { action, ids: named.ids, slot: rest[1], envName: values.env ?? null, file: values.file ?? null, sealed: Boolean(values.sealed) };
    },
    needsKey: () => true,
    async run(ctx) {
        if (ctx.action === 'run') return runSecret(ctx);
        const { rest } = clientsFor(ctx);
        const base = '/api/v1/pastes/' + ctx.ids[0] + '/secrets';
        if (ctx.action === 'list') {
            return answer(ctx, async () => (await rest.request('GET', base, { idempotent: true })).body, (body) => {
                const slots = body?.secrets ?? [];
                if (slots.length === 0) return 'No secret slots.\n';
                return table(slots, [{ key: 'name', label: 'NAME' }, { key: 'state', label: 'STATE' }, { key: 'agents', label: 'AGENTS' }, { key: 'path', label: 'DOCUMENT' }]);
            });
        }
        const given = await valueOf(ctx);
        if (given.error) {
            ctx.stderr.write('markest: ' + given.error + '\n');
            return EXIT.USAGE;
        }
        const value = given.value;
        if (value === '') {
            ctx.stderr.write('markest: The value is empty: nothing was sent.\n');
            return EXIT.USAGE;
        }
        // Never the value, whatever the site or the system says about the request
        const scrub = (text) => String(text ?? '').split(value).join('…');
        try {
            let body = value;
            if (ctx.sealed) {
                const keyring = keyringFor(ctx);
                let keyText = await keyring.get(ctx.baseUrl, ctx.ids[0]);
                if (keyText === null) {
                    keyText = (await newKey()).text;
                    // Kept before anything is sent: a value sealed with a key nobody kept can never be opened
                    await keyring.remember(ctx.baseUrl, ctx.ids[0], keyText);
                    ctx.stderr.write('A new key for this artifact is kept on this machine. markest link ' + ctx.ids[0] + ' prints the link that carries it.\n');
                }
                [{ content: body }] = await sealAll(keyText, [{ ...SEALED_FIELD, content: value }]);
            }
            return await answer(ctx, async () => {
                try {
                    return (await rest.request('PUT', base + '/' + encodeURIComponent(ctx.slot), { body, contentType: 'text/plain; charset=utf-8' })).body;
                } catch (error) {
                    if (!isRefusal(error)) throw error;
                    const said = new Refused(scrub(error.message));
                    said.status = error.status;
                    throw said;
                }
            }, (done) => 'Set "' + printable(done?.secret?.name ?? ctx.slot) + '" in ' + printable(done?.secret?.path ?? 'the artifact') + ' (' + printable(done?.secret?.state ?? '') + ').\n');
        } catch (error) {
            // A failure of this machine's own (the key store, the sealing) says what failed, never the value
            ctx.stderr.write('markest: ' + printable(scrub(error?.message ?? error)) + '\n');
            return EXIT.FAILED;
        }
    },
};

/** The value asked for, from its one source, with one trailing line ending dropped from a file or input; or why there is none. */
async function valueOf(ctx) {
    if (ctx.envName !== null) return { value: ctx.env[ctx.envName] ?? '' };
    let text;
    if (ctx.file !== null) {
        try {
            text = await readFile(ctx.file, 'utf8');
        } catch {
            return { error: ctx.file + ' could not be read.' };
        }
    } else {
        if (!ctx.stdin || ctx.stdin.isTTY) return { error: 'No value given: pipe it in, or use --env <VAR> or --file <path> (a value typed here would be shown).' };
        text = await readAll(ctx.stdin);
    }
    return { value: text.replace(/\r?\n$/, '') };
}

export const commands = [secret];
