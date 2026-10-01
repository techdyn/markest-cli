/**
 * @module cli/reading/folder-writer
 * @description An artifact's documents written into a folder, each at its path.
 *              A path comes from the site, so it is held to the site's own rules
 *              before anything is written - no `..`, no leading `/`, no
 *              backslash, no control character - and to the folder: one that
 *              would land outside it is refused, whatever the rules said. A file
 *              already there is left alone unless `force`, and nothing is
 *              written when any path is refused. No link is followed: a link
 *              where a document would go is refused too.
 *
 * @input The folder; `[{ path, content }]`; `{ force }`
 * @output `{ written, refused }`
 * @dependencies node:fs/promises, node:path, cli/shared
 */

import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { validatePath } from '../shared.mjs';

/** Where a document goes, or why it may not go anywhere. */
export function placeFor(root, path) {
    const check = validatePath(path);
    if (!check.ok) return { error: check.error };
    const base = resolve(root);
    const target = resolve(base, ...check.path.split('/'));
    // Defence in depth, unreachable today: validatePath already refuses every path that could leave the folder,
    // and this stays so a change to the site's rules can never open one
    // Stryker disable next-line ConditionalExpression,StringLiteral,ObjectLiteral: unreachable while validatePath refuses traversal
    if (!target.startsWith(base + sep)) return { error: 'outside_folder' };
    return { target, base };
}

async function existing(target) {
    // Stryker disable next-line ArrowFunction: equivalent - nothing there is falsy either way
    return lstat(target).catch(() => null);
}

/** Whether a folder on the way from the root to the document is a link, which could lead anywhere. */
async function throughLink(base, target) {
    for (let dir = dirname(target); dir.startsWith(base + sep); dir = dirname(dir)) {
        const there = await existing(dir);
        if (there && !there.isDirectory()) return true;
    }
    return false;
}

export async function writeDocuments(root, documents, { force = false } = {}) {
    const refused = [];
    const planned = [];
    for (const doc of documents) {
        const place = placeFor(root, doc.path);
        if (place.error) {
            refused.push({ path: doc.path, reason: place.error });
            continue;
        }
        const there = await existing(place.target);
        if (await throughLink(place.base, place.target)) refused.push({ path: doc.path, reason: 'through_link' });
        else if (there && (there.isSymbolicLink() || !there.isFile())) refused.push({ path: doc.path, reason: 'not_a_file' });
        else if (there && !force) refused.push({ path: doc.path, reason: 'exists' });
        else planned.push({ ...doc, target: place.target });
    }
    if (refused.length > 0) return { written: [], refused };
    for (const doc of planned) {
        await mkdir(dirname(doc.target), { recursive: true });
        // Stryker disable next-line StringLiteral: equivalent - utf8 is writeFile's own default for text
        await writeFile(doc.target, doc.content, 'utf8');
    }
    return { written: planned.map((doc) => doc.path), refused };
}
