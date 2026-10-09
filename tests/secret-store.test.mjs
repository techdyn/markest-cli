/**
 * Regression test: the vault's key is kept in the system's
 * own store for secrets (cli/store/secret-store) - DPAPI on Windows, the
 * Keychain on a Mac, the Secret Service on Linux - each reached by its own
 * program at its own path, never a shell, the key on stdin and never in an
 * argument; a store that cannot be used says so; the plain file only when it
 * was asked for, and saying it is not secure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
    DPAPI_KEY_FILE, PLAIN_KEY_FILE, PLAIN_MARK_FILE, SecretStoreUnavailable, choosePlainFile, dpapiStore, fileStore, keychainStore,
    runProcess, secretServiceStore, secretStoreFor, vaultName,
} from '../src/store/secret-store.mjs';

const KEY = Buffer.alloc(32, 7);
const B64 = KEY.toString('base64');

const folder = () => mkdtemp(join(tmpdir(), 'markest-secrets-'));

/** A stand-in for running a program: records each call, answers from a list. */
function programs(...answers) {
    const calls = [];
    const run = async (command, args, options = {}) => {
        calls.push({ command, args, input: options.input ?? '' });
        const answer = answers.shift() ?? { code: 0, stdout: '' };
        return { stdout: '', stderr: '', error: null, ...answer };
    };
    return { run, calls };
}

const noKeyInArguments = (calls) => calls.forEach((call) => assert.ok(!call.args.join(' ').includes(B64), 'the key never stands in an argument: ' + call.args.join(' ')));

test('a program is run with its input on stdin, and one that cannot start says why', async () => {
    const echoed = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'on stdin' });
    assert.deepEqual([echoed.code, echoed.stdout, echoed.error], [0, 'on stdin', null]);
    const failed = await runProcess(process.execPath, ['-e', 'process.stderr.write("no"); process.exit(3)']);
    assert.deepEqual([failed.code, failed.stderr], [3, 'no']);
    const missing = await runProcess(join(tmpdir(), 'no-such-program-' + process.pid));
    assert.equal(missing.code, null);
    assert.equal(missing.error.code, 'ENOENT');
    const unstartable = await runProcess(null, []);
    assert.deepEqual([unstartable.code, unstartable.error.code], [null, 'ERR_INVALID_ARG_TYPE'], 'a program that cannot even be asked for');
    assert.deepEqual([unstartable.stdout, unstartable.stderr], ['', ''], 'a program that never started said nothing');
    const slow = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 });
    assert.notEqual(slow.code, 0, 'a program that hangs is stopped');
});

test('each settings folder has a vault of its own', () => {
    assert.match(vaultName('/a'), /^vault-[0-9a-f]{16}$/);
    assert.notEqual(vaultName('/a'), vaultName('/b'));
    assert.equal(vaultName('/a'), vaultName('/a'));
});

test('Windows: the key sealed by DPAPI under the account, through the system\'s own PowerShell', async () => {
    const where = await folder();
    const { run, calls } = programs({ code: 0, stdout: 'U0VBTEVE\r\n' }, { code: 0, stdout: B64 });
    const store = dpapiStore(where, { env: { SystemRoot: 'D:\\Win' }, run });
    assert.deepEqual([store.kind, store.secure], ['dpapi', true]);
    assert.match(store.label, /Data Protection API/);
    assert.equal(await store.read(), null, 'nothing sealed yet, and nothing run for that');
    assert.equal(calls.length, 0);

    await store.write(KEY);
    assert.equal(await readFile(join(where, DPAPI_KEY_FILE), 'utf8'), 'U0VBTEVE\n', 'only what DPAPI sealed is written');
    assert.deepEqual(await store.read(), KEY);
    assert.equal(calls[0].command, join('D:\\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(calls[0].args[4], 'base64').toString('utf16le');
    assert.match(script, /ProtectedData\]::Protect\(\$d,\$e,\[Security\.Cryptography\.DataProtectionScope\]::CurrentUser\)/);
    assert.match(script, /'markest-vault-v1'/);
    assert.equal(calls[0].input, B64, 'the key on stdin');
    assert.match(Buffer.from(calls[1].args[4], 'base64').toString('utf16le'), /::Unprotect\(/);
    assert.equal(calls[1].input, 'U0VBTEVE', 'what was sealed, to open');
    noKeyInArguments(calls);

    assert.equal(await store.forget(), true);
    assert.equal(await store.read(), null);
});

test('Windows: a Data Protection API that refuses is said, and nothing is written', async () => {
    const where = await folder();
    const { run } = programs({ code: 1, stderr: 'Exception calling "Protect"' });
    await assert.rejects(dpapiStore(where, { run }).write(KEY), (error) => error instanceof SecretStoreUnavailable && /Data Protection API cannot be used here \(Exception calling "Protect"\)/.test(error.message));
    await assert.rejects(stat(join(where, DPAPI_KEY_FILE)), { code: 'ENOENT' });
    const missing = programs({ code: null, error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) });
    await assert.rejects(dpapiStore(where, { run: missing.run }).write(KEY), /it is not installed/);
});

test('a Mac: the login Keychain through /usr/bin/security, the key read from stdin and read back', async () => {
    const where = await folder();
    const { run, calls } = programs({ code: 44 }, { code: 0 }, { code: 0, stdout: B64 + '\n' }, { code: 0, stdout: B64 + '\n' }, { code: 0 });
    const store = keychainStore(where, { run });
    assert.deepEqual([store.kind, store.secure, store.label], ['keychain', true, 'your login Keychain']);
    assert.equal(await store.read(), null, '44: nothing kept');
    await store.write(KEY);
    assert.deepEqual(await store.read(), KEY);
    assert.equal(await store.forget(), true);
    assert.ok(calls.every((call) => call.command === '/usr/bin/security'));
    assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'markest', '-a', vaultName(where), '-w']);
    assert.deepEqual(calls[1].args, ['-i']);
    assert.equal(calls[1].input, 'add-generic-password -U -s markest -a ' + vaultName(where) + ' -w ' + B64 + '\n');
    assert.deepEqual(calls[4].args, ['delete-generic-password', '-s', 'markest', '-a', vaultName(where)]);
    noKeyInArguments(calls);
});

test('a Mac: a Keychain that did not keep the key, or cannot be reached, says so', async () => {
    const where = await folder();
    const wrong = programs({ code: 0 }, { code: 0, stdout: Buffer.alloc(32, 1).toString('base64') });
    await assert.rejects(keychainStore(where, { run: wrong.run }).write(KEY), /did not keep the key/);
    const none = programs({ code: 0 }, { code: 44 });
    await assert.rejects(keychainStore(where, { run: none.run }).write(KEY), /did not keep the key/);
    const locked = programs({ code: 51, stderr: 'User interaction is not allowed.' });
    await assert.rejects(keychainStore(where, { run: locked.run }).read(), /Keychain cannot be used here \(User interaction is not allowed\.\)/);
    const refused = programs({ code: 1 });
    await assert.rejects(keychainStore(where, { run: refused.run }).write(KEY), /Keychain cannot be used here \(it answered 1\)/);
    const gone = programs({ code: 44 });
    assert.equal(await keychainStore(where, { run: gone.run }).forget(), false);
});

test('Linux: the Secret Service through secret-tool, the key on stdin', async () => {
    const where = await folder();
    const { run, calls } = programs({ code: 1 }, { code: 0 }, { code: 0, stdout: B64 }, { code: 0 });
    const store = secretServiceStore(where, { run });
    assert.deepEqual([store.kind, store.secure], ['secret-service', true]);
    assert.match(store.label, /Secret Service/);
    assert.equal(await store.read(), null, 'exit 1 and nothing said: nothing kept');
    await store.write(KEY);
    assert.deepEqual(await store.read(), KEY);
    assert.equal(await store.forget(), true);
    const attributes = ['service', 'markest', 'vault', vaultName(where).slice('vault-'.length)];
    assert.ok(calls.every((call) => call.command === 'secret-tool'));
    assert.deepEqual(calls[0].args, ['lookup', ...attributes]);
    assert.deepEqual(calls[1].args, ['store', '--label', 'Markest CLI', ...attributes]);
    assert.equal(calls[1].input, B64);
    assert.deepEqual(calls[3].args, ['clear', ...attributes]);
    noKeyInArguments(calls);
});

test('Linux: no secret-tool, or no Secret Service to talk to, is said and never guessed past', async () => {
    const where = await folder();
    const missing = programs({ code: null, error: Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }) });
    await assert.rejects(secretServiceStore(where, { run: missing.run }).read(), /Secret Service cannot be used here \(it is not installed\)/);
    const noBus = programs({ code: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY\n' });
    await assert.rejects(secretServiceStore(where, { run: noBus.run }).read(), /Cannot autolaunch D-Bus/);
    const refused = programs({ code: 1, stderr: 'Cannot create an item in a locked collection' });
    await assert.rejects(secretServiceStore(where, { run: refused.run }).write(KEY), /locked collection/);
    const broken = programs({ code: null, error: new Error('EACCES') });
    await assert.rejects(secretServiceStore(where, { run: broken.run }).read(), /\(EACCES\)/);
    const cleared = programs({ code: 1 });
    assert.equal(await secretServiceStore(where, { run: cleared.run }).forget(), false);
});

test('the plain file is not secure, and says so', async () => {
    const where = await folder();
    const store = fileStore(where);
    assert.deepEqual([store.kind, store.secure], ['file', false]);
    assert.match(store.label, /not a secure store/);
    assert.ok(store.label.includes(join(where, PLAIN_KEY_FILE)));
    assert.equal(await store.read(), null);
    await store.write(KEY);
    assert.equal(await readFile(join(where, PLAIN_KEY_FILE), 'utf8'), B64 + '\n');
    assert.deepEqual(await store.read(), KEY);
    if (process.platform !== 'win32') assert.equal((await stat(join(where, PLAIN_KEY_FILE))).mode & 0o777, 0o600);
    assert.equal(await store.forget(), true);
    assert.equal(await store.forget(), false);
    await writeFile(join(where, PLAIN_KEY_FILE), '\n');
    assert.equal(await store.read(), null, 'an empty file holds no key');
});

test('the system\'s own store, unless the plain file was asked for', async () => {
    const where = await folder();
    assert.equal((await secretStoreFor({ folder: where, platform: 'win32', env: {} })).kind, 'dpapi');
    assert.equal((await secretStoreFor({ folder: where, platform: 'darwin', env: {} })).kind, 'keychain');
    assert.equal((await secretStoreFor({ folder: where, platform: 'linux', env: {} })).kind, 'secret-service');
    assert.equal((await secretStoreFor({ folder: where, platform: 'freebsd', env: { MARKEST_SECRET_STORE: '' } })).kind, 'secret-service');
    assert.equal((await secretStoreFor({ folder: where, platform: 'win32', env: { MARKEST_SECRET_STORE: 'file' } })).kind, 'file', 'asked for in the environment');
    // The key in a plain file is no choice on its own: a run with MARKEST_SECRET_STORE=file leaves one (found by the review of 2026-10-02)
    await writeFile(join(where, PLAIN_KEY_FILE), B64 + '\n');
    assert.equal((await secretStoreFor({ folder: where, platform: 'darwin', env: {} })).kind, 'keychain', 'a plain key left by one run chooses nothing for the next');
    await choosePlainFile(where);
    assert.equal(await readFile(join(where, PLAIN_MARK_FILE), 'utf8'), "Chosen with markest login --insecure-storage: the vault's key is kept in vault-key, in the clear.\n");
    assert.equal((await secretStoreFor({ folder: where, platform: 'darwin', env: {} })).kind, 'file', 'the mark --insecure-storage leaves is the choice');
    await assert.rejects(secretStoreFor({ folder: where, env: { MARKEST_SECRET_STORE: 'keychain' } }), /MARKEST_SECRET_STORE is file, or not set/);
});

test('Windows, for real: DPAPI seals and opens the key, and the file holds none of it', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    const where = await folder();
    const store = dpapiStore(where, { env: process.env });
    const key = randomBytes(32);
    await store.write(key);
    assert.ok(!(await readFile(join(where, DPAPI_KEY_FILE), 'utf8')).includes(key.toString('base64')));
    assert.deepEqual(await store.read(), key);
});

test('a program given no input reads none, and what it says is said back as it said it', async () => {
    const quiet = await runProcess(process.execPath, ['-e', 'let n = 0; process.stdin.on("data", (c) => { n += c.length; }); process.stdin.on("end", () => process.stdout.write(String(n)))']);
    assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [0, '0', '']);
    const loud = await runProcess(process.execPath, ['-e', 'process.stderr.write("both"); process.stdout.write("said")']);
    assert.deepEqual([loud.stdout, loud.stderr], ['said', 'both']);
});

test('why a store cannot be used is said in one line, as the program said it', async () => {
    const where = await folder();
    const noBus = programs({ code: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY\n' });
    await assert.rejects(secretServiceStore(where, { run: noBus.run }).read(), (error) => error.message === 'The Secret Service cannot be used here (Cannot autolaunch D-Bus without X11 $DISPLAY).');
});

test('a settled program leaves no timeout pending, after either a close or a start error', async (t) => {
    const pending = new Set();
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
        const timer = set(fn, ms, ...args);
        pending.add(timer);
        return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', (timer) => {
        pending.delete(timer);
        return clear(timer);
    });
    t.after(() => { for (const timer of pending) clear(timer); });
    assert.equal((await runProcess(process.execPath, ['-e', ''])).code, 0);
    assert.equal(pending.size, 0, 'a completed program leaves no kill scheduled');
    const missing = await runProcess(join(tmpdir(), 'missing-store-program-' + process.pid));
    assert.equal(missing.error.code, 'ENOENT');
    assert.equal(pending.size, 0, 'a failed start leaves no kill scheduled');
});

test('a program closing stdin early does not turn a broken pipe into an unhandled error', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdin.destroy(); process.stdout.write("closed input")'], { input: 'x'.repeat(1024 * 1024) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'closed input');
});

test('Windows uses its default system folder when neither environment spelling is present', async () => {
    const where = await folder();
    await writeFile(join(where, DPAPI_KEY_FILE), 'sealed');
    const fake = programs({ code: 0, stdout: B64 });
    assert.deepEqual(await dpapiStore(where, { run: fake.run }).read(), KEY);
    assert.equal(fake.calls[0].command, join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
});

test('an empty Secret Service result may contain whitespace, but a transport error is never empty storage', async () => {
    const where = await folder();
    assert.equal(await secretServiceStore(where, { run: programs({ code: 1, stderr: ' \r\n ' }).run }).read(), null);
    const failed = programs({ code: 1, error: new Error('transport failed') });
    await assert.rejects(secretServiceStore(where, { run: failed.run }).read(), /The Secret Service cannot be used here \(transport failed\)/);
    const refused = programs({ code: 1, stderr: 'locked' });
    await assert.rejects(secretServiceStore(where, { run: refused.run }).write(KEY), (error) => error.message === 'The Secret Service cannot be used here (locked).');
});

test('choosing a system store carries its environment and process adapter through to that store', async () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
        const where = await folder();
        if (platform === 'win32') await writeFile(join(where, DPAPI_KEY_FILE), 'sealed');
        const fake = programs({ code: 0, stdout: B64 });
        const store = await secretStoreFor({ folder: where, platform, env: { SystemRoot: 'Z:\\TestWindows' }, run: fake.run });
        assert.deepEqual(await store.read(), KEY, platform);
        assert.equal(fake.calls.length, 1, platform);
        if (platform === 'win32') assert.equal(fake.calls[0].command, join('Z:\\TestWindows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    }
});
