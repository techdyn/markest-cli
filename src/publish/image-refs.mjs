/**
 * @module cli/image-refs
 * @description The local files a document points at, found as the site will
 *              read the document: in markdown, image embeds `![alt](dest)` and
 *              reference definitions `[label]: dest`, outside fenced and inline
 *              code, read as CommonMark reads them: escapes undone, an escaped
 *              `!` a link's, a blank line (spaces, tabs, Windows line ends and
 *              all) ending a paragraph; in HTML, `src`, `srcset`, `poster`,
 *              `href` and CSS `url()`, an attribute's character references
 *              decoded. A reference is resolved as PathResolver resolves one -
 *              from the document's folder, or from the root after a leading `/` - but one
 *              climbing out of the folder resolves to nothing. Rewriting swaps
 *              the whole destination, query and fragment too, for the relative
 *              `/img/...` path the upload answered (D-20260916-09), only ever a
 *              plain path, and leaves every other byte as it was. What cannot work on the site is said
 *              instead of rewritten: a markdown link to an image, a stylesheet
 *              or script beside an HTML page, a link from one HTML page to
 *              another inside the sandboxed frame. Pure.
 *
 * @input A document's text, path and type
 * @output References with their offsets; the rewritten text; warnings
 * @dependencies cli/shared
 */

import { dirname, extensionOf, TYPE_HTML, TYPE_MARKDOWN } from '../shared.mjs';

/** Extensions of the types the image store keeps (editor/images IMAGE_TYPES). */
export const IMAGE_EXTENSIONS = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    apng: 'image/apng',
    svg: 'image/svg+xml',
};

export const isImagePath = (path) => Object.hasOwn(IMAGE_EXTENSIONS, extensionOf(path));

/**
 * A destination as a path in the folder: `{ path }`, `{ outside: true }` when it
 * climbs out of the folder, or null when it is no local file (a scheme, `//`,
 * an anchor, nothing).
 */
export function resolveReference(docPath, raw) {
    let target = String(raw ?? '').trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
    if (target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
    target = target.replace(/[?#][\s\S]*/, '');
    // Nothing, or only a query or an anchor.
    if (target === '') return null;
    try {
        target = decodeURIComponent(target);
    } catch {
        // Not percent-encoded as it should be: taken as written.
    }
    const folder = dirname(docPath);
    const parts = target.startsWith('/') || folder === '' ? [] : folder.split('/');
    for (const segment of target.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            if (parts.length === 0) return { outside: true };
            parts.pop();
            continue;
        }
        parts.push(segment);
    }
    return parts.length === 0 ? null : { path: parts.join('/').normalize('NFC') };
}

/** A code span: a run of backticks, then the same run again, on one line. */
const INLINE_CODE = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;

/** The text with every fenced block and code span blanked, offsets kept. */
export function maskMarkdownCode(text) {
    let fence = null;
    return text.split('\n').map((line) => {
        if (fence !== null) {
            // Any run will do here: one shorter than the fence that opened is refused below.
            const close = /^ {0,3}(`+|~+)[ \t]*\r?$/.exec(line);
            if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
            return ' '.repeat(line.length);
        }
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (open) {
            fence = open[1];
            return ' '.repeat(line.length);
        }
        return line.replace(INLINE_CODE, (span) => ' '.repeat(span.length));
    }).join('\n');
}

/** A line holding nothing but spaces or tabs, read from its start: the blank line that ends a paragraph. */
const BLANK_LINE = /[ \t]*\r?\n/y;

/** Whether a blank line starts at `at`. */
function blankLineAt(text, at) {
    BLANK_LINE.lastIndex = at;
    return BLANK_LINE.test(text);
}

/** Spaces and tabs with at most one line end among them: what may stand around a destination and its title. */
const SPACE = /[ \t]*(?:\r?\n[ \t]*)?/y;

/** Where the spaces at `at` end. */
function pastSpace(text, at) {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    return SPACE.lastIndex;
}

/** Whether the character at `at` is escaped: an odd run of backslashes stands before it. */
function escaped(text, at) {
    let run = 0;
    while (text[at - 1 - run] === '\\') run++;
    return run % 2 === 1;
}

/** Where the matching close bracket of the one at `open` is, or -1. */
function closeBracket(text, open) {
    let depth = 0;
    // Stryker disable next-line EqualityOperator: equivalent - past the last character there is nothing to read, and the search ends there either way
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        // A backslash escapes the next character, but never a line end: a blank line after it still ends the text.
        if (c === '\\' && text[i + 1] !== '\n') { i++; continue; }
        if (c === '\n' && blankLineAt(text, i + 1)) return -1;
        if (c === '[') depth++;
        if (c === ']' && --depth === 0) return i;
    }
    return -1;
}

/** The destination of `(dest "title")` starting at `open`: its span, or null. */
function inlineDestination(text, open) {
    let i = pastSpace(text, open + 1);
    const start = i;
    if (text[i] === '<') {
        const close = text.indexOf('>', i);
        // Stryker disable next-line ConditionalExpression,UnaryOperator: equivalent - with no '>' the read would go on from the text's start, where any span found ends before it starts and so reads as nothing
        if (close === -1) return null;
        if (text.slice(i, close).includes('\n')) return null;
        i = close + 1;
    } else {
        let depth = 0;
        // Stryker disable next-line EqualityOperator: equivalent - at the end of the text one more step finds no closing parenthesis, as stopping there does
        while (i < text.length && !/[\s\x00-\x1f]/.test(text[i])) {
            if (text[i] === '\\') { i += 2; continue; }
            if (text[i] === '(') depth++;
            if (text[i] === ')') {
                if (depth === 0) break;
                depth--;
            }
            i++;
        }
    }
    // An empty destination is returned as an empty span, which reads as nothing.
    const end = i;
    i = pastSpace(text, i);
    const quote = { '"': '"', "'": "'", '(': ')' }[text[i]];
    if (quote) {
        const close = text.indexOf(quote, i + 1);
        if (close === -1) return null;
        i = pastSpace(text, close + 1);
    }
    return text[i] === ')' ? { start, end } : null;
}

/** A markdown destination as CommonMark reads it: a backslash before ASCII punctuation escapes it. */
const unescapeDestination = (text) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');

function markdownReferences(text) {
    const masked = maskMarkdownCode(text);
    const found = [];
    for (let i = masked.indexOf('['); i !== -1; i = masked.indexOf('[', i + 1)) {
        if (escaped(masked, i)) continue;
        const close = closeBracket(masked, i);
        if (close === -1 || masked[close + 1] !== '(') continue;
        const destination = inlineDestination(masked, close + 1);
        if (destination === null) continue;
        const { start, end } = destination;
        // An escaped "!" is a "!" before a link.
        const kind = masked[i - 1] === '!' && !escaped(masked, i - 1) ? 'embed' : 'link';
        found.push({ start, end, kind, value: unescapeDestination(text.slice(start, end)) });
    }
    const definition = /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:[ \t]*(?:\r?\n[ \t]*)?(<[^>\n]*>|\S+)/dgm;
    for (const match of masked.matchAll(definition)) {
        const [start, end] = match.indices[1];
        found.push({ start, end, kind: 'definition', value: unescapeDestination(text.slice(start, end)) });
    }
    return found;
}

/** A tag with something after its name: one with nothing has no attribute to read. */
const HTML_TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)(\s[^>]*)>/g;
const HTML_ATTRIBUTE = /\s((?:xlink:)?href|src|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/dgi;
const CSS_URL = /url\(\s*(["']?)([^"')]*)\1\s*\)/dgi;
const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;
const NAMED_REFERENCES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** The kind of an HTML reference that does not show what it names: a name for the reader, since only embeds, definitions and markdown links are asked about. */
// Stryker disable next-line StringLiteral: equivalent - no kind but embed, definition and link is ever compared, so any other name reads the same
const HTML_REFERENCE = 'href';

/** An attribute value as the browser reads it: its character references decoded, past the last code point one too. */
function decodeAttribute(value) {
    return value.replace(CHARACTER_REFERENCE, (reference, hex, decimal, name) => {
        if (name !== undefined) return NAMED_REFERENCES[name];
        const code = hex !== undefined ? parseInt(hex, 16) : Number(decimal);
        return code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    });
}

function htmlReferences(text) {
    const found = [];
    for (const tag of text.matchAll(HTML_TAG)) {
        const name = tag[1].toLowerCase();
        const offset = tag.index + 1 + tag[1].length;
        for (const attribute of tag[2].matchAll(HTML_ATTRIBUTE)) {
            const group = attribute[2] !== undefined ? 2 : attribute[3] !== undefined ? 3 : 4;
            const [valueStart, valueEnd] = attribute.indices[group];
            const which = attribute[1].toLowerCase();
            if (which === 'srcset') {
                const value = attribute[group];
                for (const candidate of value.matchAll(/(?:^|,)\s*([^\s,]+)/dg)) {
                    const [s, e] = candidate.indices[1];
                    found.push({ start: offset + valueStart + s, end: offset + valueStart + e, kind: 'embed', tag: name, value: decodeAttribute(candidate[1]) });
                }
                continue;
            }
            const kind = which === 'src' || which === 'poster' ? 'embed' : HTML_REFERENCE;
            found.push({ start: offset + valueStart, end: offset + valueEnd, kind, tag: name, value: decodeAttribute(attribute[group]) });
        }
    }
    for (const match of text.matchAll(CSS_URL)) {
        const [start, end] = match.indices[2];
        found.push({ start, end, kind: 'embed' });
    }
    return found;
}

/**
 * Every local reference in a document, resolved from what its destination reads
 * as (`value`: markdown's escapes undone, an attribute's character references
 * decoded) or else, in CSS, from the text as written.
 */
export function references(content, docPath, type) {
    const found = type === TYPE_MARKDOWN ? markdownReferences(content) : type === TYPE_HTML ? htmlReferences(content) : [];
    return found
        .map((ref) => {
            const written = content.slice(ref.start, ref.end);
            const resolved = resolveReference(docPath, ref.value ?? written);
            return resolved === null ? null : { ...ref, raw: written, target: resolved.path ?? null, outside: Boolean(resolved.outside) };
        })
        .filter((ref) => ref !== null)
        .sort((a, b) => a.start - b.start);
}

/** Whether the site will show this reference as an image. */
function showsImage(ref) {
    // A reference outside the folder has no target, which is no image path.
    if (!isImagePath(ref.target)) return false;
    if (ref.kind === 'embed' || ref.kind === 'definition') return true;
    // What is left is a markdown link, which has no tag, or an `href`, which shows an
    // image only on a page's icon or an SVG <image> or <use>.
    return ref.tag === 'link' || ref.tag === 'image' || ref.tag === 'use';
}

/** The images a document shows, as paths in the folder. */
export function imageTargets(content, docPath, type) {
    return [...new Set(references(content, docPath, type).filter(showsImage).map((ref) => ref.target))];
}

/**
 * A plain relative path: nothing in it is read specially in a markdown destination,
 * an HTML attribute, quoted or not, or a CSS url(), so it is written as it is.
 */
const PLAIN_ADDRESS = /^[\w/.~%-]+$/;

/**
 * The document with each image it shows from the folder pointed at the address it
 * was given. The site answers plain `/img/...` paths; any other address leaves the
 * destination as written rather than break the markup around it.
 */
export function rewriteImageRefs(content, docPath, type, addresses) {
    let out = '';
    let at = 0;
    for (const ref of references(content, docPath, type)) {
        // A destination inside one already rewritten is left alone; one starting where it ends is not.
        if (!showsImage(ref) || !addresses.has(ref.target) || !PLAIN_ADDRESS.test(addresses.get(ref.target)) || ref.start < at) continue;
        out += content.slice(at, ref.start) + addresses.get(ref.target);
        at = ref.end;
    }
    return out + content.slice(at);
}

/** What in a document will not work once published, and why. */
export function localWarnings(content, docPath, type, sending) {
    const warnings = [];
    const warn = (code, target) => warnings.push({ code, path: docPath, target });
    for (const ref of references(content, docPath, type)) {
        if (ref.outside) { warn('outside_folder', ref.raw); continue; }
        if (showsImage(ref)) {
            if (!sending.has(ref.target)) warn('unpublished_image', ref.target);
            continue;
        }
        // Only markdown has links, and only HTML has tags.
        if (ref.kind === 'link' && isImagePath(ref.target)) warn('image_link', ref.target);
        else if ((ref.tag === 'link' && extensionOf(ref.target) === 'css') || ref.tag === 'script') warn('html_local_resource', ref.target);
        else if (ref.tag === 'a' || ref.tag === 'iframe') warn('html_page_link', ref.target);
    }
    return warnings;
}
