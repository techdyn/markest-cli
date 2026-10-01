/**
 * @module cli/core/output
 * @description How every command answers. Exit codes each mean one thing: 0
 *              done, 1 failed or done only in part, 2 asked wrongly, 3 waiting
 *              for the account holder to confirm in a browser, 4 refused as it
 *              stands with nothing sent. Read by a person, what a script would
 *              capture goes to stdout and everything else to stderr; with
 *              `--json`, stdout is one object. File names and the site's words
 *              reach a terminal without their control characters. Pure.
 *
 * @input Values to print
 * @output Exit codes; text; one line of JSON
 * @dependencies None
 */

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, AWAITING_APPROVAL: 3, REFUSED: 4 });

/** Text safe to print: no escape sequences, no other control characters. */
export function printable(text) {
    return String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** One value as one line of JSON. */
export function jsonLine(value) {
    return JSON.stringify(value) + '\n';
}

/**
 * Rows as aligned columns, each cell made printable and kept to one line, and
 * no line ending in spaces.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {Array<{key: string, label: string}>} columns
 */
export function table(rows, columns) {
    const cell = (value) => printable(value).replace(/[\r\n\t]+/g, ' ');
    const lines = [columns.map((column) => column.label), ...rows.map((row) => columns.map((column) => cell(row[column.key])))];
    const widths = columns.map((_, i) => Math.max(...lines.map((line) => Array.from(line[i]).length)));
    return lines.map((line) => line.map((text, i) => text + ' '.repeat(widths[i] - Array.from(text).length)).join('  ').trimEnd() + '\n').join('');
}
