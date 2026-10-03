/**
 * @module cli/store/settings-folder
 * @description Where the command keeps what it keeps - the sign-in, the keys of
 *              artifacts encrypted end to end, the key that opens them: the
 *              account's own settings folder, `%APPDATA%\markest` on Windows,
 *              `~/Library/Application Support/markest` on a Mac,
 *              `$XDG_CONFIG_HOME/markest` or `~/.config/markest` elsewhere, or
 *              the folder MARKEST_HOME names. Pure.
 *
 * @input The environment, the platform and the home folder
 * @output The folder's path
 * @dependencies node:path, node:os
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

export const FOLDER_NAME = 'markest';

/** The folder this account's runs keep their files in. */
export function settingsFolder(env = {}, platform = process.platform, home = homedir()) {
    if (env.MARKEST_HOME) return env.MARKEST_HOME;
    if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), FOLDER_NAME);
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', FOLDER_NAME);
    return join(env.XDG_CONFIG_HOME || join(home, '.config'), FOLDER_NAME);
}
