/**
 * `markest secret run` (cli/commands/secret-run) and its masker (cli/core/mask-stream)
 * against the fake site: a usage error fetches nothing; an approved value reaches
 * the child's environment and nowhere else; the child's output is masked; a
 * sealed secret is opened with the kept key; an approval is asked for, waited
 * for or timed out; a refusal runs nothing and a secret already handed over
 * is said to be spent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { freshHome, homeEnv, KEY, TEST_ENV, testKeyring } from './support/cli-harness.mjs';
import { main } from '../src/main.mjs';
import { newKey, sealAll } from '../src/sealed/sealing.mjs';
import { createMasker, maskStream, maskText, patternsFor } from '../src/core/mask-stream.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VALUE = 'sk_' + 'live_Tr0ub4dor&3-not-a-real-key';
const OTHER = 'whsec_another/secret+value=1234';
const base = (name) => '/api/v1/pastes/' + ID + '/secrets/' + encodeURIComponent(name) + '/use';
const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};
const approved = (value) => ({ paste_id: ID, status: 'approved', reference: 'r', label: 'l', path: 'env.md', value });
const needs = (url) => ({ paste_id: ID, status: 'approval_required', approval_url: url });

/** The next POST of the secret answered; a list answers one POST each, in order. */
function answers(site, name, ...list) {
    for (const [status, body] of list) site.answerOnce((one) => one.method === 'POST' && one.path === base(name), (req, res) => reply(res, status, body));
}
const posts = (site) => site.requests.filter((one) => one.method === 'POST');

/** A child process that prints `out` and `err` chunks (strings or buffers), then ends with `code`. */
function fakeChild({ out = [], err = [], code = 0, signal = null, error = null } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(async () => {
        if (error) return child.emit('error', error);
        for (const chunk of out) { child.stdout.write(Buffer.from(chunk)); await new Promise((r) => setImmediate(r)); }
        for (const chunk of err) { child.stderr.write(Buffer.from(chunk)); await new Promise((r) => setImmediate(r)); }
        child.stdout.end();
        child.stderr.end();
        child.emit('close', signal ? null : code, signal);
    });
    return child;
}

/** The site's address given before any --, so it is never taken for the child's argument. */
const withUrl = (argv, url) => {
    const at = argv.indexOf('--');
    return at < 0 ? [...argv, '--url', url] : [...argv.slice(0, at), '--url', url, ...argv.slice(at)];
};

/** A run of the tool with a spawn that records its calls, and a clock that only moves when it sleeps. */
async function drive(site, home, argv, { child = {}, env = {}, stdin } = {}) {
    let stdout = '';
    let stderr = '';
    const spawned = [];
    const sleeps = [];
    let clock = 1000;
    const code = await main(withUrl(argv, site.url), {
        env: { ...TEST_ENV, MARKEST_API_KEY: KEY, ...homeEnv(home), KEPT_VARIABLE: 'kept', ...env },
        stdout: { write: (t) => { stdout += t; } },
        stderr: { write: (t) => { stderr += t; } },
        stdin: stdin ?? Readable.from([]),
        spawn: (command, args, options) => { spawned.push({ command, args, options }); return fakeChild(child); },
        sleep: async (ms) => { sleeps.push(ms); clock += ms; },
        now: () => clock,
    });
    return { code, stdout, stderr, spawned, sleeps };
}

async function withSite(body) {
    const site = await startFakeMarkest();
    const home = await freshHome();
    try {
        await body(site, home);
    } finally {
        await site.close();
    }
}

const absent = (out, ...values) => {
    for (const value of values) for (const text of [out.stdout, out.stderr]) assert.ok(!text.includes(value), 'a value was printed: ' + text);
};

test('usage errors exit 2 before anything is fetched or started', async () => {
    await withSite(async (site, home) => {
        for (const [argv, said] of [
            [['run', ID, '--env', 'A=Stripe key'], /after --/],
            [['run', ID, '--env', 'A=Stripe key', '--'], /after --/],
            [['run', ID, '--', 'echo'], /Say which secrets/],
            [['run', ID, '--env', 'NOEQUALS', '--', 'echo'], /VAR>=<secret name/],
            [['run', ID, '--env', 'A=', '--', 'echo'], /VAR>=<secret name/],
            [['run', ID, '--env', '1A=x', '--', 'echo'], /not a variable name/],
            [['run', ID, '--env', 'A-B=x', '--', 'echo'], /not a variable name/],
            [['run', ID, '--env', 'A=x', '--env', 'A=y', '--', 'echo'], /given twice/],
            [['run', '--env', 'A=x', '--', 'echo'], /Name the artifact/],
            [['run', 'not-an-id', '--env', 'A=x', '--', 'echo'], /not an artifact/],
            [['run', ID, 'extra', '--env', 'A=x', '--', 'echo'], /Too many arguments/],
            [['run', ID, '--env', 'A=x', '--json', '--', 'echo'], /--json has no meaning/],
            [['run', ID, '--env', 'A=x', '--sealed', '--', 'echo'], /no --file or --sealed/],
            [['list', ID, '--wait'], /--wait belongs to run/],
            [['set', ID, 'x', '--', 'echo'], /Nothing is given after --/],
        ]) {
            const out = await drive(site, home, ['secret', ...argv]);
            assert.equal(out.code, 2, argv.join(' '));
            assert.match(out.stderr, said, argv.join(' '));
            assert.equal(out.spawned.length, 0);
        }
        assert.equal(site.requests.length, 0, 'nothing was requested');
    });
});

test('an approved value reaches the child\'s environment beside the existing one; command and arguments pass through; its exit code is returned; the value is never printed', async () => {
    await withSite(async (site, home) => {
        answers(site, 'Stripe key', [200, approved(VALUE)]);
        answers(site, 'Webhook', [200, approved(OTHER)]);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'STRIPE_KEY=Stripe key', '--env', 'HOOK=Webhook', '--', 'npm', 'run', '--flag', 'a b', '--url', 'x'], { child: { out: ['deployed with ' + VALUE + '\n'], err: ['hook ' + OTHER + '\n'], code: 7 } });
        assert.equal(out.code, 7);
        assert.equal(out.spawned.length, 1);
        const { command, args, options } = out.spawned[0];
        assert.equal(command, 'npm');
        assert.deepEqual(args, ['run', '--flag', 'a b', '--url', 'x'], 'after -- nothing is read as the tool\'s own');
        assert.equal(options.env.STRIPE_KEY, VALUE);
        assert.equal(options.env.HOOK, OTHER);
        assert.equal(options.env.KEPT_VARIABLE, 'kept', 'the current environment is kept');
        assert.equal(options.shell, false);
        assert.deepEqual(options.stdio, ['inherit', 'pipe', 'pipe']);
        assert.equal(out.stdout, 'deployed with [secret]\n');
        assert.equal(out.stderr, 'hook [secret]\n');
        absent(out, VALUE, OTHER);
        assert.equal(posts(site).length, 2);
        assert.equal(posts(site)[0].path, base('Stripe key'), 'the name is URL-encoded');
        assert.equal(posts(site)[0].bytes.length, 0, 'no body');
    });
});

test('the child is really started, with the value in its environment, and a signal is exit 1', async () => {
    await withSite(async (site, home) => {
        answers(site, 'Stripe key', [200, approved(VALUE)]);
        let stdout = '';
        let stderr = '';
        const code = await main(['secret', 'run', ID, '--env', 'V=Stripe key', '--url', site.url, '--', process.execPath, '-e', 'process.stdout.write("got:" + process.env.V + ":" + process.env.KEPT_VARIABLE); process.exit(5)'], {
            env: { ...TEST_ENV, ...process.env, MARKEST_API_KEY: KEY, ...homeEnv(home), KEPT_VARIABLE: 'kept' },
            stdout: { write: (t) => { stdout += t; } }, stderr: { write: (t) => { stderr += t; } }, stdin: Readable.from([]),
        });
        assert.equal(code, 5, stderr);
        assert.equal(stdout, 'got:[secret]:kept');
        absent({ stdout, stderr }, VALUE);
    });
});

test('a program that cannot be started, or that a signal ends, is exit 1 and says so, without the value', async () => {
    await withSite(async (site, home) => {
        answers(site, 'Stripe key', [200, approved(VALUE)]);
        const missing = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'nope-' + VALUE], { child: { error: Object.assign(new Error('spawn nope-' + VALUE + ' ENOENT'), { code: 'ENOENT' }) } });
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /no such program/);
        assert.match(missing.stderr, /sh -c/);
        absent(missing, VALUE);
        answers(site, 'Stripe key', [200, approved(VALUE)]);
        const killed = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'x'], { child: { signal: 'SIGTERM' } });
        assert.equal(killed.code, 1);
        assert.match(killed.stderr, /ended by the signal SIGTERM/);
    });
});

test('a short value is left unmasked, with one note', async () => {
    await withSite(async (site, home) => {
        answers(site, 'Pin', [200, approved('123')]);
        answers(site, 'Stripe key', [200, approved(VALUE)]);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'PIN=Pin', '--env', 'V=Stripe key', '--', 'x'], { child: { out: ['pin 123 and ' + VALUE] } });
        assert.equal(out.code, 0);
        assert.equal(out.stdout, 'pin 123 and [secret]');
        assert.equal(out.stderr.match(/too short to mask/g).length, 1);
        assert.match(out.stderr, /PIN is too short to mask/);
        assert.equal(out.spawned[0].options.env.PIN, '123');
    });
});

test('the child\'s output is masked: a value split across chunks, multi-line, base64, URL-encoded, and multi-byte text split across chunks', async () => {
    await withSite(async (site, home) => {
        const multi = 'line-one-of-the-key\nshort\nline-three-of-the-key';
        const odd = 'pässwörd-€-ünï-key';
        answers(site, 'Stripe key', [200, approved(VALUE)]);
        answers(site, 'Multi', [200, approved(multi)]);
        answers(site, 'Odd', [200, approved(odd)]);
        const b64 = Buffer.from(VALUE).toString('base64');
        const url = encodeURIComponent(VALUE);
        const half = Math.floor(VALUE.length / 2);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'A=Stripe key', '--env', 'M=Multi', '--env', 'O=Odd', '--', 'x'], {
            child: {
                out: [
                    'x ' + VALUE.slice(0, half), VALUE.slice(half) + ' y\n',
                    'b64 ' + b64 + ' url ' + url + '\n',
                    multi + '\nline-three-of-the-key alone, short stays\n',
                    'héllo € and ' + odd + '\n',
                ],
                err: ['err ' + VALUE + '\n'],
            },
        });
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, ['x [secret] y', 'b64 [secret] url [secret]', '[secret]', '[secret] alone, short stays', 'héllo € and [secret]', ''].join('\n'));
        assert.equal(out.stderr, 'err [secret]\n');
        absent(out, VALUE, b64, url, 'line-one-of-the-key', odd);
    });
});

test('a multi-byte character cut between two chunks is whole in the output', async () => {
    const written = [];
    const stream = new PassThrough();
    const done = maskStream(stream, patternsFor([VALUE]).patterns, (t) => written.push(t));
    const bytes = Buffer.from('a€b ' + VALUE + ' é');
    for (let i = 0; i < bytes.length; i += 2) stream.write(bytes.subarray(i, i + 2));
    stream.end();
    await done;
    assert.equal(written.join(''), 'a€b [secret] é');
});

test('maskText and patternsFor: forms, short values, lines, overlaps', () => {
    const { patterns, short } = patternsFor(['abc', VALUE, 'a b&c=d/e?f']);
    assert.deepEqual(short, [0]);
    assert.ok(patterns.includes(VALUE));
    assert.ok(patterns.includes(Buffer.from(VALUE).toString('base64')));
    assert.ok(patterns.includes(encodeURIComponent('a b&c=d/e?f')));
    assert.ok(!patterns.includes('abc'));
    // A value that encodes to itself is one pattern
    assert.equal(patternsFor(['plainvalue']).patterns.filter((one) => one === 'plainvalue').length, 1);
    assert.equal(maskText('x ' + VALUE + VALUE + ' y', patterns), 'x [secret][secret] y');
    assert.equal(maskText('nothing here', patterns), 'nothing here');
    assert.equal(maskText('anything', []), 'anything');
    // Regular-expression characters in a value are not special
    assert.equal(maskText('see (a.b*c) now', patternsFor(['(a.b*c)']).patterns), 'see [secret] now');
    // Lines of a multi-line value: 8 or more characters only; CRLF too
    const lines = patternsFor(['12345678\r\nshort\r\nabcdefgh']).patterns;
    assert.equal(maskText('12345678 short abcdefgh', lines), '[secret] short [secret]');
    // The longer pattern wins where one holds the other
    assert.equal(maskText('prefix-secret-long', patternsFor(['prefix-secret', 'prefix-secret-long']).patterns), '[secret]');
});

test('createMasker holds back at most the longest pattern minus one, finds a value split at any point, and flushes at the end', () => {
    const { patterns } = patternsFor([VALUE]);
    const longest = Math.max(...patterns.map((one) => one.length));
    const text = 'start ' + VALUE + ' middle ' + Buffer.from(VALUE).toString('base64') + ' end';
    for (let cut = 0; cut <= text.length; cut++) {
        const written = [];
        const masker = createMasker(patterns, (t) => written.push(t));
        masker.push(text.slice(0, cut));
        masker.push(text.slice(cut));
        assert.ok(text.length - cut >= 0);
        masker.end();
        assert.equal(written.join(''), 'start [secret] middle [secret] end', 'cut at ' + cut);
    }
    const written = [];
    const masker = createMasker(patterns, (t) => written.push(t));
    masker.push('x'.repeat(100));
    assert.equal(written.join('').length, 100 - (longest - 1), 'all but longest - 1 written at once');
    masker.end();
    assert.equal(written.join(''), 'x'.repeat(100), 'the rest at the end');
    // Not holding anything with nothing to hide
    const plain = [];
    const none = createMasker([], (t) => plain.push(t));
    none.push('abc');
    none.push('');
    none.end();
    assert.deepEqual(plain, ['abc']);
    // A surrogate pair is not cut in two
    const emoji = [];
    const pairs = createMasker(['secret-value'], (t) => emoji.push(t));
    pairs.push('😀'.repeat(30));
    for (const piece of emoji) assert.ok(!/[\ud800-\udbff]$/.test(piece));
    pairs.end();
    assert.equal(emoji.join(''), '😀'.repeat(30));
});

test('maskStream ends on an error of the stream and takes a string chunk', async () => {
    const written = [];
    const stream = new PassThrough({ encoding: 'utf8' });
    const done = maskStream(stream, ['abcdef'], (t) => written.push(t));
    stream.write('one abcdef two');
    stream.destroy(new Error('gone'));
    await done;
    assert.equal(written.join(''), 'one [secret] two');
});

test('a sealed secret is opened with the key this machine keeps', async () => {
    await withSite(async (site, home) => {
        const key = (await newKey()).text;
        await testKeyring(home).remember(site.url, ID, key);
        const [sealed] = await sealAll(key, [{ path: '', contentType: 'secret', content: VALUE }]);
        assert.match(sealed.content, /^MKSEAL1:/);
        answers(site, 'Stripe key', [200, { paste_id: ID, status: 'sealed', reference: 'r', label: 'l', path: 'env.md', envelope: sealed.content }]);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'x'], { child: { out: ['v=' + VALUE] } });
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.spawned[0].options.env.V, VALUE);
        assert.equal(out.stdout, 'v=[secret]');
        absent(out, VALUE, sealed.content, key);
    });
});

test('a sealed secret with no kept key, or the wrong one, is refused: the secret is named, no envelope and no key is printed', async () => {
    await withSite(async (site, home) => {
        const key = (await newKey()).text;
        const [sealed] = await sealAll(key, [{ path: '', contentType: 'secret', content: VALUE }]);
        const envelope = { paste_id: ID, status: 'sealed', envelope: sealed.content };
        answers(site, 'Stripe key', [200, envelope]);
        const none = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'x']);
        assert.equal(none.code, 1);
        assert.match(none.stderr, /"Stripe key" is sealed end to end, and this machine holds no key/);
        assert.match(none.stderr, /markest keys --add/);
        assert.equal(none.spawned.length, 0);
        absent(none, VALUE, sealed.content, key);

        const wrong = (await newKey()).text;
        await testKeyring(home).remember(site.url, ID, wrong);
        answers(site, 'Stripe key', [200, envelope]);
        const bad = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'x']);
        assert.equal(bad.code, 1);
        assert.match(bad.stderr, /does not open the secret "Stripe key"/);
        assert.equal(bad.spawned.length, 0);
        absent(bad, VALUE, sealed.content, key, wrong);

        answers(site, 'Stripe key', [200, { paste_id: ID, status: 'approved' }]);
        const empty = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'x']);
        assert.equal(empty.code, 1);
        assert.match(empty.stderr, /held no value/);
    });
});

test('approval needed without --wait: nothing is run, every link is printed, exit 3', async () => {
    await withSite(async (site, home) => {
        answers(site, 'Stripe key', [202, needs('https://marke.st/approve/one')]);
        answers(site, 'Webhook', [202, needs('https://marke.st/approve/two')]);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'A=Stripe key', '--env', 'B=Webhook', '--', 'x']);
        assert.equal(out.code, 3);
        assert.equal(out.spawned.length, 0);
        assert.equal(out.stdout, '');
        assert.match(out.stderr, /"Stripe key" needs the person's approval: https:\/\/marke\.st\/approve\/one/);
        assert.match(out.stderr, /"Webhook" needs the person's approval: https:\/\/marke\.st\/approve\/two/);
        assert.match(out.stderr, /run the same command again/);
        assert.equal(out.sleeps.length, 0, 'no waiting');
        assert.doesNotMatch(out.stderr, /spent/);
    });
});

test('--wait asks again every 3 seconds until approved, then runs', async () => {
    await withSite(async (site, home) => {
        answers(site, 'Stripe key', [202, needs('https://marke.st/approve/one')], [202, needs('https://marke.st/approve/one')], [200, approved(VALUE)]);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--wait', '--', 'x'], { child: { out: [VALUE] } });
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(out.sleeps, [3000, 3000]);
        assert.equal(posts(site).length, 3);
        assert.equal(out.stderr.match(/approve\/one/g).length, 1, 'the link is said once');
        assert.equal(out.spawned[0].options.env.V, VALUE);
        assert.equal(out.stdout, '[secret]');
    });
});

test('--wait that is not answered in 5 minutes is exit 3 and runs nothing', async () => {
    await withSite(async (site, home) => {
        for (let i = 0; i < 200; i++) answers(site, 'Stripe key', [202, needs('https://marke.st/approve/one')]);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--wait', '--', 'x']);
        assert.equal(out.code, 3);
        assert.equal(out.spawned.length, 0);
        assert.equal(out.sleeps.length, 100, '5 minutes of 3 seconds');
        assert.match(out.stderr, /came within 5 minutes/);
    });
});

test('a refusal - 401, 403, 404 or 409 - runs nothing, exits 1, says the site\'s words and never a value', async () => {
    await withSite(async (site, home) => {
        for (const [status, error] of [[401, 'Sign in'], [403, 'Closed to agents and scripts'], [404, 'No such secret'], [409, 'Several secrets share that name']]) {
            answers(site, 'Stripe key', [status, { error }]);
            const out = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'x']);
            assert.equal(out.code, 1, String(status));
            assert.match(out.stderr, new RegExp(error), String(status));
            assert.equal(out.spawned.length, 0);
            assert.doesNotMatch(out.stderr, /spent/, 'nothing was handed over');
            absent(out, VALUE);
        }
    });
});

test('when the second of two secrets fails, the child is not started and the spent note is printed, without the value', async () => {
    await withSite(async (site, home) => {
        answers(site, 'Stripe key', [200, approved(VALUE)]);
        answers(site, 'Webhook', [404, { error: 'No such secret ' + VALUE }]);
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'A=Stripe key', '--env', 'B=Webhook', '--', 'x']);
        assert.equal(out.code, 1);
        assert.equal(out.spawned.length, 0);
        assert.match(out.stderr, /No such secret/);
        assert.match(out.stderr, /Nothing was run\. 1 secret already handed over in this run \("Stripe key"\) has been spent and will need approving again/);
        absent(out, VALUE);

        answers(site, 'Stripe key', [200, approved(VALUE)]);
        answers(site, 'Webhook', [202, needs('https://marke.st/approve/two')]);
        const waiting = await drive(site, home, ['secret', 'run', ID, '--env', 'A=Stripe key', '--env', 'B=Webhook', '--', 'x']);
        assert.equal(waiting.code, 3);
        assert.equal(waiting.spawned.length, 0);
        assert.match(waiting.stderr, /approve\/two/);
        assert.match(waiting.stderr, /has been spent/);
        absent(waiting, VALUE);
    });
});

test('a lost connection is exit 1 and run nothing', async () => {
    await withSite(async (site, home) => {
        site.answerOnce((one) => one.method === 'POST', (req) => req.socket.destroy());
        const out = await drive(site, home, ['secret', 'run', ID, '--env', 'V=Stripe key', '--', 'x']);
        assert.equal(out.code, 1);
        assert.match(out.stderr, /connection to the site was lost/);
        assert.equal(out.spawned.length, 0);
    });
});
