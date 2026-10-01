/**
 * @module cli/tests/support/cli-harness
 * @description Folders on disk and runs of the tool for its tests: a temporary
 *              folder made from a map of paths to contents, and `main` run with
 *              its output captured and, when given, text piped to its stdin.
 *
 * @input `{ path: content }`; argv; the environment; stdin's text
 * @output The folder's path; `{ code, stdout, stderr }`
 * @dependencies node:fs/promises, node:os, node:path, node:stream, cli/src/main
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { main } from '../../src/main.mjs';

export const KEY = 'mk_live_' + 'ab12'.repeat(12);

/** A key store of the tests' own, so no run reads or writes the real one. */
export const TEST_KEYRING = join(tmpdir(), 'markest-cli-test-keys-' + process.pid + '.json');

/** A fresh key store, empty, for a test that looks at what was kept. */
export async function freshKeyring() {
    const dir = await mkdtemp(join(tmpdir(), 'markest-keys-'));
    return join(dir, 'keys.json');
}

export async function makeFolder(files) {
    const root = await mkdtemp(join(tmpdir(), 'markest-cli-'));
    for (const [path, content] of Object.entries(files)) {
        const onDisk = join(root, ...path.split('/'));
        await mkdir(dirname(onDisk), { recursive: true });
        await writeFile(onDisk, content);
    }
    return root;
}

export async function run(argv, env = { MARKEST_API_KEY: KEY }, { stdin = null } = {}) {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, {
        env: { MARKEST_KEYRING: TEST_KEYRING, ...env },
        stdout: { write: (text) => { stdout += text; } },
        stderr: { write: (text) => { stderr += text; } },
        stdin: stdin === null ? Readable.from([]) : Readable.from([Buffer.from(stdin)]),
    });
    return { code, stdout, stderr };
}

/** A run against a site: the key set and `--url` given. */
export function against(site) {
    return (argv, options = {}) => run([...argv, '--url', site.url], options.env ?? { MARKEST_API_KEY: KEY }, options);
}
