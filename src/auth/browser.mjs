/**
 * @module cli/auth/browser
 * @description Whether a browser can be opened from here, and opening one at an
 *              address. Not over SSH - the browser would open on the other
 *              machine, or nowhere - and not on a Linux with no display; there,
 *              signing in uses a code instead (D-20261002-02). The browser is
 *              opened by the system's own handler, never through a shell, so an
 *              address's `&` is not read as anything.
 *
 * @input The environment and the platform; an address
 * @output Whether one can be opened; whether it was
 * @dependencies node:child_process, node:path
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** Whether this session can open a browser for its person to see. */
export function canOpenBrowser(env = {}, platform = process.platform) {
    if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
    if (platform === 'win32' || platform === 'darwin') return true;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** The program and its arguments that open an address on this system. */
export function opener(url, env = {}, platform = process.platform) {
    if (platform === 'win32') return [join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]];
    if (platform === 'darwin') return ['/usr/bin/open', [url]];
    return ['xdg-open', [url]];
}

/** Opens the address; whether the opener could be started at all. */
export function openBrowser(url, { env = {}, platform = process.platform, start = spawn } = {}) {
    const [command, args] = opener(url, env, platform);
    return new Promise((resolve) => {
        let child;
        try {
            child = start(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
        } catch {
            resolve(false);
            return;
        }
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
            child.unref();
            resolve(true);
        });
    });
}
