/**
 * Every command the tool has is whole: a name, a summary and usage for the
 * help, its own help text, flags, and the three steps main runs (cli/commands/registry).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandList } from '../src/commands/registry.mjs';
import { GLOBAL_FLAGS } from '../src/core/site-args.mjs';

test('every command is whole, named once, and takes no flag every command already takes', () => {
    assert.ok(COMMANDS.size >= 1);
    for (const [name, command] of COMMANDS) {
        assert.equal(command.name, name);
        assert.match(name, /^[a-z][a-z-]*$/);
        assert.ok(command.summary.length > 0 && command.summary.length <= 72, name + ' has a one-line summary');
        assert.ok(command.usage.startsWith('markest ' + name), name + '\'s usage starts with its name');
        assert.ok(command.help.includes('markest ' + name), name + '\'s help shows how to call it');
        for (const step of ['parse', 'needsKey', 'run']) assert.equal(typeof command[step], 'function', name + ' ' + step);
        for (const flag of Object.keys(command.flags ?? {})) assert.ok(!(flag in GLOBAL_FLAGS), name + ' redefines --' + flag);
    }
    assert.deepEqual(commandList().map((one) => one.name), [...COMMANDS.keys()], 'listed in their order');
    assert.deepEqual(Object.keys(commandList()[0]), ['name', 'usage', 'summary']);
});
