/**
 * @module cli/store/private-file
 * @description A file of the command's own, written whole - to a file beside it
 *              renamed into place, so a reader never finds half of it - in a
 *              folder and with a mode only its owner can read, where the system
 *              has such modes (on Windows the account's own settings folder
 *              protects it); read back as text, or null when it is not there.
 *
 * @input A path; the text to write
 * @output The text, or null
 * @dependencies node:fs/promises, node:path
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The file's text, or null when there is none. */
export async function readIfThere(path) {
    try {
        // Stryker disable next-line StringLiteral: equivalent - every caller reads text, and a buffer's text is the same
        return await readFile(path, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

/** Write the file whole, readable by its owner alone. */
export async function writePrivate(path, text) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Stryker disable next-line StringLiteral: equivalent - any name beside it serves, renamed into place
    const temporary = path + '.' + process.pid + '.tmp';
    // Stryker disable next-line ObjectLiteral,StringLiteral: platform - the owner-only mode is checked only where the system has one (not Windows, where these runs are made; the chmod below sets it again); utf8 is writeFile's own default for text
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
}

/** The file gone; whether there was one. */
export async function removeIfThere(path) {
    const there = (await readIfThere(path)) !== null;
    await rm(path, { force: true });
    return there;
}
