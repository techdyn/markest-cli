/**
 * Regression (2026-10-01): mutation runs wrote 33 test keys into the account
 * holder's own key store (%APPDATA%\markest\keys.json). A mutant that drops what
 * a test hands a command - `keyringFor({})` for `keyringFor({ env })` - sends
 * the command to the profile's default place. A mutant's tests must run with a
 * home of their own, and with none of the account holder's key, site or store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandboxEnv } from '../../scripts/mutate.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('the sandbox points every profile folder into the run\'s own home and hands down no Markest setting', () => {
    const home = join(tmpdir(), 'mutation-home');
    const env = sandboxEnv({ PATH: '/bin', USERPROFILE: 'C:\\Users\\someone', MARKEST_API_KEY: 'mk_live_x', MARKEST_KEY: 'k', MARKEST_URL: 'https://marke.st', MARKEST_KEYRING: '/real/keys.json', markest_url: 'x' }, home);
    assert.equal(env.PATH, '/bin', 'the rest is kept');
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) assert.ok(env[name] === home || env[name].startsWith(home + sep), name + ' ' + env[name]);
    assert.deepEqual(Object.keys(env).filter((name) => name.toUpperCase().startsWith('MARKEST_')), []);
});

test('a command that lost its environment keeps its keys inside the sandbox', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mutation-home-'));
    const keyring = pathToFileURL(join(ROOT, 'src', 'sealed', 'keyring.mjs')).href;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', 'const { keyringFor } = await import(' + JSON.stringify(keyring) + '); process.stdout.write(keyringFor({}).path);'], { env: sandboxEnv(process.env, home), encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(probe.stdout.startsWith(home + sep), probe.stdout);
});

test('every group\'s Stryker run is started in the sandbox', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'mutate.mjs'), 'utf8');
    assert.match(source, /spawnSync\(process\.execPath, \[STRYKER, 'run', file\], \{[^}]*env: sandboxEnv\(process\.env, home\)/);
});
