/**
 * @module cli/folder-scan
 * @description The folder read as an artifact would hold it. Folders the editor
 *              never opens (hidden ones, dependency trees) are passed over unread,
 *              output folders unless asked for, and whatever `.markestignore` or
 *              `--ignore` names. Only plain files are read: no symbolic link is
 *              followed, nothing else (a pipe, a socket) is opened, and every
 *              file is looked at again just before it is read. A hidden file is
 *              never sent - `.env` and `.npmrc` are where keys live - nor one
 *              the secret guard recognises. A document is a file the editor
 *              would import, read as UTF-8 (a byte-order mark dropped, as the
 *              browser drops it); an image is one the image store keeps, with
 *              the SHA-256 of its bytes. Paths use `/`, in NFC; two that the
 *              production database would take for one (by case or accent) keep
 *              the first in natural order.
 *
 * @input The folder; ignore lines, includeOutput, allowFiles
 * @output `{ root, name, documents, images, skipped, fatal }`
 * @dependencies node:fs/promises, node:path, node:crypto, cli/shared, cli/ignore-rules, cli/secret-guard, cli/image-refs
 */

import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, basename as baseName, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS, detectContentType, extensionOf, ignoredFolder, isAcceptedFile, reviewFolder, validatePath } from '../shared.mjs';
import { compileIgnore } from './ignore-rules.mjs';
import { secretByName, secretInContent } from './secret-guard.mjs';
import { IMAGE_EXTENSIONS } from './image-refs.mjs';

export const MAX_SCAN_ENTRIES = 20000;
/** PasteImage::MAX_IMAGE_SIZE_CEILING. */
export const MAX_IMAGE_BYTES = 26214400;
/** No document may be larger than an HTML or code document's allowance, so nothing larger is read. */
// Stryker disable next-line MethodExpression: equivalent - the HTML and code allowances are both 1MB, so the larger is the smaller
export const MAX_READ_BYTES = Math.max(DEFAULT_LIMITS.maxHtmlFileSize, DEFAULT_LIMITS.maxCodeFileSize);

/** The key production's collation compares a path by: no case, no accents. */
export function foldPath(path) {
    return String(path).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural path order: folder by folder, doc2 before doc10, ties by code point. */
export function comparePaths(a, b) {
    const x = a.split('/');
    const y = b.split('/');
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const order = collator.compare(x[i], y[i]);
        if (order !== 0) return order;
    }
    if (x.length !== y.length) return x.length - y.length;
    return a < b ? -1 : a > b ? 1 : 0;
}

const decoder = () => new TextDecoder('utf-8', { fatal: true });

// Stryker disable next-line ArrayDeclaration: equivalent - both commands pass their ignore lines, and the name a mutant would allow has no extension, so no such file is read
export async function scanFolder(folder, { ignoreLines = [], includeOutput = false, allowFiles = [], maxEntries = MAX_SCAN_ENTRIES } = {}) {
    const root = resolve(folder);
    const ignore = compileIgnore(ignoreLines);
    const allowed = new Set(allowFiles.map((path) => String(path).replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC')));
    const found = [];
    const images = [];
    const skipped = [];
    const fatal = [];
    let entries = 0;

    const skip = (path, reason, code) => skipped.push(code ? { path, reason, code } : { path, reason });

    async function walk(absolute, relative) {
        let dirents;
        try {
            dirents = await readdir(absolute, { withFileTypes: true });
        } catch {
            skip(relative, 'unreadable');
            return;
        }
        // In code point order, whatever order the file system lists them in.
        // Stryker disable next-line EqualityOperator: equivalent - two names in one folder are never equal
        dirents.sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const dirent of dirents) {
            if (fatal.length > 0) return;
            if (++entries > maxEntries) {
                fatal.push({ code: 'too_many_entries', limit: maxEntries });
                return;
            }
            const path = (relative === '' ? dirent.name : relative + '/' + dirent.name).normalize('NFC');
            const onDisk = join(absolute, dirent.name);
            if (dirent.isSymbolicLink()) { skip(path, 'symlink'); continue; }
            if (dirent.isDirectory()) {
                const reason = ignoredFolder(path) ?? (includeOutput ? null : reviewFolder(path));
                if (reason) { skip(path + '/', reason); continue; }
                if (ignore.ignores(path, true)) { skip(path + '/', 'ignored'); continue; }
                await walk(onDisk, path);
                continue;
            }
            // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral,CallExpression: platform - only a Linux or macOS folder holds a pipe or a socket; Windows lists every entry as a file, a folder or a link
            if (!dirent.isFile()) { skip(path, 'special'); continue; }
            if (dirent.name.startsWith('.')) { skip(path, 'hidden'); continue; }
            if (ignore.ignores(path, false)) { skip(path, 'ignored'); continue; }
            await readEntry(onDisk, path);
        }
    }

    async function readEntry(onDisk, path) {
        let stat;
        try {
            stat = await lstat(onDisk);
        } catch {
            skip(path, 'unreadable');
            return;
        }
        // Swapped for a link, or something else, since the folder was listed.
        if (!stat.isFile()) { skip(path, 'special'); return; }
        const extension = extensionOf(path);
        const imageType = IMAGE_EXTENSIONS[extension] ?? null;
        const document = isAcceptedFile(path);
        if (imageType === null && !document) { skip(path, 'type'); return; }
        if (!allowed.has(path) && secretByName(path)) { skip(path, 'secret', 'secret_name'); return; }

        if (stat.size > MAX_IMAGE_BYTES) { skip(path, 'too_large'); return; }
        if (imageType === null && stat.size > MAX_READ_BYTES) { skip(path, 'too_large'); return; }

        let bytes;
        try {
            bytes = await readFile(onDisk);
        } catch {
            skip(path, 'unreadable');
            return;
        }
        if (imageType !== null) {
            images.push({ path, onDisk, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: imageType });
            // An image the editor imports as text too - an SVG - is a document as well, published as code when nothing shows it.
            if (!(document && bytes.length <= MAX_READ_BYTES)) return;
        }
        let content;
        try {
            content = decoder().decode(bytes);
        } catch {
            if (imageType === null) skip(path, 'not_text');
            return;
        }
        if (!allowed.has(path)) {
            const secret = secretInContent(content);
            if (secret) {
                if (imageType !== null) images.pop();
                skip(path, 'secret', secret);
                return;
            }
        }
        found.push({ path, content, bytes: bytes.length, type: detectContentType(content, path), svg: imageType !== null });
    }

    await walk(root, '');

    const documents = [];
    const seen = new Map();
    for (const doc of found.sort((a, b) => comparePaths(a.path, b.path))) {
        const check = validatePath(doc.path);
        if (!check.ok) { skip(doc.path, 'invalid_path', check.error); continue; }
        const fold = foldPath(doc.path);
        if (seen.has(fold)) { skip(doc.path, 'path_collision', seen.get(fold)); continue; }
        seen.set(fold, doc.path);
        documents.push(doc);
    }
    images.sort((a, b) => comparePaths(a.path, b.path));

    return { root, name: baseName(root), documents, images, skipped, fatal };
}
