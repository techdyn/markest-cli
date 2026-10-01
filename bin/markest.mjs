#!/usr/bin/env node
/**
 * @module cli/bin/markest
 * @description The tool's entry: `markest <command>`. Inside the site's
 *              repository the editor's modules it reuses sit under a
 *              package.json that names no module type, so Node warns once on
 *              loading them; that one warning, and Node 20's note that JSON
 *              modules are experimental, are dropped before anything is
 *              imported. Everything else is main's.
 *
 * @input process.argv, the environment, stdin
 * @output What the command prints; process.exitCode
 * @dependencies cli/src/main
 */

const QUIET = new Set(['MODULE_TYPELESS_PACKAGE_JSON']);
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
    const options = rest[0] !== null && typeof rest[0] === 'object' ? rest[0] : { type: rest[0], code: rest[1] };
    const text = String(warning && warning.message ? warning.message : warning);
    if (QUIET.has(options.code) || QUIET.has(warning && warning.code)) return;
    if (options.type === 'ExperimentalWarning' && /JSON module/i.test(text)) return;
    return emitWarning.call(process, warning, ...rest);
};

const { main } = await import('../src/main.mjs');
process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
});
