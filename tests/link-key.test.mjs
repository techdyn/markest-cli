/**
 * A link given the key this machine keeps for its artifact (cli/sealed/link-key),
 * in place of any fragment, and through `markest link`; one with no key kept is
 * the link as it was.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withKnownKey } from '../src/sealed/link-key.mjs';
import { freshHome, run, homeEnv, testKeyring } from './support/cli-harness.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const KEY_TEXT = 'K'.repeat(42) + 'w';
const SITE = 'https://marke.st';

test('a link is given the key kept for its artifact, in place of any fragment; else it is as it was', async () => {
    const path = await freshHome();
    const ctx = { baseUrl: SITE, env: homeEnv(path) };
    assert.equal(await withKnownKey(SITE + '/p/' + ID, ID, ctx), SITE + '/p/' + ID);
    await testKeyring(path).remember(SITE, ID, KEY_TEXT, 'Plan');
    assert.equal(await withKnownKey(SITE + '/p/' + ID + '/a.md#old', ID, ctx), SITE + '/p/' + ID + '/a.md#key=' + KEY_TEXT);
    assert.equal(await withKnownKey(SITE + '/p/' + ID, ID, { ...ctx, baseUrl: 'http://localhost:8002' }), SITE + '/p/' + ID, 'kept for another site');

    const out = await run(['link', ID, '--path', 'a.md', '--url', SITE], { MARKEST_HOME: path });
    assert.equal(out.stdout, SITE + '/p/' + ID + '/a.md#key=' + KEY_TEXT + '\n', 'markest link shares it, key and all');
});
