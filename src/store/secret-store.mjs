/**
 * @module cli/store/secret-store
 * @description Where the one key that opens the command's vault is kept: the
 *              system's own store for secrets, never a file of ours in the
 *              clear. On Windows, the Data Protection API under
 *              the account (the key kept in a file only that account's login
 *              opens); on a Mac, the login Keychain, through `security`; on
 *              Linux, the Secret Service - GNOME Keyring, KWallet - through
 *              `secret-tool`. Each is reached by the system's own program at its
 *              own path, never through a shell, and the key travels on stdin,
 *              never as an argument a process listing would show. A store that
 *              cannot be reached says so, and nothing falls back on its own.
 *
 *              The plain file - the key in a file only the account can read - is
 *              used only when asked: `markest login --insecure-storage`, which
 *              leaves a mark of the choice beside it, or MARKEST_SECRET_STORE=file, for a
 *              container or a test. It says it is not secure.
 *
 * @input The environment, the platform, the settings folder; a way to run a program
 * @output `{ kind, secure, label, read(), write(bytes), forget() }`; SecretStoreUnavailable
 * @dependencies node:child_process, node:crypto, node:path, cli/store/private-file
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readIfThere, removeIfThere, writePrivate } from './private-file.mjs';

/** The plain file, in the settings folder. */
export const PLAIN_KEY_FILE = 'vault-key';

/**
 * The mark `markest login --insecure-storage` leaves: the choice of the plain
 * file, kept for later runs. The plain file alone is no choice - a run with
 * MARKEST_SECRET_STORE=file makes one, and that choice is the run's (found by
 * the review of 2026-10-02).
 */
export const PLAIN_MARK_FILE = 'insecure-storage';

/** Leave the mark that chooses the plain file for later runs. */
export function choosePlainFile(folder) {
    return writePrivate(join(folder, PLAIN_MARK_FILE), 'Chosen with markest login --insecure-storage: the vault\'s key is kept in ' + PLAIN_KEY_FILE + ', in the clear.\n');
}

/** The Windows key, sealed by the Data Protection API, in the settings folder. */
export const DPAPI_KEY_FILE = 'vault-key.dpapi';

/** The service every stored item is filed under. */
export const SERVICE = 'markest';

export class SecretStoreUnavailable extends Error {}

/** A program run with its input on stdin: its exit code and output, or the error that kept it from starting. */
export function runProcess(command, args, { input = '', timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            // Stryker disable next-line ObjectLiteral: equivalent - pipes, no shell and a visible console are spawn's defaults; hiding the console changes no program output
            child = spawn(command, args, {
                // Stryker disable next-line ArrayDeclaration: equivalent - an empty stdio array uses spawn's default pipes
                stdio: ['pipe', 'pipe', 'pipe'],
                // Stryker disable next-line BooleanLiteral: platform - hiding a console window changes no program output
                windowsHide: true,
                shell: false,
            });
        } catch (error) {
            resolve({ code: null, stdout: '', stderr: '', error });
            return;
        }
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr, error });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, error: null });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

/** One vault per settings folder: the name its key is kept under. */
export function vaultName(folder) {
    return 'vault-' + createHash('sha256').update(folder).digest('hex').slice(0, 16);
}

const decoded = (text) => {
    const trimmed = String(text ?? '').trim();
    return trimmed === '' ? null : Buffer.from(trimmed, 'base64');
};

/** Why a program could not be used, said once. */
function unavailable(what, result) {
    const why = result.error ? (result.error.code === 'ENOENT' ? 'it is not installed' : result.error.message) : (result.stderr.trim() || 'it answered ' + result.code);
    return new SecretStoreUnavailable(what + ' cannot be used here (' + why + ').');
}

/** The plain file: only when asked for, and it says what it is. */
export function fileStore(folder) {
    const path = join(folder, PLAIN_KEY_FILE);
    return {
        kind: 'file',
        secure: false,
        label: 'a file only your account can read (' + path + '), not a secure store',
        read: async () => decoded(await readIfThere(path)),
        write: (bytes) => writePrivate(path, bytes.toString('base64') + '\n'),
        forget: () => removeIfThere(path),
    };
}

// DPAPI, under the account, with this command's own entropy: what one sealed, only that account's login opens
const DPAPI = (verb) => "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;"
    + '$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());'
    + "$e=[Text.Encoding]::UTF8.GetBytes('markest-vault-v1');"
    + '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::' + verb + '($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))';

/** Windows: the key sealed by the Data Protection API, in a file only this account's login opens. */
export function dpapiStore(folder, { env = {}, run = runProcess } = {}) {
    const path = join(folder, DPAPI_KEY_FILE);
    const powershell = join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const call = async (verb, base64) => {
        const script = Buffer.from(DPAPI(verb), 'utf16le').toString('base64');
        const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script], { input: base64 });
        if (result.code !== 0) throw unavailable('The Windows Data Protection API', result);
        return result.stdout.trim();
    };
    return {
        kind: 'dpapi',
        secure: true,
        label: 'Windows\' Data Protection API, opened only by your Windows account',
        async read() {
            const sealed = await readIfThere(path);
            return sealed === null ? null : decoded(await call('Unprotect', sealed.trim()));
        },
        async write(bytes) {
            await writePrivate(path, await call('Protect', bytes.toString('base64')) + '\n');
        },
        forget: () => removeIfThere(path),
    };
}

/** A Mac: the login Keychain, through the system's own `security`. */
export function keychainStore(folder, { run = runProcess } = {}) {
    const account = vaultName(folder);
    const security = '/usr/bin/security';
    const read = async () => {
        const result = await run(security, ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
        // 44: no such item
        if (result.code === 44) return null;
        if (result.code !== 0) throw unavailable('The Keychain', result);
        return decoded(result.stdout);
    };
    return {
        kind: 'keychain',
        secure: true,
        label: 'your login Keychain',
        read,
        async write(bytes) {
            // Through `security -i`, so the key is read from stdin and never stands in an argument;
            // its interactive mode answers 0 whatever a command did, so the key is read back
            const result = await run(security, ['-i'], { input: 'add-generic-password -U -s ' + SERVICE + ' -a ' + account + ' -w ' + bytes.toString('base64') + '\n' });
            if (result.code !== 0) throw unavailable('The Keychain', result);
            const back = await read();
            if (back === null || !back.equals(bytes)) throw new SecretStoreUnavailable('The Keychain did not keep the key.');
        },
        async forget() {
            const result = await run(security, ['delete-generic-password', '-s', SERVICE, '-a', account]);
            return result.code === 0;
        },
    };
}

/** Linux: the Secret Service - GNOME Keyring, KWallet - through `secret-tool`. */
export function secretServiceStore(folder, { run = runProcess } = {}) {
    const attributes = ['service', SERVICE, 'vault', vaultName(folder).slice('vault-'.length)];
    return {
        kind: 'secret-service',
        secure: true,
        label: 'your desktop\'s keyring (the Secret Service)',
        async read() {
            const result = await run('secret-tool', ['lookup', ...attributes]);
            // Nothing kept is exit 1 and nothing said; no service says why
            if (result.code === 1 && result.stderr.trim() === '' && result.error === null) return null;
            if (result.code !== 0) throw unavailable('The Secret Service', result);
            return decoded(result.stdout);
        },
        async write(bytes) {
            const result = await run('secret-tool', ['store', '--label', 'Markest CLI', ...attributes], { input: bytes.toString('base64') });
            if (result.code !== 0) throw unavailable('The Secret Service', result);
        },
        async forget() {
            const result = await run('secret-tool', ['clear', ...attributes]);
            return result.code === 0;
        },
    };
}

/**
 * The store this run keeps its vault key in: the plain file when it was
 * chosen, else the system's own.
 */
export async function secretStoreFor({ env = {}, platform = process.platform, folder, run = runProcess }) {
    const asked = env.MARKEST_SECRET_STORE;
    if (asked !== undefined && asked !== '' && asked !== 'file') throw new SecretStoreUnavailable('MARKEST_SECRET_STORE is file, or not set.');
    if (asked === 'file' || (await readIfThere(join(folder, PLAIN_MARK_FILE))) !== null) return fileStore(folder);
    if (platform === 'win32') return dpapiStore(folder, { env, run });
    if (platform === 'darwin') return keychainStore(folder, { run });
    return secretServiceStore(folder, { run });
}
