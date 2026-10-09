/**
 * What the commands that speak to the site share (cli/core/command-kit):
 * naming artifacts, answering in JSON or words, saying a refusal, lengths of
 * time, what was piped in, and dates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { answer, artifactsFrom, isRefusal, readAll, Refused, secondsFrom, when } from '../src/core/command-kit.mjs';
import { ApiError } from '../src/core/api-client.mjs';
import { AgentError } from '../src/core/agent-client.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

function context(json = false) {
    const out = { stdout: '', stderr: '' };
    return { out, ctx: { json, stdout: { write: (t) => { out.stdout += t; } }, stderr: { write: (t) => { out.stderr += t; } } } };
}

test('artifacts are named by id or address, as many as a command takes', () => {
    assert.deepEqual(artifactsFrom([ID, 'https://marke.st/p/' + OTHER.toLowerCase()], { usage: 'u', max: 2 }), { ids: [ID, OTHER] });
    assert.match(artifactsFrom([], { usage: 'markest x <artifact>' }).usageError, /^Name the artifact: markest x <artifact>$/);
    assert.match(artifactsFrom([ID, OTHER], { usage: 'u' }).usageError, /Too many arguments/);
    assert.match(artifactsFrom(['nope'], { usage: 'u' }).usageError, /"nope" is not an artifact's id or address/);
    assert.deepEqual(artifactsFrom([], { usage: 'u', min: 0 }), { ids: [] });
});

test('an answer is one JSON line with --json, else the command\'s words', async () => {
    const human = context();
    assert.equal(await answer(human.ctx, async () => ({ a: 1 }), (value) => 'a is ' + value.a + '\n'), 0);
    assert.equal(human.out.stdout, 'a is 1\n');
    const json = context(true);
    assert.equal(await answer(json.ctx, async () => ({ a: 1 }), () => 'unused'), 0);
    assert.equal(json.out.stdout, '{"a":1}\n');
    const silent = context();
    assert.equal(await answer(silent.ctx, async () => ({})), 0);
    assert.equal(silent.out.stdout, '', 'nothing to say says nothing');
});

test('a refusal - the site\'s or the command\'s - is said as it was said, exit 1; anything else goes up', async () => {
    for (const error of [new ApiError('No.\u001b[2J', { status: 403 }), new AgentError('Not in your plan.', { status: 403 }), new Refused('Not like that.')]) {
        assert.ok(isRefusal(error));
        const human = context();
        assert.equal(await answer(human.ctx, async () => { throw error; }), 1);
        assert.equal(human.out.stderr, 'markest: ' + error.message.replace('\u001b', '') + '\n', 'without control characters');
        assert.equal(human.out.stdout, '');
        const json = context(true);
        await answer(json.ctx, async () => { throw error; });
        assert.deepEqual(JSON.parse(json.out.stdout), { error: error.message, status: error.status || null });
    }
    assert.ok(!isRefusal(new Error('bug')));
    await assert.rejects(answer(context().ctx, async () => { throw new TypeError('a bug'); }), TypeError);
});

test('lengths of time are typed as people type them', () => {
    assert.equal(secondsFrom('never'), 0);
    assert.equal(secondsFrom('NEVER'), 0);
    assert.equal(secondsFrom('0'), 0);
    assert.equal(secondsFrom('90'), 90);
    assert.equal(secondsFrom('90s'), 90);
    assert.equal(secondsFrom('30m'), 1800);
    assert.equal(secondsFrom('12h'), 43200);
    assert.equal(secondsFrom(' 7d '), 604800);
    assert.equal(secondsFrom('4w'), 2419200);
    for (const bad of ['', 'soon', '7 d', '-1d', '1.5h', '7y', '1234567890', undefined]) assert.equal(secondsFrom(bad), null, String(bad));
});

test('what is piped in is read whole, and nothing when nothing is', async () => {
    assert.equal(await readAll(Readable.from([Buffer.from('a\n'), 'b'])), 'a\nb');
    assert.equal(await readAll(Readable.from([])), '');
    assert.equal(await readAll(null), '');
});

test('a date is the day and the minute in UTC', () => {
    assert.equal(when('2026-10-01T10:30:59+01:00'), '2026-10-01 09:30');
    assert.equal(when(''), '');
    assert.equal(when(null), '');
    assert.equal(when('not a date'), 'not a date');
});

test('the clients of a run carry its key, or none, and say on stderr when the site asks to wait', async () => {
    const { startFakeMarkest } = await import('./support/fake-markest.mjs');
    const { clientsFor } = await import('../src/core/command-kit.mjs');
    const site = await startFakeMarkest({ tools: { search: () => ({ ok: true }) } });
    try {
        let stderr = '';
        const ctx = { baseUrl: site.url, key: 'mk_live_' + 'ab'.repeat(24), version: '1', stderr: { write: (text) => { stderr += text; } } };
        const { rest, agent } = clientsFor(ctx);
        site.answerOnce(() => true, (req, res) => { res.writeHead(429, { 'Retry-After': '1' }); res.end('{}'); });
        await rest.request('GET', '/api/v1/pastes');
        assert.equal(stderr, 'The site asked to wait (429); trying again in 1 s.\n');
        assert.equal(site.requests.at(-1).headers.authorization, 'Bearer ' + ctx.key);
        assert.deepEqual(await agent.call('search', {}), { ok: true }, 'the agent speaks through the same client');
        const anonymous = clientsFor({ baseUrl: site.url, stderr: ctx.stderr });
        await anonymous.rest.request('GET', '/api/v1/drafts');
        assert.equal(site.requests.at(-1).headers.authorization, undefined, 'no key, no credential');
    } finally {
        await site.close();
    }
});

test('a run has a credential when it is signed in or has a key', async () => {
    const { hasCredential } = await import('../src/core/command-kit.mjs');
    assert.equal(hasCredential({}), false);
    assert.equal(hasCredential({ key: '' }), false);
    assert.equal(hasCredential({ key: 'mk_live_x' }), true);
    assert.equal(hasCredential({ auth: { present: true }, key: '' }), true);
    assert.equal(hasCredential({ auth: { present: false }, key: '' }), false);
    assert.equal(hasCredential({ auth: { present: false }, key: 'k' }), true);
});
