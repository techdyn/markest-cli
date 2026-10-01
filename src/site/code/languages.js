/**
 * @module code/languages
 * @description Which documents are code, and in which language, by file name -
 *              and which highlight.js language a fenced block's class names. Reads
 *              config/code_languages.json, the table App\Service\CodeLanguages
 *              reads on the server, so both give the same answer for every name
 *              (tests/fixtures/code-language-cases.json holds them to it). A whole
 *              file name (Makefile, CMakeLists.txt) is looked up before the
 *              extension (D-20260915-19).
 *
 * @input A document path, or a language id or alias
 * @output A highlight.js language id or null; display names; the languages one embeds
 * @dependencies config/code_languages.json
 */

import table from '../../../config/code_languages.json' with { type: 'json' };

/** The language of a code document whose name names none. */
export const PLAIN_TEXT = 'plaintext';

/** Lower-case id or alias -> id. Ids win over another language's alias. */
const byName = new Map();
for (const id of Object.keys(table.languages)) byName.set(id.toLowerCase(), id);
for (const [id, language] of Object.entries(table.languages)) {
    for (const alias of language.aliases) {
        if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), id);
    }
}

function basename(path) {
    const p = String(path);
    return p.substring(p.lastIndexOf('/') + 1);
}

/** Lower-case extension without the dot; ".bashrc" and "notes." have none. */
export function extensionOf(path) {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return '';
    return name.substring(dot + 1).toLowerCase();
}

/** The language a document's name says it is written in, or null when it names none. */
export function languageForPath(path) {
    if (path == null) return null;
    const name = basename(path);
    if (name === '') return null;
    const whole = name.toLowerCase();
    if (Object.hasOwn(table.filenames, whole)) return table.filenames[whole];
    const extension = extensionOf(name);
    return extension !== '' && Object.hasOwn(table.extensions, extension) ? table.extensions[extension] : null;
}

/** The language id a block's `language-*` class names, by id or alias, or null. */
export function resolveLanguage(name) {
    return byName.get(String(name ?? '').toLowerCase()) ?? null;
}

/** A language's display name; an unknown id is its own name. */
export function nameOf(id) {
    return Object.hasOwn(table.languages, id) ? table.languages[id].name : String(id);
}

/** The language and every language it embeds, directly or not, each once - itself first. */
export function languageClosure(id) {
    if (!Object.hasOwn(table.languages, id)) return [];
    const order = [];
    const queue = [id];
    const seen = new Set(queue);
    while (queue.length > 0) {
        const next = queue.shift();
        order.push(next);
        for (const other of table.languages[next].requires) {
            if (!seen.has(other)) {
                seen.add(other);
                queue.push(other);
            }
        }
    }
    return order;
}
