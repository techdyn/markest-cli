/**
 * @module cli/commands/registry
 * @description Every command the tool has, by name, in the order its help
 *              lists them: publishing first, then reading, managing, the
 *              artifact's history, its conversation and its readers, searching,
 *              the keys of encrypted artifacts, and every agent tool the site
 *              has. A command is an object with its name, a one-line summary,
 *              its usage and help, its own flags, `parse` (what was asked, or a
 *              usage error), `needsKey` and `run`; a module offers one
 *              (`command`) or several (`commands`).
 *
 * @input None
 * @output `COMMANDS`, a Map of name to command; `commandList()`
 * @dependencies cli/commands/*
 */

import { command as publish } from './publish.mjs';
import { commands as draft } from './draft.mjs';
import { commands as reading } from './reading.mjs';
import { commands as artifacts } from './artifacts.mjs';
import { commands as settings } from './settings.mjs';
import { commands as images } from './images.mjs';
import { commands as history } from './history.mjs';
import { commands as conversation } from './conversation.mjs';
import { commands as sharing } from './sharing.mjs';
import { commands as search } from './search.mjs';
import { commands as tools } from './tools.mjs';
import { commands as keys } from './keys.mjs';
import { command as mcp } from './mcp.mjs';

const ALL = [publish, ...draft, ...reading, ...artifacts, ...settings, ...images, ...history, ...conversation, ...sharing, ...search, ...keys, mcp, ...tools];

export const COMMANDS = new Map(ALL.map((one) => [one.name, one]));

/** The commands as their help lists them. */
export function commandList() {
    return ALL.map((one) => ({ name: one.name, usage: one.usage, summary: one.summary }));
}
