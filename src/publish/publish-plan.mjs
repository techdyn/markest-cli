/**
 * @module cli/publish-plan
 * @description What a publish will send, decided before anything is: which
 *              document the artifact opens on and what it is called, the order
 *              of its documents, whether the folder fits the site's rules at all
 *              (the editor's own validation, with no document cap - that is the
 *              plan's, answered by the server, D-20260921-03), which images the
 *              documents show and so must go up, and, for an artifact already
 *              there, what was added, changed or removed. Requests are cut to a
 *              size a lost one costs little to repeat. Pure.
 *
 * @input The scan; the artifact as the site holds it
 * @output Choices, fatal errors, image and document plans, request batches
 * @dependencies cli/shared, cli/image-refs, cli/folder-scan
 */

import { DocumentStore, detectContentType, byteLength } from '../shared.mjs';
import { imageTargets } from './image-refs.mjs';
import { comparePaths, foldPath } from './folder-scan.mjs';

/** What one request of documents may weigh as JSON, well under the server's 64 MB. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 200;

const DEFAULT_NAMES = ['readme.md', 'readme.markdown', 'readme.txt', 'readme', 'index.md', 'index.html', 'index.htm'];

/** The document the artifact opens on: the one asked for, else the root README or index, else the first. */
export function chooseDefault(paths, wanted = null) {
    if (wanted !== null) return paths.includes(wanted) ? wanted : null;
    for (const name of DEFAULT_NAMES) {
        const hit = paths.find((path) => !path.includes('/') && path.toLowerCase() === name);
        if (hit) return hit;
    }
    return paths[0] ?? null;
}

/** A markdown document's own name for itself: front matter's title, else its first heading. */
export function headingOf(content) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
    if (front) {
        // `.+` stops at the line's end of itself, so no `$` is needed
        const title = /^title:[ \t]*(.+)/m.exec(front[1]);
        if (title) return title[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim() || null;
    }
    let fenced = false;
    for (const line of content.split(/\r?\n/)) {
        if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fenced = !fenced;
        if (fenced) continue;
        // One hash, then a space or tab and its text, or nothing. Closing hashes
        // come off only after a space or tab, as CommonMark has it - `# Learning C#`
        // keeps its hash - and a heading of nothing but them (`# #`) is empty, so
        // it names nothing.
        const heading = /^ {0,3}#(?:[ \t](.*))?$/.exec(line);
        if (heading) return (heading[1] ?? '').replace(/(?:^|[ \t])#+[ \t]*$/, '').trim() || null;
    }
    return null;
}

/** The title asked for, else the default document's heading, else the folder's name. */
export function chooseTitle(asked, defaultDoc, folderName) {
    const title = asked ?? (defaultDoc && defaultDoc.type === 'markdown' ? headingOf(defaultDoc.content) : null) ?? folderName;
    return Array.from(String(title).trim()).slice(0, MAX_TITLE_LENGTH).join('');
}

/** The default document first, then the rest in natural order. */
export function orderDocuments(documents, defaultPath) {
    return [...documents].sort((a, b) => {
        if (a.path === defaultPath) return -1;
        if (b.path === defaultPath) return 1;
        return comparePaths(a.path, b.path);
    });
}

/**
 * Split the folder's images into those the documents show - sent once per
 * distinct content - and those nothing shows. An SVG nothing shows stays a
 * document, as the editor imports it; one a document shows is an image only.
 */
export function planImages(documents, images) {
    const byPath = new Map(images.map((image) => [image.path, image]));
    const shown = new Set();
    for (const doc of documents) {
        for (const target of imageTargets(doc.content, doc.path, doc.type)) {
            if (byPath.has(target)) shown.add(target);
        }
    }
    const send = [];
    const sentHashes = new Set();
    for (const image of images) {
        if (!shown.has(image.path) || sentHashes.has(image.sha256)) continue;
        sentHashes.add(image.sha256);
        send.push(image);
    }
    return {
        send,
        shown,
        documents: documents.filter((doc) => !(doc.svg && shown.has(doc.path))),
        unshown: images.filter((image) => !shown.has(image.path) && !image.path.toLowerCase().endsWith('.svg')).map((image) => image.path),
    };
}

/** Why the folder cannot be published as it is, before anything is sent. */
export function preflight(documents, { defaultPath, fatal = [] } = {}) {
    const errors = [...fatal];
    if (documents.length === 0) {
        errors.push({ code: 'no_documents' });
        return errors;
    }
    if (defaultPath === null) errors.push({ code: 'default_missing' });
    const store = new DocumentStore({ documents: documents.map((doc) => ({ path: doc.path, content: doc.content })), limits: { maxDocs: -1 } });
    for (const error of store.validateAll()) errors.push(error);
    return errors;
}

/**
 * Local documents against the artifact's: what to add, change or keep, and what
 * is gone. A path the database would take for another only differing in case
 * or accents cannot be written beside it, so it is a conflict, not an addition.
 */
export function diffDocuments(local, remote) {
    const remoteByPath = new Map(remote.map((doc) => [doc.path, doc]));
    const remoteByFold = new Map(remote.map((doc) => [foldPath(doc.path), doc]));
    const localPaths = new Set(local.map((doc) => doc.path));
    const out = { add: [], change: [], unchanged: [], remove: [], conflicts: [] };
    for (const doc of local) {
        const there = remoteByPath.get(doc.path);
        if (there) {
            (there.content === doc.content ? out.unchanged : out.change).push(doc);
            continue;
        }
        const folded = remoteByFold.get(foldPath(doc.path));
        if (folded && !localPaths.has(folded.path)) {
            out.conflicts.push({ code: 'case_rename', path: doc.path, target: folded.path });
            continue;
        }
        out.add.push(doc);
    }
    for (const doc of remote) {
        if (!localPaths.has(doc.path) && !out.conflicts.some((conflict) => conflict.target === doc.path)) out.remove.push(doc);
    }
    return out;
}

/**
 * A document as a request sends it. A type the editor chose on purpose (one the
 * content alone would not give) is sent back, so replacing the text keeps it.
 */
export function documentPayload(doc, remote = null) {
    const payload = { path: doc.path, content: doc.content };
    if (remote && remote.content_type && remote.content_type !== detectContentType(remote.content, remote.path)) {
        payload.content_type = remote.content_type;
    }
    return payload;
}

/** Documents in requests of at most `budget` bytes of JSON each, in order. */
export function batchesOf(payloads, budget = MAX_REQUEST_BYTES) {
    const batches = [];
    let current = [];
    let size = 0;
    for (const payload of payloads) {
        const weight = byteLength(JSON.stringify(payload)) + 1;
        if (current.length > 0 && size + weight > budget) {
            batches.push(current);
            current = [];
            size = 0;
        }
        current.push(payload);
        size += weight;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}
