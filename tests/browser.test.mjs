/**
 * REGRESSION ANCHOR (D-20261002-02): whether a browser can be opened from here
 * (cli/auth/browser) - never over SSH, never on a Linux with no display - and
 * opening one through the system's own handler, never a shell.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import './support/cli-harness.mjs';
import { canOpenBrowser, openBrowser, opener } from '../src/auth/browser.mjs';

test('a browser opens on a desktop, never over SSH or on a Linux with no display', () => {
    assert.equal(canOpenBrowser({}, 'win32'), true);
    assert.equal(canOpenBrowser({}, 'darwin'), true);
    assert.equal(canOpenBrowser({}, 'linux'), false);
    assert.equal(canOpenBrowser({ DISPLAY: ':0' }, 'linux'), true);
    assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
    for (const ssh of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
        assert.equal(canOpenBrowser({ [ssh]: 'x', DISPLAY: ':0' }, 'linux'), false, ssh);
        assert.equal(canOpenBrowser({ [ssh]: 'x' }, 'darwin'), false, ssh);
    }
});

test('each system\'s own handler opens the address, which stands whole as one argument', () => {
    const url = 'https://marke.st/oauth/authorize?a=1&b=2';
    assert.deepEqual(opener(url, { SystemRoot: 'D:\\Win' }, 'win32'), [join('D:\\Win', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]]);
    assert.deepEqual(opener(url, {}, 'win32')[0], join('C:\\Windows', 'System32', 'rundll32.exe'));
    assert.deepEqual(opener(url, {}, 'darwin'), ['/usr/bin/open', [url]]);
    assert.deepEqual(opener(url, {}, 'linux'), ['xdg-open', [url]]);
});

function child(event) {
    const one = new EventEmitter();
    one.unref = () => { one.unrefed = true; };
    setImmediate(() => (event === 'error' ? one.emit('error', new Error('ENOENT')) : one.emit('spawn')));
    return one;
}

test('the browser is started detached, with no shell, and whether it started is said', async () => {
    const calls = [];
    let started;
    const ok = await openBrowser('https://x', { platform: 'darwin', start: (command, args, options) => { calls.push({ command, args, options }); started = child('spawn'); return started; } });
    assert.equal(ok, true);
    assert.deepEqual(calls[0].options, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
    assert.equal(started.unrefed, true, 'the command does not wait for the browser');
    assert.equal(await openBrowser('https://x', { platform: 'linux', start: () => child('error') }), false);
    assert.equal(await openBrowser('https://x', { platform: 'linux', start: () => { throw new Error('no'); } }), false);
});

test('no test can start the system\'s browser opener, whatever it is handed (the harness, D-20261002-04)', async () => {
    const { spawn } = await import('node:child_process');
    // A path that is not on this machine, so a guard that failed would only fail this test
    assert.throws(() => spawn('/usr/bin/open', ['https://example.invalid']), /A test tried to open a browser with \/usr\/bin\/open\./);
    assert.throws(() => spawn(String.raw`C:\nowhere\System32\rundll32.exe`, []), /A test tried to open a browser/);
    for (const command of ['open', 'xdg-open', 'rundll32', 'RUNDLL32.EXE', '/usr/bin/xdg-open']) {
        assert.throws(() => spawn(command, []), /A test tried to open a browser/);
    }
    assert.equal(await openBrowser('https://example.invalid', { platform: 'darwin' }), false, 'the real opener, refused, says it could not');
});
