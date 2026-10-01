#!/usr/bin/env node
/**
 * @module cli/scripts/mutate
 * @description The package's mutation testing (TICP 2.1), with Stryker: each
 *              group of modules mutated against the tests that are its own, so a
 *              mutant runs a few seconds of tests rather than the whole suite -
 *              the narrowing TICP asks for. The scores are then held to their
 *              thresholds: every critical module - the keys, sealing, what is
 *              written to disk, what keeps a key out of a message - at least 80,
 *              every other module at least 60, and the package as a whole at
 *              least 60. A group named on the command line runs alone; the
 *              reports are in reports/mutation/. Each mutant's tests end
 *              themselves, and run with a home of their own, never the
 *              account holder's profile, key or key store.
 *
 * @input Group names, or none for every group
 * @output A report per group and a summary; exit 1 below a threshold
 * @dependencies node:child_process, node:fs/promises, node:path, node:url, @stryker-mutator/core
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STRYKER = join(ROOT, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');

/** Each group's modules and the tests that are theirs. */
export const GROUPS = {
    core: { mutate: ['src/core/*.mjs', 'src/main.mjs', 'src/commands/registry.mjs'], tests: ['api-client', 'agent-client', 'command-kit', 'output', 'site-args', 'main', 'registry'] },
    publish: {
        mutate: ['src/publish/*.mjs', 'src/commands/publish.mjs', '!src/publish/sealed-publish.mjs'],
        tests: ['folder-scan', 'ignore-rules', 'image-refs', 'publish-plan', 'publish-run', 'publish-report', 'publish-steps', 'secret-guard', 'publish', 'sealed-publish', 'registry'],
    },
    reading: { mutate: ['src/reading/*.mjs', 'src/commands/reading.mjs'], tests: ['artifact-source', 'folder-writer', 'reading', 'sealed-reading', 'registry'] },
    sealed: {
        mutate: ['src/sealed/*.mjs', 'src/publish/sealed-publish.mjs', 'src/commands/keys.mjs'],
        tests: ['keyring', 'sealing', 'link-key', 'sealed-artifacts', 'keys', 'sealed-publish', 'sealed-reading', 'shared', 'registry'],
    },
    commands: {
        mutate: ['src/commands/{artifacts,settings,images,history,conversation,sharing,search,tools,draft}.mjs'],
        tests: ['artifacts', 'settings', 'images', 'history', 'conversation', 'sharing', 'search', 'tools', 'draft', 'registry'],
    },
    mcp: { mutate: ['src/mcp/*.mjs', 'src/commands/mcp.mjs'], tests: ['json-rpc', 'stdio', 'sealed-tools', 'mcp', 'registry'] },
};

/** Modules whose mistakes cost a key, a secret, or a file: held to 80. */
export const CRITICAL = [
    'src/sealed/keyring.mjs', 'src/sealed/sealing.mjs', 'src/sealed/sealed-artifacts.mjs', 'src/sealed/link-key.mjs', 'src/publish/sealed-publish.mjs',
    'src/reading/sealed-reading.mjs', 'src/reading/folder-writer.mjs', 'src/core/api-client.mjs', 'src/publish/secret-guard.mjs',
];
export const CRITICAL_MIN = 80;
export const OVERALL_MIN = 60;

/**
 * How a mutant's tests are run. A mutant can leave a test waiting forever - a
 * reply the fake site never sends, a loop that never ends - and on Windows
 * Stryker's own kill of a timed-out run can fail and leave the whole process
 * tree behind; on 2026-10-01 those piled up to 229 processes and 25 GB. So the
 * run ends itself: a test past TEST_TIMEOUT_MS is cancelled, and the process
 * exits once its tests are done, whatever handles a mutant left open.
 */
export const TEST_TIMEOUT_MS = 10000;
export const TEST_COMMAND = 'node --test --test-timeout=' + TEST_TIMEOUT_MS + ' --test-force-exit';

/** The command that runs these tests for a mutant. */
export function commandFor(tests) {
    return TEST_COMMAND + ' ' + tests.map((test) => 'tests/' + test + '.test.mjs').join(' ');
}

/**
 * The environment a mutant's tests run in. A mutant can drop what a test hands
 * a command - `keyringFor({})` for `keyringFor({ env })` - and the command then
 * falls back to the account holder's own profile: runs on 2026-10-01 wrote 33
 * test keys into %APPDATA%\markest\keys.json that way. So every place a profile
 * is read from points into the run's own folder, and the account holder's key,
 * site and key store are not handed down at all.
 */
export function sandboxEnv(env, home) {
    const out = { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config') };
    for (const name of Object.keys(out)) if (name.toUpperCase().startsWith('MARKEST_')) delete out[name];
    return out;
}

const DETECTED = new Set(['Killed', 'Timeout']);
const COUNTED = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage']);

/** A report's mutants by file: how many were detected of those that count. */
export function scoresOf(report) {
    const out = {};
    for (const [file, { mutants }] of Object.entries(report.files ?? {})) {
        const counted = mutants.filter((one) => COUNTED.has(one.status));
        out[file.replace(/\\/g, '/')] = { detected: counted.filter((one) => DETECTED.has(one.status)).length, total: counted.length, survived: mutants.filter((one) => one.status === 'Survived') };
    }
    return out;
}

const percent = (detected, total) => (total === 0 ? 100 : (detected * 100) / total);

/** Which thresholds the scores miss: each module its own (TICP 2.1), and the whole. */
export function verdict(scores) {
    const misses = [];
    for (const [file, one] of Object.entries(scores)) {
        const least = CRITICAL.includes(file) ? CRITICAL_MIN : OVERALL_MIN;
        if (percent(one.detected, one.total) < least) misses.push(file + ' ' + percent(one.detected, one.total).toFixed(1) + ' < ' + least);
    }
    const all = Object.values(scores).reduce((sum, one) => ({ detected: sum.detected + one.detected, total: sum.total + one.total }), { detected: 0, total: 0 });
    if (percent(all.detected, all.total) < OVERALL_MIN) misses.push('overall ' + percent(all.detected, all.total).toFixed(1) + ' < ' + OVERALL_MIN);
    return { misses, overall: percent(all.detected, all.total), detected: all.detected, total: all.total };
}

async function runGroup(name) {
    const group = GROUPS[name];
    const base = JSON.parse(await readFile(join(ROOT, 'stryker.config.json'), 'utf8'));
    const config = {
        ...base,
        mutate: group.mutate,
        commandRunner: { command: commandFor(group.tests) },
        jsonReporter: { fileName: 'reports/mutation/' + name + '.json' },
        htmlReporter: { fileName: 'reports/mutation/' + name + '.html' },
        reporters: ['clear-text', 'json', 'html'],
        thresholds: { ...base.thresholds, break: null },
    };
    delete config.$schema;
    for (const key of Object.keys(config)) if (key.startsWith('_comment')) delete config[key];
    await mkdir(join(ROOT, 'reports', 'mutation'), { recursive: true });
    const file = join(ROOT, 'reports', 'mutation', 'stryker.' + name + '.json');
    await writeFile(file, JSON.stringify(config, null, 2));
    process.stdout.write('== ' + name + ': ' + group.mutate.join(' ') + '\n');
    // A home of the run's own, emptied first, so what one group's mutants left there cannot change the next
    const home = join(ROOT, 'reports', 'mutation', 'home');
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    const run = spawnSync(process.execPath, [STRYKER, 'run', file], { cwd: ROOT, stdio: 'inherit', env: sandboxEnv(process.env, home) });
    if (run.status !== 0) throw new Error('Stryker stopped in group ' + name + ' (' + run.status + ').');
    return scoresOf(JSON.parse(await readFile(join(ROOT, 'reports', 'mutation', name + '.json'), 'utf8')));
}

async function main() {
    const asked = process.argv.slice(2);
    const names = asked.length > 0 ? asked : Object.keys(GROUPS);
    const unknown = names.filter((name) => !GROUPS[name]);
    if (unknown.length > 0) throw new Error('No group ' + unknown.join(', ') + '; the groups are ' + Object.keys(GROUPS).join(', ') + '.');
    const scores = {};
    for (const name of names) Object.assign(scores, await runGroup(name));
    process.stdout.write('\nMutation scores (detected / counted):\n');
    for (const [file, one] of Object.entries(scores).sort()) {
        process.stdout.write((CRITICAL.includes(file) ? '* ' : '  ') + file.padEnd(40) + String(one.detected).padStart(5) + ' /' + String(one.total).padStart(5) + '  ' + percent(one.detected, one.total).toFixed(1) + '\n');
    }
    const result = verdict(scores);
    process.stdout.write('  ' + 'all'.padEnd(40) + String(result.detected).padStart(5) + ' /' + String(result.total).padStart(5) + '  ' + result.overall.toFixed(1) + '\n* critical: at least ' + CRITICAL_MIN + '\n');
    await writeFile(join(ROOT, 'reports', 'mutation', 'summary.json'), JSON.stringify({ scores: Object.fromEntries(Object.entries(scores).map(([file, one]) => [file, { detected: one.detected, total: one.total }])), ...result }, null, 2));
    if (result.misses.length > 0) {
        process.stderr.write('Below a threshold: ' + result.misses.join('; ') + '\n');
        process.exitCode = 1;
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        process.stderr.write(error.message + '\n');
        process.exitCode = 1;
    });
}
