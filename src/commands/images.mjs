/**
 * @module cli/commands/images
 * @description The images an artifact holds: `markest images` lists them, adds
 *              files from disk - each sent as its own bytes, named by its file
 *              name, and printed with the address a document shows it by - and
 *              removes them by id. Over the REST API: read_own to list,
 *              create_paste to add, delete_own to remove.
 *
 * @input The command's flags and artifact; a run's context
 * @output The exit code
 * @dependencies node:fs/promises, node:path, cli/core/command-kit, cli/core/output,
 *               cli/publish/image-refs
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { answer, artifactsFrom, clientsFor, Refused } from '../core/command-kit.mjs';
import { printable, table } from '../core/output.mjs';
import { IMAGE_EXTENSIONS } from '../publish/image-refs.mjs';

const ID = /^[0-9A-Z]{26}$/i;

const images = {
    name: 'images',
    summary: 'List, add or remove an artifact\'s images',
    usage: 'markest images <artifact> [--add <file>...] [--remove <id>...]',
    help: `The images an artifact holds.

Usage:
  markest images <artifact>                    List them
  markest images <artifact> --add <file>...    Upload image files
  markest images <artifact> --remove <id>...   Remove images by id

An image added is shown in a document by the address printed beside it:
![chart](/img/...). PNG, JPEG, GIF, WebP, AVIF, BMP, APNG and SVG, within
your plan's limits. An artifact encrypted end to end holds no images.
Needs a key with read_own to list, create_paste to add, delete_own to remove.
`,
    flags: { add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true } },
    parse(values, positionals) {
        const named = artifactsFrom(positionals, { usage: 'markest images <artifact>' });
        if (named.usageError) return named;
        const add = values.add ?? [];
        const remove = values.remove ?? [];
        if (add.length > 0 && remove.length > 0) return { usageError: 'Add or remove, one at a time' };
        for (const file of add) {
            // Its own keys alone: `in` would take a file.constructor for an image
            if (!Object.hasOwn(IMAGE_EXTENSIONS, extname(file).slice(1).toLowerCase())) return { usageError: file + ' is not an image the site keeps (' + Object.keys(IMAGE_EXTENSIONS).join(', ') + ')' };
        }
        for (const id of remove) if (!ID.test(id)) return { usageError: '"' + id + '" is not an image id: markest images <artifact> lists them' };
        return { ids: named.ids, add, remove: remove.map((id) => id.toUpperCase()) };
    },
    needsKey: () => true,
    async run(ctx) {
        const { rest } = clientsFor(ctx);
        const base = '/api/v1/pastes/' + ctx.ids[0] + '/images';
        if (ctx.add.length > 0) {
            return answer(ctx, async () => {
                const added = [];
                for (const file of ctx.add) {
                    const bytes = await readFile(file).catch(() => {
                        throw new Refused(file + ' could not be read' + (added.length > 0 ? '; added before it: ' + added.map((one) => one.name).join(', ') : '') + '.');
                    });
                    const type = IMAGE_EXTENSIONS[extname(file).slice(1).toLowerCase()];
                    added.push((await rest.request('PUT', base, { body: bytes, contentType: type, query: { name: basename(file) } })).body);
                }
                return { added };
            }, (done) => done.added.map((one) => printable(one.name ?? one.id) + '  ' + one.path + '\n').join(''));
        }
        if (ctx.remove.length > 0) {
            return answer(ctx, async () => {
                for (const id of ctx.remove) await rest.request('DELETE', base + '/' + id, { idempotent: true });
                return { removed: ctx.remove };
            }, (done) => done.removed.map((id) => 'Removed ' + id + '\n').join(''));
        }
        return answer(ctx, async () => (await rest.request('GET', base, { idempotent: true })).body, (body) => table(body.images ?? [], [
            { key: 'id', label: 'ID' }, { key: 'source', label: 'FROM' }, { key: 'content_type', label: 'TYPE' }, { key: 'size', label: 'BYTES' },
            { key: 'path', label: 'ADDRESS' }, { key: 'name', label: 'NAME' },
        ]));
    },
};

export const commands = [images];
