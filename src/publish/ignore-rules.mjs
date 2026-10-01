/**
 * @module cli/ignore-rules
 * @description What a `.markestignore` file and `--ignore` leave out, as far of
 *              gitignore as a folder of documents needs: `#` comments, `!` to
 *              take a path back, a leading `/` for the folder's root, a trailing
 *              `/` for folders only, `*`, `?` and `**`, a pattern without a slash
 *              matching a name at any depth, and the last match winning. As in
 *              git, nothing inside a folder left out comes back. The built-in
 *              rules (hidden files, dependency trees, secrets) are not patterns
 *              and cannot be taken back here. Pure but for reading the file.
 *
 * @input Pattern lines; the folder
 * @output `{ ignores(path, isDirectory) }`; the folder's own lines
 * @dependencies node:fs/promises
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SPECIAL = /[.+^${}()|[\]\\]/g;

function segmentPattern(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') out += '[^/]*';
        else if (c === '?') out += '[^/]';
        else out += c.replace(SPECIAL, '\\$&');
    }
    return out;
}

/** One gitignore line as a regular expression over a path relative to the root. */
function compileLine(line) {
    let text = line.replace(/\s+$/, '');
    if (text.startsWith('#')) return null;
    let negate = false;
    if (text.startsWith('!')) {
        negate = true;
        text = text.slice(1);
    } else if (text.startsWith('\\!') || text.startsWith('\\#')) {
        text = text.slice(1);
    }
    const directoryOnly = text.endsWith('/');
    text = text.replace(/\/+$/, '');
    // A blank line, `!` or `/` leaves nothing to match.
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent - an empty pattern compiles to ^(?:.*/)?$, which only an empty path or one ending in a slash matches, and the scan asks about neither
    if (text === '') return null;
    // A slash at the start or in the middle ties the pattern to the root.
    const anchored = text.includes('/');
    text = text.replace(/^\/+/, '');

    const parts = text.split('/');
    let source = '';
    parts.forEach((part, i) => {
        const last = i === parts.length - 1;
        if (part === '**') {
            // `**/` is any number of folders, a trailing `**` everything beneath.
            source += last ? '.*' : '(?:[^/]+/)*';
            return;
        }
        source += segmentPattern(part) + (last ? '' : '/');
    });
    const prefix = anchored ? '^' : '^(?:.*/)?';
    return { negate, directoryOnly, regex: new RegExp(prefix + source + '$') };
}

export function compileIgnore(lines) {
    const rules = [];
    for (const line of lines) {
        const rule = compileLine(String(line));
        if (rule) rules.push(rule);
    }
    return {
        /** Whether this path, whose parents were not left out, is. */
        ignores(path, isDirectory) {
            let ignored = false;
            for (const rule of rules) {
                if (rule.directoryOnly && !isDirectory) continue;
                if (rule.regex.test(path)) ignored = !rule.negate;
            }
            return ignored;
        },
    };
}

/** The lines of the folder's own `.markestignore`, or none. */
export async function readIgnoreLines(root) {
    try {
        const text = await readFile(join(root, '.markestignore'), 'utf8');
        return text.split(/\r?\n/);
    } catch {
        return [];
    }
}
