/**
 * The package's mutation testing (cli/scripts/mutate): every module in a group
 * with tests of its own, the scores counted as Stryker counts them, and the
 * thresholds - 80 for each critical module, 60 for every other and the whole - held.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CRITICAL, GROUPS, scoresOf, verdict } from '../scripts/mutate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every group names tests that are there, and every critical module is in a group', () => {
    for (const [name, group] of Object.entries(GROUPS)) {
        assert.ok(group.mutate.length > 0 && group.tests.length > 0, name);
        for (const test of group.tests) assert.ok(existsSync(ROOT + 'tests/' + test + '.test.mjs'), name + ': ' + test);
    }
    const modules = readdirSync(ROOT + 'src', { recursive: true }).map((file) => 'src/' + String(file).replace(/\\/g, '/')).filter((file) => file.endsWith('.mjs'));
    for (const file of CRITICAL) assert.ok(modules.includes(file), file + ' is a module');
});

test('a group that mutates a command runs the registry\'s test, which reads every command\'s summary, usage and help', () => {
    for (const [name, group] of Object.entries(GROUPS)) {
        if (group.mutate.some((glob) => glob.startsWith('src/commands/'))) assert.ok(group.tests.includes('registry'), name);
    }
});

test('a score is the mutants detected of those that count', () => {
    const report = { files: { 'src\\a.mjs': { mutants: [{ status: 'Killed' }, { status: 'Timeout' }, { status: 'Survived', id: '3' }, { status: 'NoCoverage' }, { status: 'CompileError' }, { status: 'Ignored' }] } } };
    const scores = scoresOf(report);
    assert.deepEqual(Object.keys(scores), ['src/a.mjs']);
    assert.equal(scores['src/a.mjs'].detected, 2);
    assert.equal(scores['src/a.mjs'].total, 4);
    assert.deepEqual(scores['src/a.mjs'].survived, [{ status: 'Survived', id: '3' }]);
    assert.deepEqual(scoresOf({}), {});
});

test('each critical module is held to 80, every other module to 60, and the whole to 60', () => {
    const fine = verdict({ 'src/sealed/keyring.mjs': { detected: 8, total: 10 }, 'src/other.mjs': { detected: 6, total: 10 } });
    assert.deepEqual(fine.misses, []);
    assert.equal(fine.overall, 70);
    const low = verdict({ 'src/sealed/keyring.mjs': { detected: 7, total: 10 }, 'src/other.mjs': { detected: 1, total: 10 } });
    assert.deepEqual(low.misses, ['src/sealed/keyring.mjs 70.0 < 80', 'src/other.mjs 10.0 < 60', 'overall 40.0 < 60']);
    const one = verdict({ 'src/a.mjs': { detected: 59, total: 100 }, 'src/b.mjs': { detected: 100, total: 100 } });
    assert.deepEqual(one.misses, ['src/a.mjs 59.0 < 60'], 'a module below is a miss though the whole is above');
    assert.deepEqual(verdict({ 'src/empty.mjs': { detected: 0, total: 0 } }).misses, [], 'a module with nothing to mutate misses nothing');
    assert.equal(verdict({}).overall, 100, 'nothing to mutate misses nothing');
});
