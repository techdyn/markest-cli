/**
 * @module editor/paths
 * @description Pure path helpers for the paste editor: normalisation, validation
 *              and naming rules shared by the tree, the uploader and the submit
 *              step. Mirrors App\Service\PathResolver so the client refuses
 *              exactly what the server would, and nothing the server accepts.
 *
 * @input Document path strings and single path segments
 * @output Normalised / validated path strings, error codes, booleans
 * @dependencies code/languages
 */

import { languageForPath } from '../code/languages.js';

/** In UTF-8 bytes, as PathResolver::isValidPath measures it with strlen(). */
export const MAX_PATH_LENGTH = 200;

const utf8 = new TextEncoder();
const tooLong = (text) => utf8.encode(text).length > MAX_PATH_LENGTH;

/** Extensions rendered through the markdown pipeline. */
export const TEXT_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'txt', 'text'];

/** Extensions served verbatim from the sandboxed HTML route. */
export const HTML_EXTENSIONS = ['html', 'htm', 'xhtml'];

/** Well-known files that carry no extension but are still text. */
export const EXTENSIONLESS_NAMES = [
    'LICENSE', 'VERSION', 'CHANGELOG', 'README', 'CONTRIBUTING',
    'AUTHORS', 'NOTICE', 'TODO', 'COPYING',
];

/**
 * Characters a document path may not contain. `?` and `#` would terminate the
 * viewer URL (`/p/{id}/{docPath}`); `<>:"|*` cannot be written by the ZIP
 * download on Windows; the rest are control characters.
 */
const BACKSLASH = String.fromCharCode(92);
const FORBIDDEN_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31)
    + String.fromCharCode(127) + '<>:"|?*#]');

/**
 * Collapse `.` segments, resolve `..`, drop empty segments and leading slashes,
 * and turn backslashes into slashes. Same algorithm as PathResolver::normalize.
 */
export function normalizePath(path) {
    const raw = String(path == null ? '' : path).split(BACKSLASH).join('/');
    const out = [];
    for (const part of raw.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out.join('/');
}

/**
 * Cosmetic normalisation for user input: backslashes to slashes, `.` and empty
 * segments dropped, leading slash removed — but `..` is kept so that
 * validatePath() can refuse it rather than silently resolving an escape.
 */
export function tidyPath(path) {
    const raw = String(path == null ? '' : path).trim().split(BACKSLASH).join('/');
    return raw.split('/').filter((part) => part !== '' && part !== '.').join('/');
}

/** Folder part of a path, or '' for a root-level file. */
export function dirname(path) {
    const p = String(path == null ? '' : path);
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.substring(0, i);
}

/** Last segment of a path. */
export function basename(path) {
    const p = String(path == null ? '' : path);
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.substring(i + 1);
}

/** Join a folder and a name; an empty folder yields the bare name. */
export function joinPath(dir, name) {
    const d = String(dir == null ? '' : dir).replace(/\/+$/, '');
    const n = String(name == null ? '' : name).replace(/^\/+/, '');
    if (d === '') return n;
    if (n === '') return d;
    return d + '/' + n;
}

/** Lower-cased extension without the dot, or '' when there is none. */
export function extensionOf(path) {
    const name = basename(path);
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) return '';
    return name.substring(i + 1).toLowerCase();
}

/** True when `folder` is `ancestor` itself or lies somewhere beneath it. */
export function isWithin(folder, ancestor) {
    if (ancestor === '') return true;
    return folder === ancestor || folder.startsWith(ancestor + '/');
}

/** Whether a file with this path may be imported into a paste. */
export function isAcceptedFile(path) {
    if (languageForPath(path) !== null) return true;
    const ext = extensionOf(path);
    if (TEXT_EXTENSIONS.includes(ext) || HTML_EXTENSIONS.includes(ext)) return true;
    return ext === '' && EXTENSIONLESS_NAMES.includes(basename(path).toUpperCase());
}

/**
 * Validate a full document path. Returns `{ ok, error, path }` where `error`
 * is a stable code the UI maps to a translated message, and `path` is the
 * trimmed input when valid.
 */
export function validatePath(path) {
    const trimmed = String(path == null ? '' : path).trim();
    if (trimmed === '') return fail('empty');
    if (tooLong(trimmed)) return fail('too_long');
    if (trimmed.includes(BACKSLASH)) return fail('backslash');
    if (trimmed.startsWith('/')) return fail('absolute');
    if (FORBIDDEN_CHARS.test(trimmed)) return fail('forbidden_chars');
    for (const segment of trimmed.split('/')) {
        if (segment === '..') return fail('traversal');
        if (segment === '' || segment === '.') return fail('empty_segment');
    }
    return { ok: true, error: null, path: trimmed };
}

/**
 * Validate a single file or folder name typed by the user (no slashes).
 */
export function validateName(name) {
    const trimmed = String(name == null ? '' : name).trim();
    if (trimmed === '') return fail('empty');
    if (tooLong(trimmed)) return fail('too_long');
    if (trimmed.includes('/') || trimmed.includes(BACKSLASH)) return fail('slash');
    if (trimmed === '.' || trimmed === '..') return fail('traversal');
    if (FORBIDDEN_CHARS.test(trimmed)) return fail('forbidden_chars');
    return { ok: true, error: null, path: trimmed };
}

/**
 * Give a bare name the extension its content type implies, unless it already
 * carries an accepted one or is a well-known extensionless file. A code document
 * keeps the name it was given: only its name can say which language it is, and
 * no extension means "code".
 */
export function ensureExtension(name, contentType) {
    const n = String(name == null ? '' : name).trim();
    if (n === '' || isAcceptedFile(n) || contentType === 'code') return n;
    return n + (contentType === 'html' ? '.html' : '.md');
}

/**
 * Return `path` unchanged if free, else the first `stem-2.ext`, `stem-3.ext`…
 * not present in `taken`.
 */
export function uniquePath(path, taken) {
    const has = typeof taken.has === 'function' ? (p) => taken.has(p) : (p) => taken.includes(p);
    if (!has(path)) return path;
    const dir = dirname(path);
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.substring(0, dot) : name;
    const ext = dot > 0 ? name.substring(dot) : '';
    for (let n = 2; n < 10000; n++) {
        const candidate = joinPath(dir, stem + '-' + n + ext);
        if (!has(candidate)) return candidate;
    }
    return joinPath(dir, stem + '-' + Date.now() + ext);
}

function fail(code) {
    return { ok: false, error: code, path: null };
}
