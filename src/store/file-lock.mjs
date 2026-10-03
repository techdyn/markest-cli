/**
 * @module cli/store/file-lock
 * @description One command at a time: a lock file made only if none is there,
 *              held for the work and removed after it, so two commands never
 *              refresh one sign-in at once - the second waits, then finds the
 *              first's tokens. A lock left by a command that died is taken
 *              after a while; one held too long is said, not waited on forever.
 *
 * @input The lock's path; the work; how long to wait and when a lock is stale
 * @output The work's result
 * @dependencies node:fs/promises, node:path
 */

import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withLock(path, work, { waitMs = 15000, staleMs = 30000, sleep = pause, now = Date.now } = {}) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const started = now();
    for (;;) {
        try {
            const handle = await open(path, 'wx', 0o600);
            await handle.write(String(process.pid));
            await handle.close();
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const held = await stat(path).catch(() => null);
            if (held !== null && now() - held.mtimeMs > staleMs) {
                await rm(path, { force: true });
                continue;
            }
            if (now() - started > waitMs) throw new Error('Another markest command is holding ' + path + '; try again in a moment.');
            await sleep(100);
        }
    }
    try {
        return await work();
    } finally {
        await rm(path, { force: true });
    }
}
