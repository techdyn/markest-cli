/**
 * @module editor/content-type
 * @description Client-side mirror of App\Service\ContentTypeDetector. Decides
 *              whether a document is HTML (served from the sandboxed route), code
 *              (a name code/languages recognises) or markdown/text (rendered on this
 *              origin). The file name wins when recognised; otherwise the body is
 *              sniffed - never into code - after code fences,
 *              indented blocks and inline code are stripped, so markdown that
 *              merely documents HTML is never mistaken for it.
 *
 * @input Document text and optional path
 * @output 'markdown' | 'html' | 'code'
 * @dependencies editor/paths, code/languages
 */

import { extensionOf, HTML_EXTENSIONS, TEXT_EXTENSIONS } from './paths.js';
import { languageForPath } from '../code/languages.js';

export const TYPE_MARKDOWN = 'markdown';
export const TYPE_HTML = 'html';
export const TYPE_CODE = 'code';
export const CONTENT_TYPES = [TYPE_MARKDOWN, TYPE_HTML, TYPE_CODE];

/** Characters of a body actually examined; every decisive signal is near the start. */
export const MAX_SNIFF_CHARS = 65536;

const STRUCTURAL_TAGS = new Set([
    'div', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside',
    'table', 'form', 'script', 'style', 'svg', 'canvas', 'template', 'figure',
    'ul', 'ol', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'button',
    'label', 'select', 'textarea', 'video', 'audio', 'iframe', 'picture',
]);

/** Content type implied by a recognised file name or extension, or null. */
export function detectByExtension(path) {
    // A name that means code - by its extension, or whole, as Makefile does -
    // never collides with the markdown or HTML extensions (D-20260915-19).
    if (languageForPath(path) !== null) return TYPE_CODE;
    const ext = extensionOf(path);
    if (ext === '') return null;
    if (HTML_EXTENSIONS.includes(ext)) return TYPE_HTML;
    if (TEXT_EXTENSIONS.includes(ext)) return TYPE_MARKDOWN;
    return null;
}

/**
 * Remove fenced blocks, indented code and inline code spans.
 */
export function stripCode(text) {
    let out = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    // Fenced blocks (``` or ~~~), closed or running to the end of input.
    out = out.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, '');
    // Inline code spans.
    out = out.replace(/`[^`\n]*`/g, '');
    // Indented (4-space / tab) code blocks.
    out = out.replace(/^(?: {4}|\t)[^\n]*$/gm, '');
    return out;
}

/** Line-leading markdown constructs: headings, lists, quotes, tables, link refs, rules. */
export function hasMarkdownBlockSyntax(text) {
    return /^#{1,6}\s+\S/m.test(text)
        || /^\s{0,3}[-*+]\s+\S/m.test(text)
        || /^\s{0,3}\d+[.)]\s+\S/m.test(text)
        || /^\s{0,3}>\s?\S/m.test(text)
        || /^\s{0,3}\|.*\|\s*$/m.test(text)
        || /^\s{0,3}\[[^\]]+\]:\s*\S/m.test(text)
        || /^[ \t]*(?:={3,}|-{3,})[ \t]*$/m.test(text);
}

/** Number of distinct structural element names opened in the text. */
export function countStructuralTags(text) {
    const seen = new Set();
    const re = /<\s*([a-zA-Z][a-zA-Z0-9-]*)\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const tag = m[1].toLowerCase();
        if (STRUCTURAL_TAGS.has(tag)) seen.add(tag);
    }
    return seen.size;
}

/**
 * Sniff a body with no authoritative extension. Anything not clearly an HTML
 * document stays markdown, because markdown rendering is the safe default.
 */
export function sniffContentType(text) {
    let body = String(text == null ? '' : text);
    if (body.length > MAX_SNIFF_CHARS) body = body.substring(0, MAX_SNIFF_CHARS);

    const probe = stripCode(body);
    const trimmed = probe.replace(/^\s+/, '');
    if (trimmed === '') return TYPE_MARKDOWN;

    if (/<!doctype\s+html/i.test(trimmed)) return TYPE_HTML;
    if (/<\s*(html|head|body)\b[^>]*>/i.test(trimmed)) return TYPE_HTML;

    if (trimmed.charAt(0) !== '<') return TYPE_MARKDOWN;
    if (hasMarkdownBlockSyntax(probe)) return TYPE_MARKDOWN;
    if (countStructuralTags(trimmed) < 3) return TYPE_MARKDOWN;

    return TYPE_HTML;
}

/** Detect the content type of a document; the path's extension wins when recognised. */
export function detectContentType(text, path) {
    return detectByExtension(path) ?? sniffContentType(text);
}

/** Whether a value is one of the known content types. */
export function isContentType(value) {
    return CONTENT_TYPES.includes(value);
}
