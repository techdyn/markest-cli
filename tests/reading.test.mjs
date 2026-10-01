/**
 * `markest read` and `markest pull` against the fake site (cli/commands/reading):
 * the document chosen as the viewer would choose it, with a key or as a browser,
 * printed exactly, and a whole artifact written into a folder only when every
 * path is safe.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeMarkest } from './support/fake-markest.mjs';
import { against, makeFolder, run } from './support/cli-harness.mjs';

async function withSite(body) {
    const site = await startFakeMarkest();
    try {
        await body(site, against(site));
    } finally {
        await site.close();
    }
}

const sample = (site) => site.addPaste({ title: 'T', defaultPath: 'b.md', documents: [{ path: 'a.md', content: 'A text\n' }, { path: 'docs/b.md', content: 'no' }, { path: 'b.md', content: 'B text, no newline' }] });

test('read prints the document it opens on, exactly; a path or the address names another', async () => {
    await withSite(async (site, markest) => {
        const paste = sample(site);
        assert.deepEqual(await markest(['read', paste.id]), { code: 0, stdout: 'B text, no newline', stderr: '' });
        assert.equal((await markest(['read', paste.id, 'a.md'])).stdout, 'A text\n');
        assert.equal((await markest(['read', 'https://marke.st/p/' + paste.id + '/docs/b.md'])).stdout, 'no');
        assert.equal((await markest(['read', 'https://marke.st/p/' + paste.id + '/docs/b.md', 'a.md'])).stdout, 'A text\n', 'a path named wins');
        const json = JSON.parse((await markest(['read', paste.id, 'a.md', '--json'])).stdout);
        assert.deepEqual(json, { id: paste.id, path: 'a.md', content_type: 'markdown', content: 'A text\n', encrypted: false });
        const missing = await markest(['read', paste.id, 'z.md']);
        assert.equal(missing.code, 1);
        assert.match(missing.stderr, /There is no document "z\.md" in it\. It holds: a\.md, docs\/b\.md, b\.md/);
        await markest(['read', paste.id, '--format', 'markdown']);
        assert.deepEqual(site.requests.at(-1).query, { format: 'markdown' });
    });
});

test('without a key it reads as a browser would, and markdown asks for one', async () => {
    await withSite(async (site) => {
        const paste = sample(site);
        const out = await run(['read', paste.id, '--url', site.url], {});
        assert.equal(out.stdout, 'B text, no newline');
        assert.deepEqual(site.requests.map((one) => one.path), ['/api/p/' + paste.id + '/manifest', '/api/p/' + paste.id + '/doc']);
        assert.ok(site.requests.every((one) => !one.headers.authorization));
        const markdown = await run(['read', paste.id, '--format', 'markdown', '--url', site.url], {});
        assert.equal(markdown.code, 2);
        assert.match(markdown.stderr, /needs MARKEST_API_KEY/);
    });
});

test('read refuses what it cannot ask', async () => {
    for (const [argv, said] of [[['read'], /Name the artifact/], [['read', 'x'], /not an artifact/], [['read', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'a', 'b'], /One document/],
        [['read', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--format', 'pdf'], /--format/]]) {
        const out = await run(argv);
        assert.equal(out.code, 2);
        assert.match(out.stderr, said);
    }
});

test('pull writes every document at its path and lists them; nothing already there is replaced unless forced', async () => {
    await withSite(async (site, markest) => {
        const paste = sample(site);
        const folder = await makeFolder({});
        const out = await markest(['pull', paste.id, folder]);
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, 'a.md\ndocs/b.md\nb.md\n');
        assert.match(out.stderr, /Wrote 3 documents to /);
        assert.equal(await readFile(join(folder, 'docs', 'b.md'), 'utf8'), 'no');

        await writeFile(join(folder, 'a.md'), 'mine');
        const again = await markest(['pull', paste.id, folder]);
        assert.equal(again.code, 1);
        assert.match(again.stderr, /Nothing was written: a\.md \(exists\), docs\/b\.md \(exists\), b\.md \(exists\)\. --force replaces files already there\./);
        assert.equal(await readFile(join(folder, 'a.md'), 'utf8'), 'mine');
        const json = await markest(['pull', paste.id, folder, '--json']);
        assert.deepEqual(JSON.parse(json.stdout.trim().split('\n').at(-1)).refused.map((one) => one.reason), ['exists', 'exists', 'exists']);

        const forced = JSON.parse((await markest(['pull', paste.id, folder, '--force', '--json'])).stdout);
        assert.deepEqual(forced, { id: paste.id, folder, written: ['a.md', 'docs/b.md', 'b.md'], encrypted: false });
        assert.equal(await readFile(join(folder, 'a.md'), 'utf8'), 'A text\n');
    });
});

test('pull refuses a path from the site that would land outside the folder, and writes nothing', async () => {
    await withSite(async (site, markest) => {
        const paste = site.addPaste({ documents: [{ path: 'fine.md', content: 'x' }, { path: '../outside.md', content: 'x' }] });
        const folder = await makeFolder({});
        const out = await markest(['pull', paste.id, folder]);
        assert.equal(out.code, 1);
        assert.match(out.stderr, /Nothing was written: \.\.\/outside\.md \(traversal\)\.$/m);
        assert.equal(out.stdout, '');
    });
    for (const argv of [['pull'], ['pull', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], ['pull', 'x', 'folder'], ['pull', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'a', 'b']]) {
        assert.equal((await run(argv)).code, 2, argv.join(' '));
    }
});

test('read and pull say what they need when asked wrongly, in their own words', async () => {
    assert.equal((await run(['read'])).stderr, 'markest: Name the artifact: markest read <artifact> [<path>]\nRun markest --help for the commands.\n');
    assert.equal((await run(['pull', 'nope', 'folder'])).stderr, 'markest: "nope" is not an artifact\'s id or address\nRun markest --help for the commands.\n');
    assert.equal((await run(['pull'])).stderr, 'markest: Name the artifact and the folder: markest pull <artifact> <folder>\nRun markest --help for the commands.\n');
});

test('pull needs no key for what a browser could read, and says exactly what it wrote; as JSON, one object either way', async () => {
    await withSite(async (site) => {
        const paste = site.addPaste({ documents: [{ path: 'a.md', content: 'A' }] });
        const folder = await makeFolder({});
        const out = await run(['pull', paste.id, folder, '--url', site.url], {});
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stderr, 'Wrote 1 documents to ' + folder + '\n');
        const json = await run(['pull', paste.id, await makeFolder({}), '--json', '--url', site.url], {});
        assert.equal(json.stdout.trim().split('\n').length, 1, 'one line, no list of refusals beside it');
        const missing = await run(['pull', '01ARZ3NDEKTSV4RRFFQ69G5FAV', await makeFolder({}), '--json', '--url', site.url], {});
        assert.equal(missing.code, 1);
        assert.deepEqual(missing.stdout.trim().split('\n').map((line) => Object.keys(JSON.parse(line))), [['error', 'status']], 'the refusal alone');
    });
});

test('a refusal of several kinds still says --force when a file is already there', async () => {
    await withSite(async (site, markest) => {
        const paste = site.addPaste({ documents: [{ path: 'a.md', content: 'A' }, { path: '../out.md', content: 'x' }] });
        const folder = await makeFolder({ 'a.md': 'mine' });
        const out = await markest(['pull', paste.id, folder]);
        assert.match(out.stderr, /Nothing was written: a\.md \(exists\), \.\.\/out\.md \(traversal\)\. --force replaces files already there\./);
    });
});
