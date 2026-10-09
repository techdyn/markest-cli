/**
 * Regression test: found by the live check of 2026-10-02 -
 * signed in with `markest login`, `markest publish` sent no credential at all
 * ("Missing API key"), because it built its own client from the API key alone
 * while every other command took the run's sign-in through clientsFor. A
 * signed-in run's every request carries its sign-in, a sealed publish's too,
 * and keeps the artifact's key in the run's own vault.
 *
 * Its first run, against the code before the fix, kept a test key in the
 * account holder's real settings folder: the command ignored the vault it
 * was handed and opened the default one, and the test had handed it an
 * empty environment. A test that runs a command hands it a folder of its
 * own as well (homeEnv), so code that ignores the vault still stays there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMarkest } from '../support/fake-markest.mjs';
import { freshHome, homeEnv, makeFolder, testKeyring, testVault } from '../support/cli-harness.mjs';
import { COMMANDS } from '../../src/commands/registry.mjs';

/** A sign-in as a run holds one (cli/auth/credential). */
const signIn = { kind: 'oauth', source: 'sign-in', present: true, scope: 'pastes.read pastes.write', bearer: async () => 'eyJsigned.in.token', renew: async () => true, secrets: () => ['eyJsigned.in.token'] };

async function publish(site, argv) {
    const home = await freshHome();
    const command = COMMANDS.get('publish');
    const flags = (await import('../../src/core/site-args.mjs')).readFlags(argv, command.flags);
    const asked = command.parse(flags.values, flags.positionals, {});
    let stdout = '';
    const code = await command.run({
        ...asked, key: '', auth: signIn, vault: testVault(home), baseUrl: site.url, env: homeEnv(home), version: '0',
        stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} },
    });
    return { code, stdout, home };
}

test('a signed-in publish carries the sign-in on every request', async () => {
    const site = await startFakeMarkest();
    try {
        const folder = await makeFolder({ 'README.md': '# Signed in\n' });
        const { code } = await publish(site, [folder]);
        assert.equal(code, 0);
        assert.ok(site.requests.length > 0);
        for (const request of site.requests) assert.equal(request.headers.authorization, 'Bearer eyJsigned.in.token', request.method + ' ' + request.path);
    } finally {
        await site.close();
    }
});

test('a signed-in sealed publish carries the sign-in, and keeps the key in the run\'s own vault', async () => {
    const site = await startFakeMarkest();
    try {
        const folder = await makeFolder({ 'plan.md': '# Plan\n' });
        const { code, stdout, home } = await publish(site, [folder, '--sealed']);
        assert.equal(code, 0);
        for (const request of site.requests) assert.equal(request.headers.authorization, 'Bearer eyJsigned.in.token');
        const id = [...site.pastes.keys()][0];
        assert.ok(stdout.includes('#key=' + await testKeyring(home).get(site.url, id)), 'the key the link carries, kept in this run\'s vault');
    } finally {
        await site.close();
    }
});
