/**
 * Regression test: the command keeps its files in the
 * account's own settings folder on each system, or where MARKEST_HOME says
 * (cli/store/settings-folder).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { settingsFolder } from '../src/store/settings-folder.mjs';

test('the account\'s own settings folder, or where MARKEST_HOME says', () => {
    assert.equal(settingsFolder({ MARKEST_HOME: '/x/m' }, 'linux', '/home/a'), '/x/m');
    assert.equal(settingsFolder({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Roaming', 'markest'));
    assert.equal(settingsFolder({}, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a', 'AppData', 'Roaming', 'markest'));
    assert.equal(settingsFolder({}, 'darwin', '/Users/a'), join('/Users/a', 'Library', 'Application Support', 'markest'));
    assert.equal(settingsFolder({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/a'), join('/cfg', 'markest'));
    assert.equal(settingsFolder({}, 'linux', '/home/a'), join('/home/a', '.config', 'markest'));
    assert.equal(settingsFolder({}, 'linux'), join(homedir(), '.config', 'markest'));
});
