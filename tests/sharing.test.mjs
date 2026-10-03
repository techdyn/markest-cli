/**
 * `markest link`, `collaborators`, `fork`, `views` and `preview` against the
 * fake site (cli/commands/sharing): an address asked of nobody, a signed link
 * and the rest through the agent tools, in their words.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, run } from './support/cli-harness.mjs';
import { LINK_LIFETIMES } from '../src/commands/sharing.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

async function withSite(tools, body) {
    const site = await startFakeMarkest({ tools });
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

test('link prints the address, asking the site nothing and needing no key', async () => {
    const out = await run(['link', 'https://marke.st/p/' + ID + '/a.md', '--path', 'docs/my notes.md', '--url', 'https://marke.st'], {});
    assert.deepEqual(out, { code: 0, stdout: 'https://marke.st/p/' + ID + '/docs/my%20notes.md\n', stderr: '' });
    assert.equal((await run(['link', ID, '--json'], {})).stdout, JSON.stringify({ id: ID, url: 'https://marke.st/p/' + ID }) + '\n');
});

test('a signed link is asked of the agent tool, for as long as said', async () => {
    const tools = { markest_create_signed_link: (args) => ({ paste_id: args.paste_id, url: 'https://marke.st/p/' + args.paste_id + '?exp=1&sig=ab', expires_at: '2026-10-02T10:00:00+00:00', password_protected: true }) };
    await withSite(tools, async (site, markest) => {
        const out = await markest(['link', ID, '--signed', '--expires', '1d', '--path', 'a.md']);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, expires_in: 86400, path: 'a.md' });
        assert.equal(out.stdout, 'https://marke.st/p/' + ID + '?exp=1&sig=ab\n');
        assert.match(out.stderr, /Anyone with this link can read it until 2026-10-02 10:00 UTC, with its password\./);
        await markest(['link', ID, '--signed']);
        assert.equal(site.agent.calls.at(-1).args.expires_in, 604800, 'a week unless said');
    });
    assert.deepEqual(LINK_LIFETIMES, { '1h': 3600, '1d': 86400, '7d': 604800, '30d': 2592000, '90d': 7776000 });
    assert.match((await run(['link', ID, '--signed'], {})).stderr, /MARKEST_API_KEY/, 'a signed link needs a key');
    assert.match((await run(['link', ID, '--expires', '1d'])).stderr, /add --signed/);
    assert.match((await run(['link', ID, '--signed', '--expires', '2d'])).stderr, /--expires is one of 1h, 1d, 7d, 30d, 90d/);
});

test('collaborators are listed, added and removed by address', async () => {
    const answer = (args) => ({ paste_id: args.paste_id, collaborators: args.emails ? args.emails.map((email) => ({ email, added_at: '2026-10-01T09:00:00+00:00' })) : [] });
    await withSite({ markest_list_collaborators: answer, markest_add_collaborators: answer, markest_remove_collaborators: () => ({ collaborators: [] }) }, async (site, markest) => {
        assert.equal((await markest(['collaborators', ID])).stdout, 'No collaborators.\n');
        assert.deepEqual(site.agent.calls.at(-1), { name: 'markest_list_collaborators', args: { paste_id: ID } }, 'a list names no one');
        const added = await markest(['collaborators', ID, '--add', 'a@example.test', '--add', 'b@example.test']);
        assert.deepEqual(site.agent.calls.at(-1), { name: 'markest_add_collaborators', args: { paste_id: ID, emails: ['a@example.test', 'b@example.test'] } });
        assert.match(added.stdout, /^EMAIL +ADDED \(UTC\)\na@example\.test +2026-10-01 09:00\n/);
        await markest(['collaborators', ID, '--remove', 'a@example.test']);
        assert.deepEqual(site.agent.calls.at(-1), { name: 'markest_remove_collaborators', args: { paste_id: ID, emails: ['a@example.test'] } });
    });
    for (const argv of [['collaborators', ID, '--add', 'nobody'], ['collaborators', ID, '--add', 'a@b.c', '--remove', 'a@b.c']]) assert.equal((await run(argv)).code, 2);
});

test('fork copies artifacts in, and refuses to name several copies one title', async () => {
    await withSite({ markest_fork_paste: (args) => ({ forks: args.pastes.map((id, i) => (i === 0 ? { url: 'https://marke.st/p/' + id } : { error: 'Encrypted, so it cannot be copied.' })), count: 1 }) }, async (site, markest) => {
        const out = await markest(['fork', ID, OTHER, '--visibility', 'private', '--folder', 'copies']);
        assert.deepEqual(site.agent.calls.at(-1).args, { pastes: [ID, OTHER], visibility: 'private', folder: 'copies' });
        assert.equal(out.stdout, 'https://marke.st/p/' + ID + '\nEncrypted, so it cannot be copied.\n');
        await markest(['fork', ID, '--title', 'Mine']);
        assert.deepEqual(site.agent.calls.at(-1).args, { pastes: [ID], title: 'Mine' });
        assert.equal((await markest(['fork', ID, '--visibility', 'unlisted'])).code, 0);
        assert.deepEqual(site.agent.calls.at(-1).args, { pastes: [ID], visibility: 'unlisted' });
    });
    await withSite({ markest_fork_paste: () => ({ count: 0 }) }, async (site, markest) => {
        assert.deepEqual(await markest(['fork', ID]), { code: 0, stdout: '', stderr: '' }, 'no copies listed, nothing said');
    });
    assert.match((await run(['fork', ID, OTHER, '--title', 'One'])).stderr, /one artifact at a time/);
    assert.match((await run(['fork', ID, '--visibility', 'public'])).stderr, /unlisted or private/);
});

test('views says how often each was read, by day and document when asked', async () => {
    const result = {
        days: 7, since: '2026-09-25', until: '2026-10-01', timezone: 'UTC',
        artifacts: [{ paste_id: ID, title: 'Plan', views: 12, embed_views: 3, by_day: [{ date: '2026-10-01', views: 2, embed_views: 0 }], by_document: [{ path: 'a.md', views: 10 }] }],
    };
    await withSite({ markest_get_views: () => result }, async (site, markest) => {
        const out = await markest(['views', ID, '--days', '7', '--by-day', '--by-document']);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_ids: [ID], days: 7, by_day: true, by_document: true });
        assert.match(out.stdout, /^Views 2026-09-25 to 2026-10-01 \(UTC\)\nVIEWS +EMBEDDED +ID +TITLE\n12 +3 +[0-9A-Z]{26} +Plan\nPlan by day:\nDATE +VIEWS +EMBEDDED\n2026-10-01 +2 +0\nPlan by document:\nVIEWS +PATH\n10 +a\.md\n$/);
    });
    for (const days of ['0', '367', 'week']) assert.equal((await run(['views', ID, '--days', days])).code, 2, days);
});

test('views asks for what was said and no more, and draws only what came back', async () => {
    let result = { since: '2026-09-25', until: '2026-10-01', timezone: 'UTC', artifacts: [{ paste_id: ID, title: 'Plan', views: 12, embed_views: 3 }] };
    await withSite({ markest_get_views: () => result }, async (site, markest) => {
        const out = await markest(['views', ID, OTHER]);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_ids: [ID, OTHER] });
        assert.match(out.stdout, /^Views 2026-09-25 to 2026-10-01 \(UTC\)\nVIEWS +EMBEDDED +ID +TITLE\n12 +3 +[0-9A-Z]{26} +Plan\n$/, 'no days or documents when none came');
        for (const days of ['1', '366', '10']) {
            assert.equal((await markest(['views', ID, '--days', days])).code, 0, days);
            assert.deepEqual(site.agent.calls.at(-1).args, { paste_ids: [ID], days: Number(days) });
        }
        result = { since: '2026-09-25', until: '2026-10-01', timezone: 'UTC' };
        assert.deepEqual(await markest(['views', ID]), { code: 0, stdout: 'Views 2026-09-25 to 2026-10-01 (UTC)\nVIEWS  EMBEDDED  ID  TITLE\n', stderr: '' });
    });
});

test('preview says which picture it shows, or pins one', async () => {
    await withSite({ markest_get_preview: () => ({ mode: 'auto', image: null }), markest_set_preview: (args) => ({ mode: 'pinned', image: { id: args.image_id, name: 'chart.png', url: '/img/x/y' } }) }, async (site, markest) => {
        assert.equal((await markest(['preview', ID])).stdout, 'Preview: auto\n');
        assert.equal((await markest(['preview', ID, '--image', OTHER, '--mode', 'pinned'])).stdout, 'Preview: pinned, chart.png /img/x/y\n');
        assert.deepEqual(site.agent.calls.at(-1), { name: 'markest_set_preview', args: { paste_id: ID, image_id: OTHER, mode: 'pinned' } });
        assert.deepEqual(site.agent.calls.at(-2), { name: 'markest_get_preview', args: { paste_id: ID } });
    });
    assert.equal((await run(['preview', ID, '--mode', 'big'])).code, 2);
});

test('an image alone or a mode alone sets the picture', async () => {
    const tools = { markest_get_preview: () => ({ mode: 'auto', image: null }), markest_set_preview: (args) => ({ mode: args.mode ?? 'pinned', image: null }) };
    await withSite(tools, async (site, markest) => {
        for (const [flags, args, said] of [
            [['--image', OTHER], { paste_id: ID, image_id: OTHER }, 'pinned'],
            [['--mode', 'auto'], { paste_id: ID, mode: 'auto' }, 'auto'],
            [['--mode', 'off'], { paste_id: ID, mode: 'off' }, 'off'],
        ]) {
            assert.deepEqual(await markest(['preview', ID, ...flags]), { code: 0, stdout: 'Preview: ' + said + '\n', stderr: '' }, flags.join(' '));
            assert.deepEqual(site.agent.calls.at(-1), { name: 'markest_set_preview', args }, flags.join(' '));
        }
    });
});

test('a usage error says what is wrong in the command\'s own words, before a key is asked for', async () => {
    const cases = [
        [['link'], 'Name the artifact: markest link <artifact>'],
        [['fork'], 'Name the artifact: markest fork <artifact>...'],
        [['fork', ...Array(11).fill(ID)], 'Too many arguments: markest fork <artifact>...'],
        [['fork', ID, '--visibility', 'public'], '--visibility is unlisted or private'],
        [['views'], 'Name the artifact: markest views <artifact>...'],
        [['views', ...Array(51).fill(ID)], 'Too many arguments: markest views <artifact>...'],
        ...['0', '367', '1000', 'week', 'x7', '7x'].map((days) => [['views', ID, '--days', days], '--days is 1 to 366']),
        [['preview'], 'Name the artifact: markest preview <artifact>'],
        [['preview', ID, '--mode', 'big'], '--mode is auto, pinned or off'],
        ...['nobody', 'a b@example.test', 'a@example.test b', 'a@b@example.test'].map((email) => [['collaborators', ID, '--add', email], '"' + email + '" is not an email address']),
        [['collaborators', ID, '--remove', '@example.test'], '"@example.test" is not an email address'],
        [['collaborators'], 'Name the artifact: markest collaborators <artifact>'],
    ];
    for (const [argv, said] of cases) {
        assert.deepEqual(await run(argv, {}), { code: 2, stdout: '', stderr: 'markest: ' + said + '\nRun markest --help for the commands.\n' }, argv.slice(0, 4).join(' '));
    }
});

test('what the agent tools answer needs a key, and nothing is asked without one', async () => {
    await withSite({}, async (site) => {
        for (const argv of [['collaborators', ID], ['fork', ID], ['views', ID], ['preview', ID]]) {
            assert.deepEqual(await run([...argv, '--url', site.url], {}), { code: 2, stdout: '', stderr: 'markest: Sign in with markest login, or set MARKEST_API_KEY to an API key from your account settings.\nRun markest --help for the commands.\n' }, argv[0]);
        }
        assert.equal(site.requests.length, 0);
    });
});

test('only what reads is asked again after a lost connection, so no change is made twice', async () => {
    const tools = {
        markest_list_collaborators: () => ({ collaborators: [] }),
        markest_add_collaborators: () => ({ collaborators: [] }),
        markest_remove_collaborators: () => ({ collaborators: [] }),
        markest_fork_paste: () => ({ forks: [] }),
        markest_get_views: () => ({ since: 'a', until: 'b', timezone: 'UTC', artifacts: [] }),
        markest_get_preview: () => ({ mode: 'off', image: null }),
        markest_set_preview: () => ({ mode: 'off', image: null }),
    };
    await withSite(tools, async (site, markest) => {
        for (const [argv, tool, reads] of [
            [['collaborators', ID], 'markest_list_collaborators', true],
            [['views', ID], 'markest_get_views', true],
            [['preview', ID], 'markest_get_preview', true],
            [['collaborators', ID, '--add', 'a@example.test'], 'markest_add_collaborators', false],
            [['collaborators', ID, '--remove', 'a@example.test'], 'markest_remove_collaborators', false],
            [['fork', ID], 'markest_fork_paste', false],
            [['preview', ID, '--mode', 'off'], 'markest_set_preview', false],
        ]) {
            site.answerOnce((one) => one.path === '/mcp', (req) => { req.socket.destroy(); });
            const out = await markest(argv);
            const made = site.agent.calls.filter((one) => one.name === tool).length;
            if (reads) {
                assert.equal(out.code, 0, tool + ': ' + out.stderr);
                assert.equal(made, 1, tool);
            } else {
                assert.equal(out.code, 1, tool);
                assert.match(out.stderr, /^markest: The connection to the site was lost: /, tool);
                assert.equal(made, 0, tool + ' is never sent twice');
            }
        }
    });
});

test('a signed link asks for no document unless one is named, and says nothing of a password it has none of', async () => {
    const tools = { markest_create_signed_link: (args) => ({ paste_id: args.paste_id, url: 'https://marke.st/p/' + args.paste_id + '?exp=1&sig=ab', expires_at: '2026-10-02T10:00:00+00:00', password_protected: false }) };
    await withSite(tools, async (site, markest) => {
        const out = await markest(['link', ID, '--signed']);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, expires_in: 604800 });
        assert.equal(out.stderr, 'Anyone with this link can read it until 2026-10-02 10:00 UTC.\n');
    });
});

test('collaborators with a longer address are added, an answer that lists no one is no one, and each command using the agent tools says so', async () => {
    const tools = { markest_add_collaborators: (args) => ({ collaborators: args.emails.map((email) => ({ email, added_at: '2026-10-01T09:00:00+00:00' })) }), markest_list_collaborators: () => ({}) };
    await withSite(tools, async (site, markest) => {
        const added = await markest(['collaborators', ID, '--add', 'someone.else@example.test']);
        assert.equal(added.code, 0, added.stderr);
        assert.deepEqual(site.agent.calls.at(-1).args, { paste_id: ID, emails: ['someone.else@example.test'] });
        assert.equal((await markest(['collaborators', ID])).stdout, 'No collaborators.\n');
    });
    for (const name of ['collaborators', 'fork', 'views', 'preview']) {
        assert.ok((await run(['help', name])).stdout.includes('Uses the site\'s agent tools: your plan must include agent (MCP) access.'), name);
    }
});
