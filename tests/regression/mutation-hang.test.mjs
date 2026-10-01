/**
 * Regression (2026-10-01): a Stryker run leaked a process tree for every mutant
 * whose tests hung, until 229 node processes held 25 GB and the machine paged.
 * Every mutant's test run must end itself, whatever the mutant did, with the
 * Stryker timeout as the backstop above the tests' own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEST_COMMAND, TEST_TIMEOUT_MS, commandFor } from '../../scripts/mutate.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const config = JSON.parse(readFileSync(ROOT + 'stryker.config.json', 'utf8'));

test('a group runs its tests with a test timeout and a forced exit', () => {
    assert.equal(commandFor(['a', 'b']), TEST_COMMAND + ' tests/a.test.mjs tests/b.test.mjs');
    assert.match(TEST_COMMAND, /^node --test /);
    assert.match(TEST_COMMAND, new RegExp('--test-timeout=' + TEST_TIMEOUT_MS + '( |$)'));
    assert.match(TEST_COMMAND, /--test-force-exit( |$)/);
});

test('the whole-suite config ends its runs the same way', () => {
    assert.ok(config.commandRunner.command.startsWith(TEST_COMMAND + ' '), config.commandRunner.command);
});

test("Stryker's timeout sits above the tests' own, and concurrency leaves memory headroom", () => {
    assert.ok(config.timeoutMS > TEST_TIMEOUT_MS, 'timeoutMS ' + config.timeoutMS);
    assert.ok(config.concurrency <= 4, 'concurrency ' + config.concurrency);
});
