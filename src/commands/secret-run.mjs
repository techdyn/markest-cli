/**
 * @module cli/commands/secret-run
 * @description `markest secret run`: use secrets without seeing them. Each named
 *              secret is fetched from the site (POST .../secrets/{name}/use) -
 *              a value, a sealed envelope opened with the key this machine
 *              keeps, or a request for the person's approval, waited for with
 *              `--wait` - and the command after `--` is run with the values
 *              in its environment, alone. Its output passes through a masker
 *              that hides every value, so a credential is used without
 *              entering the output of whoever ran this, an agent included.
 *              The command is started directly, never through a shell.
 *              Nothing is run unless every secret was handed over; a value
 *              handed over is spent, and a run that stops after one says so.
 *              No value is ever written by this command itself, errors included.
 *
 * @input Parsed arguments; a run's context, with `spawn`, `sleep`, `now`, `pollMs` and `pollTimeoutMs` where a test replaces them
 * @output The child's exit code; 1 refused or failed; 2 asked wrongly; 3 waiting for approval
 * @dependencies node:child_process, cli/core/command-kit, cli/core/output,
 *               cli/core/mask-stream, cli/sealed/keyring, cli/sealed/sealing
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { clientsFor, isRefusal, Refused } from '../core/command-kit.mjs';
import { EXIT, printable } from '../core/output.mjs';
import { maskStream, patternsFor } from '../core/mask-stream.mjs';
import { keyringFor } from '../sealed/keyring.mjs';
import { openAll } from '../sealed/sealing.mjs';

export const RUN_USAGE = 'markest secret run <artifact> --env <VAR>=<secret name> [--env ...] [--wait] -- <command> [args...]';
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POLL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** The pseudo-document a sealed secret is bound to, as `set --sealed` seals it (assets/js/secret-fence-model.js SEALED_FIELD). */
const SEALED_FIELD = Object.freeze({ path: '', contentType: 'secret' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `--env VAR=name` mappings, or why they are wrong. */
export function mappingsFrom(entries) {
    if (entries.length === 0) return { usageError: 'Say which secrets to use: --env <VAR>=<secret name>. ' + RUN_USAGE };
    const mappings = [];
    for (const entry of entries) {
        const at = entry.indexOf('=');
        const variable = at < 0 ? '' : entry.slice(0, at);
        const name = at < 0 ? '' : entry.slice(at + 1);
        if (at < 0 || name === '') return { usageError: '--env takes <VAR>=<secret name>; "' + printable(entry) + '" is not that' };
        if (!VARIABLE.test(variable)) return { usageError: '"' + printable(variable) + '" is not a variable name (letters, digits and _, not starting with a digit)' };
        if (mappings.some((one) => one.variable === variable)) return { usageError: 'The variable ' + variable + ' is given twice' };
        mappings.push({ variable, name });
    }
    return { mappings };
}

/** What `secret run` was asked, or a usage error. `positionals` hold what is before `--` and after it. */
export function parseRun(values, positionals, afterDashes, named) {
    if (values.json) return { usageError: '--json has no meaning for secret run: the command\'s own output is what is shown' };
    if (values.file !== undefined || values.sealed) return { usageError: 'run takes no --file or --sealed: ' + RUN_USAGE };
    if (afterDashes === null || afterDashes === undefined || afterDashes.length === 0) {
        return { usageError: 'Give the command to run after --: ' + RUN_USAGE };
    }
    const before = positionals.slice(0, positionals.length - afterDashes.length);
    const artifact = named(before.slice(1));
    if (artifact.usageError) return artifact;
    const mapped = mappingsFrom(values.env ?? []);
    if (mapped.usageError) return mapped;
    const [command, ...args] = afterDashes;
    return { action: 'run', ids: artifact.ids, mappings: mapped.mappings, wait: Boolean(values.wait), command, args };
}

/** Ask the site for one secret: what it says, whichever way. */
async function ask(rest, base, name) {
    return (await rest.request('POST', base + '/' + encodeURIComponent(name) + '/use')).body ?? {};
}

/** The value in an answer that carries one: sent as it is, or sealed and opened with the key this machine keeps. */
async function valueOf(ctx, body, name) {
    if (body.status === 'sealed' || typeof body.envelope === 'string') {
        const keyText = await keyringFor(ctx).get(ctx.baseUrl, ctx.ids[0]);
        const lacking = 'The secret "' + printable(name) + '" is sealed end to end, and this machine holds no key that opens it. '
            + 'Keep the artifact\'s key with markest keys --add <the artifact\'s whole link, ending #key=...>.';
        if (keyText === null) throw new Refused(lacking);
        try {
            const [opened] = await openAll(keyText, [{ ...SEALED_FIELD, content: body.envelope }]);
            if (typeof opened.content === 'string') return opened.content;
        } catch {
            // Said below without the envelope or the key
        }
        throw new Refused('The key this machine keeps for the artifact does not open the secret "' + printable(name) + '". It is another artifact\'s key, or the secret was changed.');
    }
    if (typeof body.value === 'string') return body.value;
    throw new Refused('The site\'s answer for the secret "' + printable(name) + '" held no value.');
}

/** Wait for the person's approval of one secret, asking again every interval, until the timeout. Null when it passed. */
async function awaitValue(ctx, rest, base, mapping, first) {
    const sleep = ctx.sleep ?? pause;
    const now = ctx.now ?? Date.now;
    const deadline = now() + (ctx.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    let body = first;
    while (body.status === 'approval_required') {
        if (now() >= deadline) return null;
        await sleep(ctx.pollMs ?? POLL_MS);
        body = await ask(rest, base, mapping.name);
    }
    return body;
}

/** Start the command with the values added to its environment; its masked output goes to this run's own. Resolves `{ code }` or `{ error }`. */
function runChild(ctx, env, patterns) {
    const spawn = ctx.spawn ?? nodeSpawn;
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(ctx.command, ctx.args, { env, stdio: ['inherit', 'pipe', 'pipe'], shell: false });
        } catch (error) {
            resolve({ error });
            return;
        }
        const streams = [];
        if (child.stdout) streams.push(maskStream(child.stdout, patterns, (text) => ctx.stdout.write(text)));
        if (child.stderr) streams.push(maskStream(child.stderr, patterns, (text) => ctx.stderr.write(text)));
        child.once('error', (error) => resolve({ error }));
        child.once('close', async (code, signal) => {
            await Promise.all(streams);
            resolve({ code, signal });
        });
    });
}

/** `markest secret run`. */
export async function runSecret(ctx) {
    const { rest } = clientsFor(ctx);
    const base = '/api/v1/pastes/' + ctx.ids[0] + '/secrets';
    const spent = [];
    const waiting = [];
    // Whatever is said, never a value
    const say = (text) => ctx.stderr.write('markest: ' + printable([...spent.map((one) => one.value)].reduce((out, value) => (value === '' ? out : out.split(value).join('…')), String(text))) + '\n');
    const stopped = () => {
        if (spent.length > 0) {
            say('Nothing was run. ' + spent.length + ' secret' + (spent.length === 1 ? '' : 's') + ' already handed over in this run ('
                + spent.map((one) => '"' + printable(one.name) + '"').join(', ') + ') ' + (spent.length === 1 ? 'has' : 'have') + ' been spent and will need approving again.');
        }
    };
    try {
        for (const mapping of ctx.mappings) {
            let body = await ask(rest, base, mapping.name);
            if (body.status === 'approval_required') {
                const link = typeof body.approval_url === 'string' ? body.approval_url : '(no link given)';
                say('The secret "' + printable(mapping.name) + '" needs the person\'s approval: ' + printable(link));
                if (!ctx.wait) {
                    waiting.push(mapping);
                    continue;
                }
                body = await awaitValue(ctx, rest, base, mapping, body);
                if (body === null) {
                    say('No approval of "' + printable(mapping.name) + '" came within ' + Math.round((ctx.pollTimeoutMs ?? POLL_TIMEOUT_MS) / 60000) + ' minutes.');
                    stopped();
                    return EXIT.AWAITING_APPROVAL;
                }
            }
            const value = await valueOf(ctx, body, mapping.name);
            // Handed over: spent, whatever happens next
            spent.push({ ...mapping, value });
        }
    } catch (error) {
        if (!isRefusal(error)) {
            say(error?.message ?? error);
            stopped();
            return EXIT.FAILED;
        }
        say(error.message);
        stopped();
        return EXIT.FAILED;
    }
    if (waiting.length > 0) {
        say('Approve ' + (waiting.length === 1 ? 'it' : 'them') + ' in the link' + (waiting.length === 1 ? '' : 's') + ' above, then run the same command again'
            + (spent.length > 0 ? '.' : ' (or add --wait to wait here).'));
        stopped();
        return EXIT.AWAITING_APPROVAL;
    }

    const { patterns, short } = patternsFor(spent.map((one) => one.value));
    if (short.length > 0) {
        say(short.map((at) => spent[at].variable).join(', ') + ' ' + (short.length === 1 ? 'is' : 'are') + ' too short to mask: ' + (short.length === 1 ? 'it' : 'they') + ' will show in the command\'s output if it prints ' + (short.length === 1 ? 'it' : 'them') + '.');
    }
    const env = { ...ctx.env };
    for (const one of spent) env[one.variable] = one.value;
    const result = await runChild(ctx, env, patterns);
    if (result.error) {
        const code = result.error.code;
        say('Could not run "' + printable(ctx.command) + '": ' + (code === 'ENOENT' ? 'no such program' : code === 'EINVAL' ? 'not a program that starts without a shell' : printable(result.error.message))
            + '. The command is run directly, not through a shell: for a shell script or a Windows .cmd shim use sh -c \'...\' or cmd /c ....');
        return EXIT.FAILED;
    }
    if (typeof result.code === 'number') return result.code;
    say('The command was ended by the signal ' + printable(result.signal ?? 'unknown') + '.');
    return EXIT.FAILED;
}
