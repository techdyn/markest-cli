/**
 * @module editor/store
 * @description The editor's single source of truth for a paste's documents.
 *              Holds an ordered document list (array order *is* the saved sort
 *              order), the set of folders that exist independently of any file,
 *              the active document and the default document, and implements
 *              every structural operation — create, rename, move, reorder,
 *              folder rename/move/delete, bulk import — with the same path and
 *              size rules the server enforces, so a save the client accepts is
 *              a save the server accepts. Pure: no DOM, no network.
 *
 * @input Document records, structural commands
 * @output Mutated state plus change notifications; a tree for rendering
 * @dependencies editor/paths, editor/content-type
 */

import {
    normalizePath, tidyPath, dirname, basename, joinPath, isWithin,
    validatePath, validateName, uniquePath,
} from './paths.js';
import { detectContentType, isContentType, TYPE_CODE, TYPE_HTML, TYPE_MARKDOWN } from './content-type.js';

/** Server limits (see App\Entity\Paste and App\Entity\PasteDocument). */
export const DEFAULT_LIMITS = {
    maxDocs: 50,
    maxFileSize: 524288,
    maxHtmlFileSize: 1048576,
    maxCodeFileSize: 1048576,
    maxTotalSize: 52428800,
    maxTotalSizeHtml: 52428800,
};

const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** Byte length of a string as the server will measure it. */
export function byteLength(text) {
    const s = String(text == null ? '' : text);
    if (utf8) return utf8.encode(s).length;
    return Buffer.byteLength(s, 'utf8');
}

function ok(extra) {
    return Object.assign({ ok: true, error: null }, extra || {});
}

function fail(code, extra) {
    return Object.assign({ ok: false, error: code }, extra || {});
}

export class DocumentStore {
    /**
     * @param {object} [options]
     * @param {Array<{path:string,title?:string,content?:string,contentType?:string}>} [options.documents]
     * @param {string} [options.defaultPath]
     * @param {object} [options.limits] Overrides for DEFAULT_LIMITS
     */
    constructor(options = {}) {
        this.limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});
        // Plans use -1 for unlimited; comparisons and the file reader use Infinity.
        if (this.limits.maxDocs === -1) this.limits.maxDocs = Infinity;
        this.docs = [];
        this.folders = new Set();
        this.activeIndex = -1;
        this.defaultPath = '';
        this.dirty = false;
        this.revision = 0;
        this.listeners = new Set();

        for (const raw of options.documents || []) {
            this.docs.push(this.makeDoc(raw));
        }
        if (this.docs.length === 0) {
            this.docs.push(this.placeholderDoc());
        }
        const wanted = tidyPath(options.defaultPath || '');
        this.defaultPath = this.hasPath(wanted) ? wanted : '';
        this.activeIndex = 0;
    }

    // ─── Notifications ────────────────────────────────────────────────

    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(type, detail = {}) {
        for (const fn of this.listeners) fn(type, detail, this);
    }

    touch(type, detail) {
        this.dirty = true;
        this.revision++;
        this.emit(type, detail);
    }

    markClean() {
        this.dirty = false;
        this.emit('clean');
    }

    // ─── Records ──────────────────────────────────────────────────────

    makeDoc(raw) {
        const path = normalizePath(raw.path || '');
        const content = String(raw.content == null ? '' : raw.content);
        const stored = isContentType(raw.contentType) ? raw.contentType : null;
        // A stored type that disagrees with detection was a deliberate choice
        // and must survive; one that agrees can keep floating with the content.
        const override = stored !== null && stored !== detectContentType(content, path) ? stored : null;
        return {
            path,
            title: String(raw.title == null ? '' : raw.title),
            content,
            typeOverride: override,
            placeholder: false,
        };
    }

    /**
     * The blank README.md an empty paste starts with. It exists only so the
     * editor has something to show; the first import supersedes it rather
     * than sitting beside it as a second, empty document.
     */
    placeholderDoc() {
        return Object.assign(this.makeDoc({ path: 'README.md' }), { placeholder: true });
    }

    /** Index of the untouched placeholder, or -1. */
    placeholderIndex() {
        return this.docs.findIndex((d) => d.placeholder && d.content === '');
    }

    count() {
        return this.docs.length;
    }

    get(index) {
        return this.docs[index] || null;
    }

    active() {
        return this.get(this.activeIndex);
    }

    paths() {
        return this.docs.map((d) => d.path);
    }

    indexOf(path) {
        return this.docs.findIndex((d) => d.path === path);
    }

    hasPath(path, exceptIndex = -1) {
        return this.docs.some((d, i) => i !== exceptIndex && d.path === path);
    }

    /** Effective content type: the user's override, else detection. */
    typeOf(index) {
        const doc = this.get(index);
        if (!doc) return TYPE_MARKDOWN;
        return doc.typeOverride || detectContentType(doc.content, doc.path);
    }

    isTypeOverridden(index) {
        const doc = this.get(index);
        return !!(doc && doc.typeOverride);
    }

    // ─── Folders ──────────────────────────────────────────────────────

    /** Every folder path, from documents and explicit folders, sorted. */
    folderPaths() {
        const set = new Set(this.folders);
        for (const doc of this.docs) {
            let dir = dirname(doc.path);
            while (dir !== '') {
                set.add(dir);
                dir = dirname(dir);
            }
        }
        return Array.from(set).sort();
    }

    hasFolder(path) {
        if (path === '') return true;
        return this.folderPaths().includes(path);
    }

    isEmptyFolder(path) {
        return !this.docs.some((d) => isWithin(dirname(d.path), path));
    }

    /**
     * Tree for rendering. Folders are sorted by name; files keep array order.
     * @returns {{folders: Map<string, object>, files: Array<{doc, index}>, path: string}}
     */
    tree() {
        const root = { path: '', folders: new Map(), files: [] };
        const nodeFor = (folderPath) => {
            if (folderPath === '') return root;
            let node = root;
            let acc = '';
            for (const part of folderPath.split('/')) {
                acc = joinPath(acc, part);
                if (!node.folders.has(part)) {
                    node.folders.set(part, { path: acc, folders: new Map(), files: [] });
                }
                node = node.folders.get(part);
            }
            return node;
        };
        for (const folder of this.folderPaths()) nodeFor(folder);
        this.docs.forEach((doc, index) => {
            nodeFor(dirname(doc.path)).files.push({ doc, index });
        });
        const sortFolders = (node) => {
            node.folders = new Map(Array.from(node.folders.entries()).sort((a, b) => a[0].localeCompare(b[0])));
            for (const child of node.folders.values()) sortFolders(child);
        };
        sortFolders(root);
        return root;
    }

    // ─── Selection / defaults ─────────────────────────────────────────

    setActive(index) {
        if (index < 0 || index >= this.docs.length || index === this.activeIndex) return false;
        this.activeIndex = index;
        this.emit('select', { index });
        return true;
    }

    setDefault(path) {
        const next = path === null || path === undefined ? '' : normalizePath(path);
        if (next !== '' && !this.hasPath(next)) return fail('not_found');
        if (next === this.defaultPath) return ok();
        this.defaultPath = next;
        this.touch('default', { path: next });
        return ok();
    }

    // ─── Document operations ──────────────────────────────────────────

    /**
     * Add a document. `path` is normalised and validated; a clash yields
     * `duplicate` unless `unique` is set, in which case a free name is chosen.
     */
    add(raw, options = {}) {
        if (this.docs.length >= this.limits.maxDocs) return fail('max_docs');
        const check = validatePath(tidyPath(raw.path || ''));
        if (!check.ok) return fail(check.error);
        let path = check.path;
        if (this.hasPath(path)) {
            if (!options.unique) return fail('duplicate');
            path = uniquePath(path, new Set(this.paths()));
        }
        const doc = this.makeDoc(Object.assign({}, raw, { path }));
        this.docs.push(doc);
        const index = this.docs.length - 1;
        this.touch('add', { index });
        if (options.select !== false) this.setActive(index);
        return ok({ index, path });
    }

    remove(index) {
        const doc = this.get(index);
        if (!doc) return fail('not_found');
        if (this.docs.length <= 1) return fail('last_document');
        this.docs.splice(index, 1);
        if (this.defaultPath === doc.path) this.defaultPath = '';
        if (this.activeIndex > index) this.activeIndex -= 1;
        else if (this.activeIndex === index) this.activeIndex = Math.min(index, this.docs.length - 1);
        this.touch('remove', { index, path: doc.path });
        this.emit('select', { index: this.activeIndex });
        return ok();
    }

    setContent(index, content) {
        const doc = this.get(index);
        if (!doc) return fail('not_found');
        const next = String(content == null ? '' : content);
        if (next === doc.content) return ok();
        doc.content = next;
        if (next !== '') doc.placeholder = false;
        this.touch('content', { index });
        return ok();
    }

    setTitle(index, title) {
        const doc = this.get(index);
        if (!doc) return fail('not_found');
        doc.title = String(title == null ? '' : title);
        this.touch('title', { index });
        return ok();
    }

    /** Pin or unpin (null) the content type of a document. */
    setTypeOverride(index, type) {
        const doc = this.get(index);
        if (!doc) return fail('not_found');
        if (type !== null && !isContentType(type)) return fail('invalid_type');
        doc.typeOverride = type;
        this.touch('type', { index });
        return ok();
    }

    /** Rename or move a single document to a full new path. */
    rename(index, newPath) {
        const doc = this.get(index);
        if (!doc) return fail('not_found');
        const check = validatePath(tidyPath(newPath));
        if (!check.ok) return fail(check.error);
        if (check.path === doc.path) return ok({ path: doc.path });
        if (this.hasPath(check.path, index)) return fail('duplicate');
        const oldPath = doc.path;
        doc.path = check.path;
        doc.placeholder = false;
        if (this.defaultPath === oldPath) this.defaultPath = check.path;
        this.touch('rename', { index, from: oldPath, to: check.path });
        return ok({ path: check.path });
    }

    /** Move a document into a folder, keeping its filename. */
    moveToFolder(index, folder) {
        const doc = this.get(index);
        if (!doc) return fail('not_found');
        const target = tidyPath(folder || '');
        if (dirname(doc.path) === target) return ok({ path: doc.path, unchanged: true });
        return this.rename(index, joinPath(target, basename(doc.path)));
    }

    /**
     * Reorder: place document `from` immediately before (`after` = false) or
     * after the document at `target`, adopting the target's folder.
     */
    reorder(from, target, after = false) {
        const src = this.get(from);
        const dst = this.get(target);
        if (!src || !dst) return fail('not_found');
        if (from === target) return ok({ unchanged: true });

        const targetFolder = dirname(dst.path);
        if (dirname(src.path) !== targetFolder) {
            const newPath = joinPath(targetFolder, basename(src.path));
            if (this.hasPath(newPath, from)) return fail('duplicate');
            if (this.defaultPath === src.path) this.defaultPath = newPath;
            src.path = newPath;
        }

        const active = this.active();
        this.docs.splice(from, 1);
        let insertAt = this.docs.indexOf(dst);
        if (after) insertAt += 1;
        this.docs.splice(insertAt, 0, src);
        this.activeIndex = this.docs.indexOf(active);
        this.touch('reorder', { from, to: insertAt });
        return ok({ index: insertAt });
    }

    // ─── Folder operations ────────────────────────────────────────────

    /** Create an explicit (possibly empty) folder. */
    addFolder(path) {
        const check = validatePath(tidyPath(path));
        if (!check.ok) return fail(check.error);
        if (this.hasFolder(check.path)) return fail('folder_exists');
        if (this.hasPath(check.path)) return fail('file_exists');
        this.folders.add(check.path);
        this.touch('folder-add', { path: check.path });
        return ok({ path: check.path });
    }

    /** Rename the last segment of a folder, re-pathing everything beneath it. */
    renameFolder(path, newName) {
        const check = validateName(newName);
        if (!check.ok) return fail(check.error);
        const newPath = joinPath(dirname(path), check.path);
        return this.relocateFolder(path, newPath, 'folder-rename');
    }

    /** Move a folder (and everything in it) into another folder or to root (''). */
    moveFolder(path, targetFolder) {
        const target = tidyPath(targetFolder || '');
        if (target === path || isWithin(target, path)) return fail('into_itself');
        const newPath = joinPath(target, basename(path));
        if (newPath === path) return ok({ path, unchanged: true });
        return this.relocateFolder(path, newPath, 'folder-move');
    }

    relocateFolder(oldPath, newPath, eventType) {
        if (!this.hasFolder(oldPath) || oldPath === '') return fail('not_found');
        if (newPath === oldPath) return ok({ path: oldPath, unchanged: true });
        const check = validatePath(newPath);
        if (!check.ok) return fail(check.error);
        if (this.hasFolder(newPath) || this.hasPath(newPath)) return fail('folder_exists');

        // Every document that moves must land on a free path.
        const moving = [];
        for (let i = 0; i < this.docs.length; i++) {
            const doc = this.docs[i];
            if (isWithin(dirname(doc.path), oldPath)) {
                const to = newPath + doc.path.substring(oldPath.length);
                if (this.hasPath(to)) return fail('duplicate', { path: to });
                if (to.length > 200) return fail('too_long', { path: to });
                moving.push([doc, to]);
            }
        }
        for (const [doc, to] of moving) {
            if (this.defaultPath === doc.path) this.defaultPath = to;
            doc.path = to;
        }
        const folders = Array.from(this.folders);
        this.folders.clear();
        for (const f of folders) {
            this.folders.add(isWithin(f, oldPath) ? newPath + f.substring(oldPath.length) : f);
        }
        this.folders.add(newPath);
        this.touch(eventType, { from: oldPath, to: newPath, moved: moving.length });
        return ok({ path: newPath, moved: moving.length });
    }

    /** Delete a folder and every document in it. A paste keeps at least one document. */
    deleteFolder(path) {
        if (!this.hasFolder(path) || path === '') return fail('not_found');
        const active = this.active();
        const removed = this.docs.filter((d) => isWithin(dirname(d.path), path));
        this.docs = this.docs.filter((d) => !isWithin(dirname(d.path), path));
        for (const f of Array.from(this.folders)) {
            if (isWithin(f, path)) this.folders.delete(f);
        }
        if (removed.some((d) => d.path === this.defaultPath)) this.defaultPath = '';
        if (this.docs.length === 0) this.docs.push(this.placeholderDoc());
        const idx = this.docs.indexOf(active);
        this.activeIndex = idx === -1 ? 0 : idx;
        this.touch('folder-delete', { path, removed: removed.length });
        this.emit('select', { index: this.activeIndex });
        return ok({ removed: removed.length });
    }

    // ─── Bulk import ──────────────────────────────────────────────────

    /**
     * Import read files. Each entry is `{ path, content }` relative to
     * `targetFolder`. Existing blank documents are filled; existing non-blank
     * ones are replaced only when `replace` is set, else reported.
     */
    importFiles(entries, options = {}) {
        const target = tidyPath(options.targetFolder || '');
        const replace = !!options.replace;
        const result = { added: [], replaced: [], filled: [], existing: [], invalid: [], overflow: [] };

        for (const entry of entries) {
            // The entry path is relative to the target folder and may never
            // climb out of it, whatever a crafted DataTransfer claims.
            const check = validatePath(joinPath(target, tidyPath(entry.path)));
            if (!check.ok) {
                result.invalid.push({ path: entry.path, error: check.error });
                continue;
            }
            const path = check.path;
            const existing = this.indexOf(path);
            const content = String(entry.content == null ? '' : entry.content);
            if (existing !== -1) {
                const doc = this.docs[existing];
                if (doc.content.trim() === '') {
                    doc.content = content;
                    doc.typeOverride = null;
                    result.filled.push(existing);
                } else if (replace) {
                    doc.content = content;
                    doc.typeOverride = null;
                    result.replaced.push(existing);
                } else {
                    result.existing.push(path);
                }
                continue;
            }
            if (this.docs.length >= this.limits.maxDocs) {
                result.overflow.push(path);
                continue;
            }
            this.docs.push(this.makeDoc({ path, content }));
            result.added.push(this.docs.length - 1);
        }

        // Folders the import touched become explicit so they render even if
        // later emptied, and the tree expands to show what arrived.
        for (const i of result.added) {
            let dir = dirname(this.docs[i].path);
            while (dir !== '') {
                this.folders.add(dir);
                dir = dirname(dir);
            }
        }

        // An import into an empty paste replaces the blank README.md the
        // editor started with instead of leaving it there as a second file.
        if (result.added.length > 0) this.dropSupersededPlaceholder(result);

        const changed = result.added.length + result.replaced.length + result.filled.length;
        if (changed > 0) this.touch('import', result);
        return Object.assign(ok(), result, { changed });
    }

    dropSupersededPlaceholder(result) {
        const at = this.placeholderIndex();
        if (at === -1 || this.docs.length < 2) return;
        if (result.filled.includes(at) || result.replaced.includes(at)) return;

        const doc = this.docs[at];
        this.docs.splice(at, 1);
        if (this.defaultPath === doc.path) this.defaultPath = '';
        const shift = (i) => (i > at ? i - 1 : i);
        result.added = result.added.map(shift);
        result.filled = result.filled.map(shift);
        result.replaced = result.replaced.map(shift);
        if (this.activeIndex > at) this.activeIndex -= 1;
        else if (this.activeIndex === at) this.activeIndex = Math.min(at, this.docs.length - 1);
        result.placeholderDropped = doc.path;
    }

    // ─── Validation / serialisation ───────────────────────────────────

    /** Total bytes and whether any document is HTML. */
    stats() {
        let bytes = 0;
        let hasHtml = false;
        this.docs.forEach((doc, i) => {
            bytes += byteLength(doc.content);
            if (this.typeOf(i) === TYPE_HTML) hasHtml = true;
        });
        return { count: this.docs.length, bytes, hasHtml };
    }

    /** The largest a document of this type may be; mirrors PasteDocument::sizeLimitFor. */
    sizeLimitFor(type) {
        if (type === TYPE_HTML) return this.limits.maxHtmlFileSize;
        if (type === TYPE_CODE) return this.limits.maxCodeFileSize ?? this.limits.maxHtmlFileSize;
        return this.limits.maxFileSize;
    }

    /**
     * Mirror of PasteService::validate. Returns `[{ code, path?, limit? }]`.
     */
    validateAll() {
        const errors = [];
        const seen = new Set();
        if (this.docs.length === 0) errors.push({ code: 'no_documents' });
        if (this.docs.length > this.limits.maxDocs) errors.push({ code: 'max_docs', limit: this.limits.maxDocs });

        let total = 0;
        let hasLarge = false;
        this.docs.forEach((doc, i) => {
            const check = validatePath(doc.path);
            if (!check.ok) errors.push({ code: 'path_' + check.error, path: doc.path, index: i });
            const norm = normalizePath(doc.path);
            if (seen.has(norm)) errors.push({ code: 'duplicate', path: norm, index: i });
            seen.add(norm);

            const type = this.typeOf(i);
            // HTML and code documents may be larger, and so may a paste holding one.
            hasLarge = hasLarge || type !== TYPE_MARKDOWN;
            const size = byteLength(doc.content);
            const limit = this.sizeLimitFor(type);
            if (size > limit) errors.push({ code: 'file_size', path: doc.path, index: i, limit, size });
            total += size;
        });
        const totalLimit = hasLarge ? this.limits.maxTotalSizeHtml : this.limits.maxTotalSize;
        if (total > totalLimit) errors.push({ code: 'total_size', limit: totalLimit, size: total });
        return errors;
    }

    /** Plain records in saved order, with the effective content type. */
    /**
     * Every document replaced at once: a merge settled, or the newer version
     * taken. The open document and the default stay where
     * their paths still are.
     */
    replaceAll(documents) {
        const activePath = this.active() ? this.active().path : '';
        this.docs = (documents || []).map((raw) => this.makeDoc(raw));
        if (this.docs.length === 0) this.docs.push(this.placeholderDoc());
        if (!this.hasPath(this.defaultPath)) this.defaultPath = '';
        const at = this.indexOf(activePath);
        this.activeIndex = at >= 0 ? at : 0;
        this.touch('replace');
    }

    serialize() {
        return this.docs.map((doc, i) => ({
            path: doc.path,
            title: doc.title,
            content: doc.content,
            contentType: this.typeOf(i),
        }));
    }
}
