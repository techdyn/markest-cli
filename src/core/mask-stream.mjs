/**
 * @module cli/core/mask-stream
 * @description Keeps secret values out of what a child process prints. `patternsFor`
 *              works out what to hide - each value, its base64 and URL-encoded
 *              forms, and for a multi-line value each line of 8 or more
 *              characters - and which values are too short (under 4 characters)
 *              to hide. `createMasker` replaces every occurrence with `[secret]`
 *              as text arrives in pieces, holding back at most the longest
 *              pattern's length minus one characters so a value split across two
 *              chunks is still found, and `maskStream` wires one to a readable
 *              stream, decoding multi-byte UTF-8 split across chunks. A guard
 *              against accidental display, not a guarantee: a program that
 *              transforms a value (reverses it, splits it) still shows it.
 *
 * @input Secret values; text or a readable stream; a write function
 * @output Patterns; masked text; a promise that settles when the stream ends
 * @dependencies node:string_decoder
 */

import { StringDecoder } from 'node:string_decoder';

export const MASK = '[secret]';
/** A value shorter than this is not masked: it would hide ordinary text. */
export const MIN_VALUE = 4;
/** A line of a multi-line value shorter than this is not masked on its own. */
export const MIN_LINE = 8;

/** What to hide for these values, longest first, and the indexes of the values too short to hide. */
export function patternsFor(values) {
    const found = new Set();
    const short = [];
    values.forEach((value, index) => {
        const text = String(value);
        if (text.length < MIN_VALUE) {
            short.push(index);
            return;
        }
        found.add(text);
        found.add(Buffer.from(text, 'utf8').toString('base64'));
        found.add(encodeURIComponent(text));
        if (/[\r\n]/.test(text)) {
            for (const line of text.split(/\r?\n/)) if (line.length >= MIN_LINE) found.add(line);
        }
    });
    return { patterns: [...found].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)), short };
}

/** The text with every pattern replaced by the mask; the longest pattern wins where they overlap. Pure. */
export function maskText(text, patterns) {
    if (patterns.length === 0) return text;
    return text.replace(expression(patterns), MASK);
}

const expression = (patterns) => new RegExp(patterns.map((one) => one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

/**
 * A masker for one stream: `push(text)` writes what is safe to write, `end()`
 * writes the rest. `write` gets masked text only.
 */
export function createMasker(patterns, write) {
    if (patterns.length === 0) {
        return { push: (text) => { if (text !== '') write(text); }, end() {} };
    }
    const hold = Math.max(...patterns.map((one) => one.length)) - 1;
    const finder = expression(patterns);
    let buffer = '';
    const emit = (text) => { if (text !== '') write(text); };
    return {
        push(text) {
            buffer += text;
            let cut = buffer.length - hold;
            if (cut <= 0) return;
            // Not inside a surrogate pair
            if (/[\ud800-\udbff]/.test(buffer[cut - 1])) cut--;
            finder.lastIndex = 0;
            let out = '';
            let done = 0;
            for (let match = finder.exec(buffer); match !== null && match.index < cut; match = finder.exec(buffer)) {
                out += buffer.slice(done, match.index) + MASK;
                done = match.index + match[0].length;
                // A match that runs past the cut is whole in the buffer: take it all
                if (done > cut) cut = done;
            }
            out += buffer.slice(done, cut);
            buffer = buffer.slice(cut);
            emit(out);
        },
        end() {
            emit(maskText(buffer, patterns));
            buffer = '';
        },
    };
}

/** Read a stream to its end through a masker, decoding UTF-8 across chunk boundaries; settles when the stream ends or fails. */
export function maskStream(stream, patterns, write) {
    const decoder = new StringDecoder('utf8');
    const masker = createMasker(patterns, write);
    return new Promise((resolve) => {
        stream.on('data', (chunk) => masker.push(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            masker.push(decoder.end());
            masker.end();
            resolve();
        };
        stream.once('end', finish);
        stream.once('error', finish);
    });
}
