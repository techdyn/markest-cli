/**
 * How the tool finds a command, reads what every command takes and answers a
 * wrong one, and what its help says (cli/main).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generalHelp, main, version } from '../src/main.mjs';
import { COMMANDS } from '../src/commands/registry.mjs';
import { run, KEY, TEST_ENV } from './support/cli-harness.mjs';

test('the tool finds the command, and says what is wrong with one it cannot run', async () => {
    const wrong = await run(['send', 'd']);
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /Unknown command "send"\. The commands are: [a-z, ]*publish/);
    assert.match(wrong.stderr, /Run markest --help/);
    const noKey = await run(['publish', 'd'], {});
    assert.equal(noKey.code, 2);
    assert.match(noKey.stderr, /MARKEST_API_KEY/);
    const badUrl = await run(['publish', 'd', '--url', 'http://example.test']);
    assert.equal(badUrl.code, 2);
    assert.match(badUrl.stderr, /https/);
    const badFlag = await run(['publish', 'd', '--key', KEY]);
    assert.equal(badFlag.code, 2);
    assert.match(badFlag.stderr, /--key/);
    assert.ok(!badFlag.stderr.includes(KEY.slice(8)), 'and never repeats a key given as one');
    const asked = await run(['publish', 'a', 'b']);
    assert.equal(asked.code, 2, 'a command\'s own refusal is a usage error too');
    assert.match(asked.stderr, /One folder/);
    const dry = await run(['publish', 'no/such', '--dry-run'], { MARKEST_URL: 'http://localhost:1' });
    assert.match(dry.stderr, /is not a folder/, 'a new dry run needs no key, so it reaches the folder');
});

test('a usage error is one line naming what is wrong, then where to look', async () => {
    const wrong = await run(['send']);
    assert.equal(wrong.stderr, 'markest: Unknown command "send". The commands are: ' + [...COMMANDS.keys()].join(', ') + '.\nRun markest --help for the commands.\n');
    assert.equal(wrong.stdout, '');
    assert.equal((await run(['help', '--json', 'publish'])).stdout, COMMANDS.get('publish').help, 'a flag before the name asked about is passed over');
});

test('the commands are listed in one column, each summary starting where the others do', () => {
    const lines = generalHelp().split('\n');
    const listed = lines.slice(lines.indexOf('Commands:') + 1, lines.indexOf(''  , lines.indexOf('Commands:')));
    assert.equal(listed.length, COMMANDS.size);
    const longest = Math.max(...[...COMMANDS.keys()].map((name) => name.length));
    for (const [line, [name, command]] of listed.map((one, i) => [one, [...COMMANDS][i]])) {
        assert.equal(line, '  ' + name.padEnd(longest) + '  ' + command.summary);
    }
    assert.match(generalHelp(), /^Markest from the command line: publish, read and manage artifacts\.\n\nUsage:\n {2}markest <command> \[options\]\n\nCommands:\n/);
    assert.match(generalHelp(), /\n\nEvery command takes --url <site> \(default https:\/\/marke\.st, or MARKEST_URL\)\nand --json\. Sign in with markest login; an API key in MARKEST_API_KEY \(or\nMARKEST_KEY\) is used where you are not signed in\.\nmarkest help <command> shows how to call one\.\n$/);
});

test('flags may come before the command', async () => {
    const out = await run(['--url', 'http://example.test', 'publish', 'd']);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /https/, 'the site flag was read wherever it stood, its value not taken for the command');
    const joined = await run(['--url=http://example.test', 'publish', 'd']);
    assert.match(joined.stderr, /https/);
    const json = await run(['--json', 'publish', 'no/such']);
    assert.match(json.stderr, /is not a folder/, 'a flag with no value passes over nothing');
});

test('help says what there is, and more about one command', async () => {
    const general = await run([]);
    assert.equal(general.code, 0);
    assert.equal(general.stdout, generalHelp());
    // Signing in first, then publishing
    assert.match(general.stdout, /Commands:\n {2}login +Sign in to Markest/);
    assert.match(general.stdout, /\n {2}status +.*\n {2}publish +Publish a folder/);
    for (const [name, command] of COMMANDS) assert.match(general.stdout, new RegExp('\\n  ' + name + ' +' + command.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n'), name + ' is listed with its summary');
    assert.ok(general.stdout.split('\n').every((line) => line.length <= 80), 'every line fits a terminal');
    assert.equal((await run(['--help'])).stdout, general.stdout);
    assert.equal((await run(['help'])).stdout, general.stdout);
    const one = await run(['help', 'publish']);
    assert.equal(one.code, 0);
    assert.equal(one.stdout, COMMANDS.get('publish').help);
    assert.equal((await run(['publish', '--help'])).stdout, one.stdout);
    const unknown = await run(['help', 'send']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown command "send"/);
    assert.equal((await run(['-v'])).stdout, await version() + '\n');
    assert.equal((await run(['publish', '--version'])).stdout, await version() + '\n');
    assert.match(await version(), /^\d+\.\d+\.\d+$/);
});

test('what goes wrong unforeseen is said without the key, and exits 1', async () => {
    let stderr = '';
    const io = { stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } } };
    const original = COMMANDS.get('publish').run;
    COMMANDS.get('publish').run = async () => { throw new Error('boom with ' + KEY); };
    try {
        const code = await main(['publish', 'd'], { env: { ...TEST_ENV, MARKEST_API_KEY: KEY }, ...io });
        assert.equal(code, 1);
        assert.match(stderr, /^markest: boom with mk_…\n$/);
        COMMANDS.get('publish').run = async () => { throw 'plain'; };
        stderr = '';
        assert.equal(await main(['publish', 'd'], { env: { ...TEST_ENV, MARKEST_API_KEY: KEY }, ...io }), 1);
        assert.equal(stderr, 'markest: plain\n');
    } finally {
        COMMANDS.get('publish').run = original;
    }
});

// The run's credential, as main hands it on

const RECORD = { access_token: 'eyJsignedin.token.here', refresh_token: 'refresh-kept', expires_at: Date.now() + 3600000, scope: 'pastes.read', signed_in_at: '2026-10-02T09:00:00.000Z' };

/** A run of a command whose work is replaced by noting what it was handed. */
async function handed(name, env, stdin = '') {
    const { Readable } = await import('node:stream');
    const command = COMMANDS.get(name);
    const original = command.run;
    let seen = null;
    let stderr = '';
    command.run = async (ctx) => { seen = ctx; return 0; };
    try {
        const code = await main([name], { env, stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } }, stdin: Readable.from([Buffer.from(stdin)]) });
        return { code, seen, stderr };
    } finally {
        command.run = original;
    }
}

async function signedInHome(record = RECORD) {
    const { freshHome, testVault } = await import('./support/cli-harness.mjs');
    const { openSignIns } = await import('../src/auth/sign-in-store.mjs');
    const home = await freshHome();
    await openSignIns({ vault: testVault(home) }).putOAuth('https://marke.st', record);
    return home;
}

/** A home whose sign-in cannot be opened: its vault's key replaced, as a reset password leaves it. */
async function lockedHome() {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const home = await signedInHome();
    await writeFile(join(home, 'vault-key'), Buffer.alloc(32, 9).toString('base64') + '\n');
    return home;
}

test('a key is handed on as the key, a sign-in as the run\'s auth, and nothing as neither, each with the run\'s vault', async () => {
    const { homeEnv, freshHome } = await import('./support/cli-harness.mjs');
    const keyHome = await freshHome();
    const keyed = await handed('list', homeEnv(keyHome, { MARKEST_API_KEY: KEY }));
    assert.equal(keyed.code, 0, keyed.stderr);
    assert.equal(keyed.seen.key, KEY);
    assert.equal(keyed.seen.auth, undefined);
    assert.equal(keyed.seen.vault.folder, keyHome);

    const signedIn = await handed('list', homeEnv(await signedInHome(), { MARKEST_API_KEY: KEY }));
    assert.equal(signedIn.seen.key, '', 'the sign-in first, and no key beside it');
    assert.equal(signedIn.seen.auth.kind, 'oauth');
    assert.equal(await signedIn.seen.auth.bearer(), RECORD.access_token);

    const none = await handed('keys', homeEnv(await freshHome()));
    assert.equal(none.seen.key, '');
    assert.equal(none.seen.auth, undefined);
});

test('a sign-in that cannot be opened stops a run that has nothing else, said as it is', async () => {
    const { homeEnv } = await import('./support/cli-harness.mjs');
    const out = await handed('list', homeEnv(await lockedHome()));
    assert.equal(out.code, 1);
    assert.equal(out.seen, null);
    assert.match(out.stderr, /^markest: The file .*sign-in\.vault cannot be opened: the key that opens it is not in this machine's secret store any more\. Nothing was changed in it\. If the store is locked, unlock it and try again; if the file was kept with MARKEST_SECRET_STORE=file, set that again\.\n$/);

    const keyed = await handed('list', homeEnv(await lockedHome(), { MARKEST_API_KEY: KEY }));
    assert.equal(keyed.code, 0);
    assert.equal(keyed.seen.key, KEY, 'a key that is there serves');
    assert.match(keyed.stderr, /^markest: the sign-in kept here cannot be opened, so MARKEST_API_KEY is used: /);
});

test('the commands that sign in and out read the vault themselves: a locked one does not stop them', async () => {
    const { homeEnv } = await import('./support/cli-harness.mjs');
    const out = await handed('login', homeEnv(await lockedHome()));
    assert.equal(out.code, 0);
    assert.equal(out.seen.auth, undefined);
    assert.equal(out.seen.key, '');
});

test('a MARKEST_AUTH that is neither key nor oauth is a usage error, said', async () => {
    const out = await handed('list', { ...TEST_ENV, MARKEST_AUTH: 'always', MARKEST_API_KEY: KEY });
    assert.equal(out.code, 2);
    assert.match(out.stderr, /^markest: MARKEST_AUTH is key or oauth, or not set\./);
});

test('what goes wrong unforeseen is said without a key of any shape', async () => {
    let stderr = '';
    const original = COMMANDS.get('publish').run;
    COMMANDS.get('publish').run = async () => { throw new Error('boom with sekrit-123'); };
    try {
        const code = await main(['publish', 'd'], { env: { ...TEST_ENV, MARKEST_API_KEY: 'sekrit-123' }, stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } } });
        assert.equal(code, 1);
        assert.equal(stderr, 'markest: boom with …\n');
    } finally {
        COMMANDS.get('publish').run = original;
    }
});
