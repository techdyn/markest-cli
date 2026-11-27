/**
 * `markest secret list` and `secret set` against the fake site (cli/commands/secrets):
 * the slots listed, a value sent from the environment, a file or stdin exactly
 * and never printed - on success or on any refusal - and sealed on this machine
 * with a key kept before the request is made.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, freshHome, homeEnv, KEY, makeFolder, TEST_ENV, testKeyring } from './support/cli-harness.mjs';
import { main } from '../src/main.mjs';
import { openAll } from '../src/sealed/sealing.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VALUE = 'sk_' + 'live_Tr0ub4dor&3-not-a-real-key';
const SLOT = { name: 'Stripe key', reference: 'a'.repeat(24), state: 'held', agents: 'never', path: 'env.md' };
const PATH = '/api/v1/pastes/' + ID + '/secrets/Stripe%20key';

const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

async function withSite(body) {
    const site = await startFakeMarkest();
    const home = await freshHome();
    const markest = (argv, options = {}) => against(site)(argv, { ...options, env: { MARKEST_API_KEY: KEY, ...homeEnv(home), ...(options.env ?? {}) } });
    try {
        await body(site, markest, home);
    } finally {
        await site.close();
    }
}

/** The next PUT of the slot answered with `status` and `body` (or `ok`: the slot's state said back). */
function answerPut(site, status = 200, body = null, seen = []) {
    site.answerOnce((one) => one.method === 'PUT' && one.path === PATH, (req, res, record) => {
        seen.push(record);
        if (status === 'drop') return req.socket.destroy();
        reply(res, status, body ?? { paste_id: ID, secret: { ...SLOT, state: 'held' } });
    });
    return seen;
}

const puts = (site) => site.requests.filter((one) => one.method === 'PUT');
const noValue = (out, value = VALUE) => {
    for (const text of [out.stdout, out.stderr]) assert.ok(!text.includes(value), 'the value was printed: ' + text);
};

test('list prints the slots as a table, or the site\'s answer with --json', async () => {
    await withSite(async (site, markest) => {
        const answer = { paste_id: ID, secrets: [SLOT, { name: 'Db', reference: null, state: 'empty', agents: 'ask', path: 'db.md' }] };
        site.answerOnce((one) => one.method === 'GET' && one.path === '/api/v1/pastes/' + ID + '/secrets', (req, res) => reply(res, 200, answer));
        const out = await markest(['secret', 'list', ID]);
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, 'NAME        STATE  AGENTS  DOCUMENT\nStripe key  held   never   env.md\nDb          empty  ask     db.md\n');
        site.answerOnce((one) => one.method === 'GET', (req, res) => reply(res, 200, answer));
        const json = await markest(['secret', 'list', ID, '--json']);
        assert.deepEqual(JSON.parse(json.stdout), answer);
        site.answerOnce((one) => one.method === 'GET', (req, res) => reply(res, 200, { paste_id: ID, secrets: [] }));
        assert.equal((await markest(['secret', 'list', ID])).stdout, 'No secret slots.\n');
        site.answerOnce((one) => one.method === 'GET', (req, res) => reply(res, 404, { error: 'Not found' }));
        const missing = await markest(['secret', 'list', ID]);
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /Not found/);
    });
});

test('set sends the value from the environment, a file or stdin as the raw body, one trailing line ending dropped, and prints nothing of it', async () => {
    await withSite(async (site, markest) => {
        const folder = await makeFolder({ 'token.txt': VALUE + '\r\n\n' });
        const sources = [
            [['--env', 'STRIPE'], { env: { STRIPE: VALUE } }, VALUE],
            [['--file', join(folder, 'token.txt')], {}, VALUE + '\r\n'],
            [[], { stdin: VALUE + '\n' }, VALUE],
            [[], { stdin: VALUE + '\r\n' }, VALUE],
            [[], { stdin: VALUE + '\n\n' }, VALUE + '\n'],
        ];
        for (const [flags, options, sent] of sources) {
            const seen = answerPut(site);
            const out = await markest(['secret', 'set', ID, 'Stripe key', ...flags], options);
            assert.equal(out.code, 0, out.stderr);
            assert.equal(out.stdout, 'Set "Stripe key" in env.md (held).\n');
            assert.equal(out.stderr, '');
            noValue(out);
            assert.equal(seen.length, 1);
            assert.equal(seen[0].path, PATH, 'the name is URL-encoded');
            assert.equal(seen[0].headers['content-type'], 'text/plain; charset=utf-8');
            // The file ends "\r\n\n": exactly one line ending goes
            assert.equal(seen[0].bytes.toString(), flags[0] === '--file' ? VALUE + '\r\n' : sent);
        }
        const seen = answerPut(site);
        const json = await markest(['secret', 'set', ID, 'Stripe key', '--env', 'STRIPE', '--json'], { env: { STRIPE: VALUE } });
        assert.deepEqual(JSON.parse(json.stdout), { paste_id: ID, secret: SLOT });
        noValue(json);
        assert.equal(seen[0].bytes.toString(), VALUE, 'an environment variable is sent as it is');
    });
});

test('no refusal of the site, nor a lost connection, says the value', async () => {
    await withSite(async (site, markest) => {
        for (const [status, error] of [[404, 'No slot named that'], [409, 'Several slots share that name'], [422, 'A slot cannot hold that value'], [401, 'Sign in'], [403, 'Not yours']]) {
            // A site that echoed the value back is not trusted to keep it out of the message
            answerPut(site, status, { error: error + ': ' + VALUE });
            const out = await markest(['secret', 'set', ID, 'Stripe key', '--env', 'STRIPE', '--json'], { env: { STRIPE: VALUE } });
            assert.equal(out.code, 1, String(status));
            assert.match(out.stderr, new RegExp(error), String(status));
            assert.equal(JSON.parse(out.stdout).status, status);
            noValue(out);
        }
        answerPut(site, 'drop');
        const lost = await markest(['secret', 'set', ID, 'Stripe key'], { stdin: VALUE });
        assert.equal(lost.code, 1);
        assert.match(lost.stderr, /connection to the site was lost/);
        noValue(lost);
    });
});

test('usage errors send nothing and say nothing of the value', async () => {
    await withSite(async (site, markest) => {
        const folder = await makeFolder({ 'v.txt': VALUE });
        for (const [argv, options, said] of [
            [['set', ID, 'Stripe key', '--env', 'STRIPE', '--file', join(folder, 'v.txt')], { env: { STRIPE: VALUE } }, /not both/],
            [['set', ID, 'Stripe key', '--env', 'NOT_SET'], {}, /NOT_SET is not set, or is empty/],
            [['set', ID, 'Stripe key', '--env', 'EMPTY'], { env: { EMPTY: '' } }, /EMPTY is not set, or is empty/],
            [['set', ID, 'Stripe key', '--file', join(folder, 'gone.txt')], {}, /could not be read/],
            [['set', ID, 'Stripe key'], { stdin: '\n' }, /value is empty/],
            [['set', ID], { stdin: VALUE }, /Name the slot/],
            [['set', ID, 'a', 'b'], { stdin: VALUE }, /Too many arguments/],
            [['set'], {}, /Name the artifact/],
            [['list'], {}, /Name the artifact/],
            [['list', ID, '--sealed'], {}, /list takes no/],
            [[], {}, /Say what to do/],
        ]) {
            const out = await markest(['secret', ...argv], options);
            assert.equal(out.code, 2, argv.join(' '));
            assert.match(out.stderr, said);
            noValue(out);
        }
        assert.equal(puts(site).length, 0, 'nothing was sent');
    });
});

test('with no source on a terminal, set refuses rather than read what is typed', async () => {
    const site = await startFakeMarkest();
    try {
        let stderr = '';
        const code = await main(['secret', 'set', ID, 'Stripe key', '--url', site.url], {
            env: { ...TEST_ENV, MARKEST_API_KEY: KEY }, stdout: { write: () => {} }, stderr: { write: (t) => { stderr += t; } }, stdin: { isTTY: true },
        });
        assert.equal(code, 2);
        assert.match(stderr, /pipe it in, or use --env/);
        assert.equal(site.requests.length, 0);
    } finally {
        await site.close();
    }
});

test('--sealed sends only an envelope, keeps its key before sending, reuses it, and the envelope opens to the value', async () => {
    await withSite(async (site, markest, home) => {
        const keyring = testKeyring(home);
        assert.equal(await keyring.get(site.url, ID), null);
        const kept = [];
        const seen = [];
        site.answerOnce((one) => one.method === 'PUT' && one.path === PATH, async (req, res, record) => {
            kept.push(await keyring.get(site.url, ID));
            seen.push(record);
            reply(res, 200, { paste_id: ID, secret: { ...SLOT, state: 'sealed' } });
        });
        const first = await markest(['secret', 'set', ID, 'Stripe key', '--sealed'], { stdin: VALUE + '\n' });
        assert.equal(first.code, 0, first.stderr);
        assert.equal(first.stdout, 'Set "Stripe key" in env.md (sealed).\n');
        noValue(first);
        assert.match(first.stderr, /new key for this artifact is kept on this machine\. markest link 01ARZ3NDEKTSV4RRFFQ69G5FAV prints the link/);
        const key = await keyring.get(site.url, ID);
        assert.ok(key);
        assert.equal(kept[0], key, 'the key was kept when the request arrived');
        assert.ok(!first.stdout.includes(key) && !first.stderr.includes(key), 'the key is never printed');
        const body = seen[0].bytes.toString();
        assert.match(body, /^MKSEAL1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/);
        assert.ok(!body.includes(VALUE));
        assert.equal(seen[0].headers['content-type'], 'text/plain; charset=utf-8');
        const [opened] = await openAll(key, [{ path: '', contentType: 'secret', content: body }]);
        assert.equal(opened.content, VALUE);

        const second = answerPut(site, 200, { paste_id: ID, secret: { ...SLOT, state: 'sealed' } });
        const again = await markest(['secret', 'set', ID, 'Stripe key', '--sealed'], { stdin: VALUE });
        assert.equal(again.code, 0, again.stderr);
        assert.equal(again.stderr, '', 'no new key, no note');
        assert.equal(await keyring.get(site.url, ID), key, 'the same key');
        const [reopened] = await openAll(key, [{ path: '', contentType: 'secret', content: second[0].bytes.toString() }]);
        assert.equal(reopened.content, VALUE);
    });
});

test('--sealed keeps no value in the output when the site refuses', async () => {
    await withSite(async (site, markest) => {
        answerPut(site, 422, { error: 'A slot cannot hold that value' });
        const out = await markest(['secret', 'set', ID, 'Stripe key', '--sealed'], { stdin: VALUE });
        assert.equal(out.code, 1);
        noValue(out);
    });
});
