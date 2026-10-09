/**
 * @module cli/tests/support/cli-harness
 * @description Folders on disk and runs of the tool for its tests: a temporary
 *              folder made from a map of paths to contents, and `main` run with
 *              its output captured and, when given, text piped to its stdin.
 *
 * @input `{ path: content }`; argv; the environment; stdin's text
 * @output The folder's path; `{ code, stdout, stderr }`
 * @dependencies node:fs/promises, node:os, node:path, node:stream, node:module, node:child_process, cli/src/main, cli/src/store/vault,
 *               cli/src/sealed/keyring
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * No test ever starts the system's browser opener. On 2026-10-02 a mutant of
 * login sent a run made with no browser of its own down the browser's path,
 * and the account holder's Chrome opened marke.st. Every module's `spawn` is
 * this one from here on (the builtin's live binding, synced), and it refuses
 * rundll32, open and xdg-open whatever a test or a mutant hands it.
 */
const childProcess = createRequire(import.meta.url)('node:child_process');
const realSpawn = childProcess.spawn;
const OPENER = /(^|[\\/])(rundll32(\.exe)?|open|xdg-open)$/i;
childProcess.spawn = function spawnNoBrowser(command, ...rest) {
    if (OPENER.test(String(command))) throw new Error('A test tried to open a browser with ' + command + '.');
    return realSpawn.call(this, command, ...rest);
};
syncBuiltinESMExports();
import { main } from '../../src/main.mjs';
import { vaultFor } from '../../src/store/vault.mjs';
import { openKeyring } from '../../src/sealed/keyring.mjs';

export const KEY = 'mk_live_' + 'ab12'.repeat(12);

/**
 * A settings folder of the tests' own, and the plain file for its vault's key:
 * no run reads or writes the account's real folder, Keychain, DPAPI file or
 * keyring.
 */
export const TEST_HOME = join(tmpdir(), 'markest-cli-test-home-' + process.pid);

/**
 * What every test run's environment starts from. SystemRoot points nowhere, so
 * even a run that reached for Windows' own browser opener or PowerShell could
 * start neither.
 */
export const TEST_ENV = Object.freeze({ MARKEST_HOME: TEST_HOME, MARKEST_SECRET_STORE: 'file', SystemRoot: join(tmpdir(), 'markest-no-system-root') });

/** A fresh settings folder, empty, for a test that looks at what was kept. */
export async function freshHome() {
    return mkdtemp(join(tmpdir(), 'markest-home-'));
}

/** The environment of a run that keeps its files in a folder of its own. */
export const homeEnv = (home, more = {}) => ({ MARKEST_HOME: home, MARKEST_SECRET_STORE: 'file', ...more });

/** The vault and the key store of a settings folder, as a run there would open them. */
export const testVault = (home) => vaultFor({ env: homeEnv(home) });
export const testKeyring = (home) => openKeyring({ vault: testVault(home) });

export async function makeFolder(files) {
    const root = await mkdtemp(join(tmpdir(), 'markest-cli-'));
    for (const [path, content] of Object.entries(files)) {
        const onDisk = join(root, ...path.split('/'));
        await mkdir(dirname(onDisk), { recursive: true });
        await writeFile(onDisk, content);
    }
    return root;
}

export async function run(argv, env = { MARKEST_API_KEY: KEY }, { stdin = null, browser, sleep } = {}) {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, {
        env: { ...TEST_ENV, ...env },
        stdout: { write: (text) => { stdout += text; } },
        stderr: { write: (text) => { stderr += text; } },
        stdin: stdin === null ? Readable.from([]) : Readable.from([Buffer.from(stdin)]),
        // Never the real browser: a test that signs in hands in its own
        browser: browser ?? (async () => { throw new Error('A test opened a browser.'); }),
        sleep,
    });
    return { code, stdout, stderr };
}

/** A run against a site: the key set and `--url` given. */
export function against(site) {
    return (argv, options = {}) => run([...argv, '--url', site.url], options.env ?? { MARKEST_API_KEY: KEY }, options);
}
