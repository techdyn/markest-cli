/**
 * REGRESSION ANCHOR (D-20261002-04): signing in from the command line
 * (cli/commands/auth) - in the browser with the code handed back to a port
 * here, or with a code typed at the site where no browser opens; an API key
 * kept instead only once the site takes it; nothing kept where no secure store
 * can be used unless --insecure-storage chose a plain file; runs using the
 * sign-in first, then a key; signing out ending the sign-in on the site; and
 * status naming the credential and its store, never showing it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFakeOAuth } from './support/fake-oauth.mjs';
import { freshHome, homeEnv, run, TEST_ENV, testVault } from './support/cli-harness.mjs';
import { allowed } from '../src/commands/auth.mjs';
import { openSignIns } from '../src/auth/sign-in-store.mjs';

const KEY = 'mk_live_' + 'cd34'.repeat(12);
// A display, so the browser is chosen on any system the tests run on
const DESKTOP = { DISPLAY: ':0' };

async function withSite(body, options = {}) {
    const site = await startFakeOAuth({ keys: [KEY], ...options });
    try {
        await body(site);
    } finally {
        await site.close();
    }
}

const kept = async (home, site) => openSignIns({ vault: testVault(home) }).get(site.url);

test('what a sign-in allows is said in words', () => {
    assert.equal(allowed('pastes.read pastes.write'), 'read and write');
    assert.equal(allowed('pastes.read'), 'read');
    assert.equal(allowed('pastes.write'), 'write');
    assert.equal(allowed(''), 'nothing');
    assert.equal(allowed(null), 'nothing');
});

test('login signs in in the browser, asks for both places and both scopes, and keeps the sign-in sealed', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        const out = await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, 'Signed in to ' + site.url + ': read and write. Kept in ' + 'a file only your account can read (' + join(home, 'vault-key') + '), not a secure store.\n');
        assert.match(out.stderr, /^Opening your browser to sign in to http:\/\/127\.0\.0\.1:\d+\.\nIf it does not open, go to:\n\n {2}http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/);

        const asked = site.requests.find((one) => one.path === '/oauth/authorize').query;
        assert.equal(asked.get('client_id'), site.url + '/.well-known/oauth-client-metadata/markest-cli.json');
        assert.deepEqual(asked.getAll('resource'), [site.url + '/mcp', site.url + '/api/v1']);
        assert.equal(asked.get('scope'), 'pastes.read pastes.write');
        assert.equal(asked.get('code_challenge_method'), 'S256');
        assert.match(asked.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

        const record = await kept(home, site);
        assert.match(record.oauth.access_token, /^eyJ/);
        assert.ok(record.oauth.refresh_token);
        assert.ok(record.oauth.expires_at > Date.now() + 3000000);
        for (const name of await readdir(home)) {
            const text = await readFile(join(home, name), 'utf8');
            assert.ok(!text.includes(record.oauth.refresh_token) && !text.includes(record.oauth.access_token), name + ' holds no token in the clear');
        }
        assert.ok(!(out.stdout + out.stderr).includes(record.oauth.access_token));

        const used = await run(['list', '--url', site.url], homeEnv(home));
        assert.equal(used.code, 0, used.stderr);
        assert.equal(site.requests.at(-1).headers.authorization, 'Bearer ' + record.oauth.access_token, 'the next run uses the sign-in');
    });
});

test('login --json says how it signed in, and what it may do', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        const out = await run(['login', '--url', site.url, '--json'], homeEnv(home, DESKTOP), { browser: site.browser });
        assert.deepEqual(JSON.parse(out.stdout), { site: site.url, signed_in: true, method: 'oauth', via: 'browser', scope: 'pastes.read pastes.write', kept_in: 'a file only your account can read (' + join(home, 'vault-key') + '), not a secure store' });
    });
});

test('a sign-in cancelled in the browser is said, and nothing is kept', async () => {
    await withSite(async (site) => {
        site.state.consent = 'deny';
        const home = await freshHome();
        const out = await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        assert.equal(out.code, 1);
        assert.match(out.stderr, /markest: The sign-in was cancelled in the browser\./);
        assert.equal(await kept(home, site), null);
    });
});

test('where no browser opens, login shows a code to type at the site and waits for it', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        let asks = 0;
        const sleep = async () => {
            asks++;
            if (asks === 3) site.allowDevice();
        };
        const out = await run(['login', '--url', site.url], homeEnv(home, { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }), { sleep });
        assert.equal(out.code, 0, out.stderr);
        assert.match(out.stderr, new RegExp('open this page on any device:\\n\\n {2}' + site.url.replace(/\./g, '\\.') + '/oauth/device\\n\\nand enter the code\\n\\n {2}BCDF-GHJK\\n\\nIt expires in 10 minutes\\. Enter it only at '));
        assert.match(out.stdout, /^Signed in to .*: read and write\./);
        assert.deepEqual(site.requests.find((one) => one.path === '/oauth/device_authorization').form.getAll('resource'), [site.url + '/mcp', site.url + '/api/v1']);
        assert.equal(site.requests.filter((one) => one.form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code').length, 3, 'pending, slower, then its tokens');
        assert.ok((await kept(home, site)).oauth.refresh_token);
    });
});

test('login --device uses a code wherever it runs, and a code cancelled at the site is said', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        const out = await run(['login', '--device', '--url', site.url, '--json'], homeEnv(home, DESKTOP), { sleep: async () => site.denyDevice() });
        assert.equal(out.code, 1);
        assert.equal(JSON.parse(out.stdout).error, 'The sign-in was cancelled.');
        assert.equal(await kept(home, site), null);
    });
});

test('login --with-key keeps a key the site takes, read from stdin, and refuses one it does not', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        const out = await run(['login', '--with-key', '--url', site.url], homeEnv(home), { stdin: KEY + '\n' });
        assert.equal(out.code, 0, out.stderr);
        assert.match(out.stdout, /^Kept your API key for http:\/\/127\.0\.0\.1:\d+, in a file only your account can read/);
        assert.equal((await kept(home, site)).key.key, KEY);
        assert.ok(!out.stdout.includes(KEY));

        const listed = await run(['list', '--url', site.url], homeEnv(home));
        assert.equal(listed.code, 0, listed.stderr);
        assert.equal(site.requests.at(-1).headers.authorization, 'Bearer ' + KEY, 'a kept key is used where there is no sign-in');

        const wrong = await run(['login', '--with-key', '--url', site.url], homeEnv(await freshHome()), { stdin: 'mk_live_' + '0'.repeat(48) });
        assert.equal(wrong.code, 1);
        assert.match(wrong.stderr, /Invalid API key/);
        const shapeless = await run(['login', '--with-key', '--url', site.url], homeEnv(await freshHome()), { stdin: 'hunter2' });
        assert.equal(shapeless.code, 1);
        assert.match(shapeless.stderr, /Pipe an API key from your account settings on stdin/);
    });
});

test('what login is asked wrongly is said, and nothing is asked of the site', async () => {
    const twice = await run(['login', '--device', '--with-key']);
    assert.equal(twice.code, 2);
    assert.match(twice.stderr, /Sign in with a code or keep a key, one at a time/);
    const extra = await run(['login', 'now']);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /markest login takes no arguments/);
    assert.equal((await run(['logout', 'x'])).code, 2);
    assert.equal((await run(['status', 'x'])).code, 2);
});

test('runs use the sign-in first, then MARKEST_API_KEY; MARKEST_AUTH chooses one', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        const token = (await kept(home, site)).oauth.access_token;
        const both = homeEnv(home, { MARKEST_API_KEY: KEY });

        await run(['list', '--url', site.url], both);
        assert.equal(site.requests.at(-1).headers.authorization, 'Bearer ' + token, 'the sign-in, though a key is set');
        await run(['list', '--url', site.url], { ...both, MARKEST_AUTH: 'key' });
        assert.equal(site.requests.at(-1).headers.authorization, 'Bearer ' + KEY);
        const before = site.requests.length;
        const oauthOnly = await run(['list', '--url', site.url], { ...homeEnv(await freshHome(), { MARKEST_API_KEY: KEY }), MARKEST_AUTH: 'oauth' });
        assert.equal(oauthOnly.code, 2);
        assert.match(oauthOnly.stderr, /Sign in with markest login/);
        assert.equal(site.requests.length, before, 'oauth alone, and no sign-in: nothing is asked, the key not used');

        const status = JSON.parse((await run(['status', '--url', site.url, '--json'], both)).stdout);
        assert.deepEqual({ ...status, signed_in_at: null }, { site: site.url, using: 'oauth', source: 'sign-in', scope: 'pastes.read pastes.write', signed_in_at: null, kept_in: 'a file only your account can read (' + join(home, 'vault-key') + '), not a secure store', secure: false });
        const words = await run(['status', '--url', site.url], { ...both, MARKEST_AUTH: 'key' });
        assert.match(words.stdout, /^Site: {5}http:\/\/127\.0\.0\.1:\d+\nUsing: {4}the API key in MARKEST_API_KEY\nKept in: {2}a file only/);
        const wrongMode = await run(['list', '--url', site.url], { ...both, MARKEST_AUTH: 'sometimes' });
        assert.equal(wrongMode.code, 2);
        assert.match(wrongMode.stderr, /MARKEST_AUTH is key or oauth, or not set/);
    });
});

test('status with nothing says what to do, and never shows a credential', async () => {
    await withSite(async (site) => {
        const nothing = await run(['status', '--url', site.url], homeEnv(await freshHome()));
        assert.equal(nothing.stdout, 'Site:     ' + site.url + '\nUsing:    nothing - run markest login, or set MARKEST_API_KEY\n');
        const keyed = await run(['status', '--url', site.url], homeEnv(await freshHome(), { MARKEST_API_KEY: KEY }));
        assert.ok(!keyed.stdout.includes(KEY));
        assert.match(keyed.stdout, /Using: {4}the API key in MARKEST_API_KEY\n$/);
    });
});

test('an access token the site refuses is refreshed once and the request asked again', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        const first = (await kept(home, site)).oauth;
        site.expireAccess();
        const out = await run(['list', '--url', site.url], homeEnv(home));
        assert.equal(out.code, 0, out.stderr);
        assert.equal(site.state.refreshes, 1);
        const second = (await kept(home, site)).oauth;
        assert.notEqual(second.access_token, first.access_token);
        assert.notEqual(second.refresh_token, first.refresh_token, 'the rotated refresh token kept');
        assert.equal(second.signed_in_at, first.signed_in_at);
    });
});

test('a sign-in the site has ended is forgotten here and said, never swapped for a key mid-run', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        site.endGrants();
        const out = await run(['list', '--url', site.url], homeEnv(home, { MARKEST_API_KEY: KEY }));
        assert.equal(out.code, 1);
        assert.match(out.stderr, /Your sign-in to http:\/\/127\.0\.0\.1:\d+ has ended \(This refresh token is unknown or has expired\.\)\. Run markest login to sign in again\./);
        assert.ok(!site.requests.some((one) => one.headers.authorization === 'Bearer ' + KEY), 'the key was not used in its place');
        assert.equal(await kept(home, site), null, 'the dead sign-in forgotten');
        const next = await run(['list', '--url', site.url], homeEnv(home, { MARKEST_API_KEY: KEY }));
        assert.equal(next.code, 0, 'the next run uses the key');
    });
});

test('logout ends the sign-in on the site and forgets it here, with a kept key', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        await run(['login', '--with-key', '--url', site.url], homeEnv(home), { stdin: KEY });
        const token = (await kept(home, site)).oauth.refresh_token;
        assert.equal(site.liveGrants(), 1);

        const out = await run(['logout', '--url', site.url], homeEnv(home));
        assert.equal(out.code, 0, out.stderr);
        assert.equal(out.stdout, 'Signed out of ' + site.url + '.\n');
        const revoked = site.requests.find((one) => one.path === '/oauth/revoke');
        assert.equal(revoked.form.get('token'), token);
        assert.equal(revoked.form.get('client_id'), site.url + '/.well-known/oauth-client-metadata/markest-cli.json');
        assert.equal(site.liveGrants(), 0);
        assert.equal(await kept(home, site), null);
        assert.ok(!(await readdir(home)).includes('sign-in.vault'), 'with no site left, the file is gone');

        const again = await run(['logout', '--url', site.url, '--json'], homeEnv(home));
        assert.deepEqual(JSON.parse(again.stdout), { site: site.url, signed_out: false });
    });
});

test('logout that cannot reach the site still forgets the sign-in, and says what is left', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        await site.close();
        const out = await run(['logout', '--url', site.url], homeEnv(home));
        assert.equal(out.code, 0);
        assert.match(out.stdout, /^Signed out of .*\.\nThe site could not be told \(The connection to the site was lost: .*\); the sign-in lapses there by itself within 30 days/);
        assert.equal(await kept(home, site), null);
    });
});

test('signing in again ends the sign-in it replaces', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        assert.equal(site.liveGrants(), 1, 'one sign-in alive, not two');
    });
});

/** A run's context whose secret store cannot be used, as on a server with no desktop keyring. */
async function noStoreContext(site, more = {}) {
    const { openVault } = await import('../src/store/vault.mjs');
    const { SecretStoreUnavailable } = await import('../src/store/secret-store.mjs');
    const home = await freshHome();
    const store = { kind: 'secret-service', secure: true, label: 'your desktop\'s keyring', read: async () => null, write: async () => { throw new SecretStoreUnavailable('The Secret Service cannot be used here (it is not installed).'); }, forget: async () => false };
    const out = { stdout: '', stderr: '' };
    const ctx = {
        baseUrl: site.url, env: { DISPLAY: ':0' }, version: '0', json: false,
        vault: { folder: home, open: async () => openVault({ folder: home, store }) },
        stdout: { write: (text) => { out.stdout += text; } }, stderr: { write: (text) => { out.stderr += text; } },
        browser: site.browser, ...more,
    };
    return { ctx, out, home };
}

test('where no secure store can be used, signing in is refused before anything is asked, unless --insecure-storage chose a plain file', async () => {
    const { COMMANDS } = await import('../src/commands/registry.mjs');
    await withSite(async (site) => {
        const refused = await noStoreContext(site);
        assert.equal(await COMMANDS.get('login').run({ ...refused.ctx, insecureStorage: false }), 1);
        assert.match(refused.out.stderr, /^markest: The Secret Service cannot be used here \(it is not installed\)\. Nothing was kept\. Set MARKEST_API_KEY instead, or run markest login --insecure-storage to keep the sign-in in a file only your account can read\.\n$/);
        assert.equal(site.requests.length, 0, 'the person was not sent to the browser for nothing');
        assert.deepEqual(await readdir(refused.home), []);

        const plain = await noStoreContext(site);
        assert.equal(await COMMANDS.get('login').run({ ...plain.ctx, insecureStorage: true }), 0, plain.out.stderr);
        assert.match(plain.out.stderr, /^markest: no secure store can be used here, so the sign-in is kept in a file only your account can read \(.*vault-key\), not a secure store\.\n/);
        assert.match(plain.out.stdout, /Kept in a file only your account can read/);
        const later = await openSignIns({ vault: testVault(plain.home) }).get(site.url);
        assert.ok(later.oauth.refresh_token, 'later runs find it, the file their mark');
    });
});

test('a sign-in that cannot be opened is removed by logout and said by status; a run with no key to fall back on stops', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        // The vault's key gone, as when an administrator resets a Windows password
        const { rm } = await import('node:fs/promises');
        await rm(join(home, 'vault-key'));
        await (await import('node:fs/promises')).writeFile(join(home, 'vault-key'), Buffer.alloc(32, 1).toString('base64') + '\n');

        const listed = await run(['list', '--url', site.url], homeEnv(home));
        assert.equal(listed.code, 1);
        assert.match(listed.stderr, /^markest: The file .*sign-in\.vault cannot be opened: the key that opens it is not in this machine's secret store any more\. Nothing was changed in it\. If the store is locked, unlock it and try again; if the file was kept with MARKEST_SECRET_STORE=file, set that again\.\n$/);
        const status = await run(['status', '--url', site.url], homeEnv(home));
        assert.equal(status.code, 1);
        assert.match(status.stderr, /The sign-in kept here cannot be opened: .* Run markest logout, then markest login\./);

        const out = await run(['logout', '--url', site.url, '--json'], homeEnv(home));
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(JSON.parse(out.stdout), { site: site.url, signed_out: true, ended_on_site: false, note: 'The sign-in kept here could not be opened, so it was removed; on the site it lapses by itself within 30 days, or disconnect it in your account settings.' });
        assert.ok(!(await readdir(home)).includes('sign-in.vault'));
        assert.equal((await run(['status', '--url', site.url], homeEnv(home))).code, 0, 'and runs go on without it');
    });
});

test('a bad MARKEST_AUTH stops status too', async () => {
    const out = await run(['status'], homeEnv(await freshHome(), { MARKEST_AUTH: 'both' }));
    assert.equal(out.code, 1);
    assert.match(out.stderr, /MARKEST_AUTH is key or oauth, or not set/);
});

// What the commands' mutation run of 2026-10-02 showed untested

/**
 * A command run directly, past main. Never the real browser: on 2026-10-02 a
 * mutant of login sent a run made with no browser down the browser's path,
 * and the system's own opened marke.st. A browser that refuses is handed in
 * unless the test hands its own, and SystemRoot points nowhere.
 */
async function commandRun(name, ctx) {
    const { COMMANDS } = await import('../src/commands/registry.mjs');
    const out = { stdout: '', stderr: '' };
    const code = await COMMANDS.get(name).run({
        env: { SystemRoot: TEST_ENV.SystemRoot }, version: '0', json: false,
        browser: async () => { throw new Error('A test opened a browser.'); },
        stdout: { write: (text) => { out.stdout += text; } }, stderr: { write: (text) => { out.stderr += text; } },
        ...ctx,
    });
    return { code, ...out };
}

test('the sign-in commands read the vault themselves, and each says what it takes', async () => {
    const { COMMANDS } = await import('../src/commands/registry.mjs');
    for (const name of ['login', 'logout', 'status']) assert.equal(COMMANDS.get(name).credential, false, name);
    assert.deepEqual(COMMANDS.get('login').parse({ 'insecure-storage': true }, []), { device: false, withKey: false, insecureStorage: true });
    assert.deepEqual(COMMANDS.get('login').parse({ device: true }, []), { device: true, withKey: false, insecureStorage: false });
});

test('only a whole API key is kept: nothing before it, nothing after', async () => {
    await withSite(async (site) => {
        for (const stdin of ['x' + KEY, KEY + 'Z', KEY + ' and more']) {
            const out = await run(['login', '--with-key', '--url', site.url], homeEnv(await freshHome()), { stdin });
            assert.equal(out.code, 1, stdin);
            assert.match(out.stderr, /Pipe an API key from your account settings on stdin/, stdin);
        }
    });
});

test('a kept key is asked of the site once, by its first artifact, and said exactly', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        const out = await run(['login', '--with-key', '--url', site.url, '--json'], homeEnv(home), { stdin: KEY });
        assert.deepEqual(JSON.parse(out.stdout), { site: site.url, signed_in: true, method: 'key', kept_in: 'a file only your account can read (' + join(home, 'vault-key') + '), not a secure store' });
        const asked = site.requests.find((one) => one.path === '/api/v1/pastes');
        assert.equal(asked.query.get('limit'), '1');
        const words = await run(['login', '--with-key', '--url', site.url], homeEnv(await freshHome()), { stdin: KEY });
        assert.match(words.stdout, /^Kept your API key for http:\/\/127\.0\.0\.1:\d+, in a file only your account can read \(.*vault-key\), not a secure store\.\n$/);
    });
});

test('a kept key is asked again after a lost connection, being safe to ask twice', async () => {
    const home = await freshHome();
    let calls = 0;
    const fetch = async () => {
        calls++;
        if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        return new Response(JSON.stringify({ pastes: [] }), { status: 200 });
    };
    const out = await commandRun('login', { withKey: true, baseUrl: 'https://marke.st', fetch, vault: testVault(home), stdin: (await import('node:stream')).Readable.from([Buffer.from(KEY)]) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(calls, 2);
});

test('the browser sign-in says exactly where to go, and keeps who it was for', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        const out = await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        const asked = site.requests.find((one) => one.path === '/oauth/authorize').query;
        assert.equal(out.stderr, 'Opening your browser to sign in to ' + site.url + '.\nIf it does not open, go to:\n\n  ' + site.url + '/oauth/authorize?' + asked.toString() + '\n\n');
        assert.equal((await kept(home, site)).oauth.client_id, site.url + '/.well-known/oauth-client-metadata/markest-cli.json');
    });
});

test('a browser that never answers is waited for no longer than the wait', async () => {
    await withSite(async (site) => {
        const out = await commandRun('login', { baseUrl: site.url, env: DESKTOP, vault: testVault(await freshHome()), browser: async () => true, waitMs: 50 });
        assert.equal(out.code, 1);
        assert.match(out.stderr, /markest: No answer came from the browser in 0 minutes\.\n$/);
    });
});

test('when the system browser cannot open, login leaves the manual address and ends its wait', async () => {
    await withSite(async (site) => {
        const out = await commandRun('login', {
            baseUrl: site.url, env: DESKTOP, vault: testVault(await freshHome()),
            browser: undefined, waitMs: 50,
        });
        assert.equal(out.code, 1);
        assert.ok(out.stderr.includes('If it does not open, go to:\n\n  ' + site.url + '/oauth/authorize?'));
        assert.match(out.stderr, /No answer came from the browser/);
        assert.equal(site.requests.length, 0, 'the harness blocks the system opener before it starts');
    });
});

test('a code says how long it lasts - ten minutes when the site says nothing - and where to enter it, exactly', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        const out = await run(['login', '--device', '--url', site.url, '--json'], homeEnv(home), { sleep: async () => site.allowDevice() });
        assert.equal(out.stderr, 'To sign in, open this page on any device:\n\n  ' + site.url + '/oauth/device\n\nand enter the code\n\n  BCDF-GHJK\n\nIt expires in 10 minutes. Enter it only at ' + site.url + ', and only if you started this.\n');
        assert.equal(JSON.parse(out.stdout).via, 'code');
    }, { deviceExpiresIn: null });
});

test('a sign-in after a kept key ends no sign-in, and keeps the key', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--with-key', '--url', site.url], homeEnv(home), { stdin: KEY });
        const out = await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        assert.equal(out.code, 0, out.stderr);
        assert.equal(site.requests.filter((one) => one.path === '/oauth/revoke').length, 0);
        assert.equal((await kept(home, site)).key.key, KEY);
    });
});

test('a store that holds a vault but no key stops login with what to do, never taken for no store', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--with-key', '--url', site.url], homeEnv(home), { stdin: KEY });
        const { rm } = await import('node:fs/promises');
        await rm(join(home, 'vault-key'));
        const before = site.requests.length;
        const out = await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        assert.equal(out.code, 1);
        assert.match(out.stderr, /sign-in\.vault cannot be opened: .*If the store is locked, unlock it and try again/);
        assert.ok(!out.stderr.includes('Set MARKEST_API_KEY instead'), 'not the words for a machine with no store');
        assert.equal(site.requests.length, before, 'and nothing was asked of the site');
    });
});

test('a fault login does not foresee is passed on, never dressed as the site\'s refusal', async () => {
    const vault = { folder: await freshHome(), open: async () => { throw new Error('the disk is gone'); } };
    await assert.rejects(commandRun('login', { baseUrl: 'https://marke.st', json: true, vault }), /the disk is gone/);
});

test('logout: a kept key alone ends nothing on the site; a fault reading the sign-in is passed on, the file kept', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--with-key', '--url', site.url], homeEnv(home), { stdin: KEY });
        const out = await run(['logout', '--url', site.url, '--json'], homeEnv(home));
        assert.deepEqual(JSON.parse(out.stdout), { site: site.url, signed_out: true, ended_on_site: null });
        assert.equal(site.requests.filter((one) => one.path === '/oauth/revoke').length, 0);

        const text = await run(['logout', '--url', site.url], homeEnv(home));
        assert.equal(text.stdout, 'Not signed in to ' + site.url + '.\n');

        let removed = false;
        const failing = { folder: home, open: async () => ({ exists: async () => true, read: async () => { throw new Error('read failed'); }, remove: async () => { removed = true; } }) };
        await assert.rejects(commandRun('logout', { baseUrl: site.url, vault: failing }), /read failed/);
        assert.equal(removed, false, 'only a sign-in that cannot be opened is removed');
    });
});

test('logout says whether the site ended the sign-in, and when it could not, exactly what is left', async () => {
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        const ended = await run(['logout', '--url', site.url, '--json'], homeEnv(home));
        assert.deepEqual(JSON.parse(ended.stdout), { site: site.url, signed_out: true, ended_on_site: true });

        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        await site.close();
        const json = await run(['logout', '--url', site.url, '--json'], homeEnv(home));
        assert.equal(JSON.parse(json.stdout).ended_on_site, false);
    });
    await withSite(async (site) => {
        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        await site.close();
        const words = await run(['logout', '--url', site.url], homeEnv(home));
        assert.match(words.stdout, /^Signed out of .*\.\nThe site could not be told \(.*\); the sign-in lapses there by itself within 30 days, or disconnect it in your account settings\.\n$/);
    });
});

test('status says exactly what runs use, since when, and where it is kept, and nothing when nothing is', async () => {
    await withSite(async (site) => {
        const nothing = JSON.parse((await run(['status', '--url', site.url, '--json'], homeEnv(await freshHome()))).stdout);
        assert.deepEqual(nothing, { site: site.url, using: null, source: null, scope: null, signed_in_at: null, kept_in: null, secure: null });

        const home = await freshHome();
        await run(['login', '--url', site.url], homeEnv(home, DESKTOP), { browser: site.browser });
        const record = (await kept(home, site)).oauth;
        const label = 'a file only your account can read (' + join(home, 'vault-key') + '), not a secure store';
        const json = JSON.parse((await run(['status', '--url', site.url, '--json'], homeEnv(home))).stdout);
        assert.equal(json.signed_in_at, record.signed_in_at);
        const words = await run(['status', '--url', site.url], homeEnv(home));
        assert.equal(words.stdout, 'Site:     ' + site.url + '\nUsing:    your sign-in (read and write), since ' + record.signed_in_at.slice(0, 16).replace('T', ' ') + ' UTC\nKept in:  ' + label + '\n');

        const keyHome = await freshHome();
        await run(['login', '--with-key', '--url', site.url], homeEnv(keyHome), { stdin: KEY });
        const keyWords = await run(['status', '--url', site.url], homeEnv(keyHome));
        assert.equal(keyWords.stdout, 'Site:     ' + site.url + '\nUsing:    the API key kept with markest login --with-key\nKept in:  a file only your account can read (' + join(keyHome, 'vault-key') + '), not a secure store\n');
        const keyJson = JSON.parse((await run(['status', '--url', site.url, '--json'], homeEnv(keyHome))).stdout);
        assert.deepEqual([keyJson.using, keyJson.source, keyJson.scope, keyJson.signed_in_at], ['key', 'stored', null, null]);
    });
});
