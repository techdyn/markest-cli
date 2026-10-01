/**
 * How the tool finds a command, reads what every command takes and answers a
 * wrong one, and what its help says (cli/main).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generalHelp, main, version } from '../src/main.mjs';
import { COMMANDS } from '../src/commands/registry.mjs';
import { run, KEY } from './support/cli-harness.mjs';

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
    assert.match(generalHelp(), /\n\nEvery command takes --url <site> \(default https:\/\/marke\.st, or MARKEST_URL\)\nand --json\. The API key is read from MARKEST_API_KEY \(or MARKEST_KEY\)\.\nmarkest help <command> shows how to call one\.\n$/);
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
    assert.match(general.stdout, /Commands:\n {2}publish +Publish a folder/);
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
        const code = await main(['publish', 'd'], { env: { MARKEST_API_KEY: KEY }, ...io });
        assert.equal(code, 1);
        assert.match(stderr, /^markest: boom with mk_…\n$/);
        COMMANDS.get('publish').run = async () => { throw 'plain'; };
        stderr = '';
        assert.equal(await main(['publish', 'd'], { env: { MARKEST_API_KEY: KEY }, ...io }), 1);
        assert.equal(stderr, 'markest: plain\n');
    } finally {
        COMMANDS.get('publish').run = original;
    }
});
