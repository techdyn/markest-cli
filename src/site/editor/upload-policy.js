/**
 * @module editor/upload-policy
 * @description Classifies selected paths before reading: ignored folder trees, supported documents and reviewable output.
 * @input File/path entries, optional confirmation for ambiguous output folders
 * @output Importable entries and grouped skipped-folder records (no file content reads)
 * @dependencies editor/paths
 */
import { isAcceptedFile, validatePath } from './paths.js';

const GENERATED = new Set(['node_modules', '__pycache__', '__macosx']);
const REVIEW = new Set(['build', 'dist', 'vendor', 'coverage', 'target']);

/** Only directory segments are tested. Dotfiles chosen individually retain the normal file-type rules. */
export function ignoredFolder(path) {
    const name = path.split('/').at(-1).toLowerCase();
    if (name.startsWith('.') && name !== '.' && name !== '..') return 'hidden';
    return GENERATED.has(name) ? 'generated' : null;
}

/** A folder that usually holds generated output, which is read only when asked for. */
export function reviewFolder(path) {
    return REVIEW.has(path.split('/').at(-1).toLowerCase()) ? 'output' : null;
}

export function skippedFolder(path, skipReason) {
    return { path: path.replace(/\/$/, '') + '/', file: { size: 0 }, kind: 'folder', skipReason };
}

function directories(path) {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

export function prepareImports(entries, { confirm = () => false } = {}) {
    const ignored = new Map();
    const candidates = [];
    const failures = [];
    const output = new Map();
    const skip = (path, reason) => ignored.set(path, skippedFolder(path, reason));
    for (const entry of entries) {
        if (entry.errorReason) { failures.push(entry); continue; }
        if (entry.kind === 'folder' && entry.skipReason) { skip(entry.path.replace(/\/$/, ''), entry.skipReason); continue; }
        // Invalid paths must reach the existing path validator rather than disappear as noise.
        if (!validatePath(entry.path).ok) { candidates.push(entry); continue; }
        const dirs = directories(entry.path);
        const hidden = dirs.find(dir => ignoredFolder(dir));
        if (hidden) { skip(hidden, ignoredFolder(hidden)); continue; }
        const review = dirs.find(dir => reviewFolder(dir));
        if (review && isAcceptedFile(entry.path)) output.set(entry, review);
        candidates.push(entry);
    }
    const folders = [...new Set(output.values())];
    const includeOutput = output.size > 0 && confirm({ count: output.size, folders });
    const accepted = [];
    for (const entry of candidates) {
        const dir = output.get(entry);
        if (dir && !includeOutput) skip(dir, 'generated');
        else accepted.push(entry);
    }
    const supportedDirs = new Set();
    for (const entry of accepted) {
        if (validatePath(entry.path).ok && isAcceptedFile(entry.path)) for (const dir of directories(entry.path)) supportedDirs.add(dir);
    }
    const result = [];
    for (const entry of accepted) {
        if (!validatePath(entry.path).ok || isAcceptedFile(entry.path)) { result.push(entry); continue; }
        const dirs = directories(entry.path);
        // A declined output folder's unsupported files belong to the same skipped record.
        if (dirs.some(dir => ignored.has(dir))) continue;
        const irrelevant = dirs.find(dir => !supportedDirs.has(dir));
        if (irrelevant) skip(irrelevant, 'irrelevant');
        else result.push({ ...entry, file: { size: entry.file.size }, skipReason: 'type' });
    }
    // If an entire root is irrelevant, one record represents it rather than every subfolder.
    for (const [path, entry] of ignored) {
        if (!directories(path).some(parent => ignored.has(parent))) result.push(entry);
    }
    return [...result, ...failures];
}
