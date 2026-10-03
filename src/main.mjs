/**
 * @module cli/main
 * @description `markest <command>` from start to finish: find the command, read
 *              its flags beside the ones every command takes, the site, the
 *              run's vault and its credential - the sign-in, else an API key
 *              (D-20261002-04) - run it, and return its exit code. `markest`,
 *              `--help` and `markest help <command>` say what there is;
 *              `--version` the version. Anything unforeseen is reported without
 *              a key or token and exits 1.
 *
 * @input argv; `{ env, stdout, stderr, fetch, stdin, browser, sleep }`
 * @output The exit code
 * @dependencies node:fs/promises, cli/core/site-args, cli/core/api-client,
 *               cli/core/output, cli/commands/registry, cli/auth/credential, cli/store/vault
 */

import { readFile } from 'node:fs/promises';
import { GLOBAL_FLAGS, keyFrom, readFlags, siteFrom } from './core/site-args.mjs';
import { redact } from './core/api-client.mjs';
import { EXIT } from './core/output.mjs';
import { COMMANDS, commandList } from './commands/registry.mjs';
import { credentialFor, NONE } from './auth/credential.mjs';
import { vaultFor } from './store/vault.mjs';

/** What the tool can do, one line a command. */
export function generalHelp() {
    const list = commandList();
    const width = Math.max(...list.map((one) => one.name.length));
    return 'Markest from the command line: publish, read and manage artifacts.\n\n'
        + 'Usage:\n  markest <command> [options]\n\nCommands:\n'
        + list.map((one) => '  ' + one.name.padEnd(width) + '  ' + one.summary).join('\n')
        + '\n\nEvery command takes --url <site> (default https://marke.st, or MARKEST_URL)\n'
        + 'and --json. Sign in with markest login; an API key in MARKEST_API_KEY (or\n'
        + 'MARKEST_KEY) is used where you are not signed in.\n'
        + 'markest help <command> shows how to call one.\n';
}

export async function version() {
    // Stryker disable next-line StringLiteral: equivalent - JSON.parse reads a buffer as its text
    const text = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    return JSON.parse(text).version;
}

/** Flags every command takes that are followed by a value, which is not a command. */
const VALUED = new Set(Object.entries(GLOBAL_FLAGS).filter(([, flag]) => flag.type === 'string').map(([name]) => '--' + name));

/** The command named first - passing over a global flag's value - and the arguments without it. */
function splitCommand(argv) {
    for (let at = 0; at < argv.length; at++) {
        if (VALUED.has(argv[at])) {
            at++;
            continue;
        }
        if (!argv[at].startsWith('-')) return { name: argv[at], rest: [...argv.slice(0, at), ...argv.slice(at + 1)] };
    }
    return { name: null, rest: argv };
}

function usage(stderr, message) {
    stderr.write('markest: ' + message + '\nRun markest --help for the commands.\n');
    return EXIT.USAGE;
}

export async function main(argv, { env = {}, stdout, stderr, fetch, stdin, browser, sleep } = {}) {
    let { name, rest } = splitCommand(argv);
    if (name === 'help') {
        const asked = rest.find((arg) => !arg.startsWith('-'));
        // Stryker disable next-line ConditionalExpression: equivalent - the registry has no command undefined
        const one = asked === undefined ? null : COMMANDS.get(asked);
        if (asked !== undefined && !one) return usage(stderr, 'Unknown command "' + asked + '".');
        stdout.write(one ? one.help : generalHelp());
        return EXIT.OK;
    }
    const command = name === null ? null : COMMANDS.get(name);
    if (name !== null && !command) {
        return usage(stderr, 'Unknown command "' + name + '". The commands are: ' + [...COMMANDS.keys()].join(', ') + '.');
    }
    const flags = readFlags(rest, command?.flags);
    if (flags.usageError) return usage(stderr, flags.usageError);
    const { values, positionals } = flags;
    if (values.version) {
        stdout.write(await version() + '\n');
        return EXIT.OK;
    }
    if (command === null || values.help) {
        stdout.write(command ? command.help : generalHelp());
        return EXIT.OK;
    }
    const site = siteFrom(values, env);
    if (site.error) return usage(stderr, site.error);
    const asked = command.parse(values, positionals, env);
    if (asked.usageError) return usage(stderr, asked.usageError);
    const running = await version();
    const warn = (text) => stderr.write(text);
    // One vault a run, its secret store asked once; the commands that sign in and out read it themselves
    const vault = vaultFor({ env, warn });
    let auth = NONE;
    if (command.credential !== false) {
        try {
            auth = await credentialFor({ env, site: site.url, vault, fetch, version: running, warn });
        } catch (error) {
            stderr.write('markest: ' + redact(error.message, keyFrom(env)) + '\n');
            return EXIT.FAILED;
        }
        if (auth.error) return usage(stderr, auth.error);
    }
    if (!auth.present && command.needsKey(asked)) return usage(stderr, 'Sign in with markest login, or set MARKEST_API_KEY to an API key from your account settings.');
    try {
        return await command.run({
            ...asked,
            json: Boolean(values.json),
            // A key keeps being handed on as it always was; a sign-in is the run's auth
            key: auth.kind === 'key' ? auth.key : '',
            auth: auth.kind === 'oauth' ? auth : undefined,
            vault,
            baseUrl: site.url, env, stdout, stderr, fetch, stdin, version: running,
            // How login opens a browser and waits between asks, as a test hands them in
            browser, sleep,
        });
    } catch (error) {
        stderr.write('markest: ' + redact(error && error.message ? error.message : error, [...auth.secrets(), keyFrom(env)]) + '\n');
        return EXIT.FAILED;
    }
}
