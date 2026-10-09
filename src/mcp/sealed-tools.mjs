/**
 * @module cli/mcp/sealed-tools
 * @description The tools `markest mcp` offers an agent, for artifacts
 *              encrypted end to end alone: make one, read one,
 *              add or replace documents, take documents out, give its link, keep
 *              its key. Every other Markest tool stays on the remote connector,
 *              which cannot open these. Each is named apart from the remote
 *              tools, says what it reads or changes, and says the cost that no
 *              design avoids: text read here enters the conversation, so the
 *              agent's own model provider sees it - Markest never does.
 *
 * @input A context `{ baseUrl, key, env, fetch, version, stderr }`
 * @output `[{ definition, run(args) }]`; the server's instructions
 * @dependencies cli/sealed/sealed-artifacts, cli/sealed/keyring, cli/sealed/sealing,
 *               cli/reading/artifact-source, cli/core/command-kit
 */

import { createSealed, linkFor, readSealed, removeSealed, writeSealed, MAX_DOCUMENTS } from '../sealed/sealed-artifacts.mjs';
import { keyringFor } from '../sealed/keyring.mjs';
import { keyIn, openAll } from '../sealed/sealing.mjs';
import { ALL, fetchArtifact } from '../reading/artifact-source.mjs';
import { clientsFor, Refused, hasCredential } from '../core/command-kit.mjs';
import { pasteIdFrom } from '../core/site-args.mjs';

const PRIVACY = ' Markest stores only ciphertext and never has the key; text read or written here does pass through this conversation, so the AI provider running it sees it.';

export const INSTRUCTIONS = 'Tools for Markest artifacts encrypted end to end (their links end #key=...). The site cannot read them, so these tools seal and open them on this machine, '
    + 'keeping each key in the user\'s key store. Use them for any artifact whose link carries a key, or that the user calls encrypted; for every other Markest task use the '
    + 'Markest connector\'s tools. Never repeat a key or a link carrying one unless the user asks for the link.' + PRIVACY;

const ARTIFACT = { type: 'string', description: 'The artifact: its whole link ending #key=..., or its id when this machine keeps its key.' };
const DOCUMENT = {
    type: 'object',
    properties: {
        path: { type: 'string', description: 'Where it goes, such as README.md or docs/setup.md.' },
        content: { type: 'string', description: 'Its text.' },
        content_type: { type: 'string', enum: ['markdown', 'html', 'code'], description: 'Optional: what it is. By default the type it already has, else told by its name and text.' },
        title: { type: 'string', description: 'Optional: a title shown in place of its path. The site can read titles.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
};

/** A tool's definition in the protocol's shape. */
function tool(name, title, description, properties, required, annotations) {
    return { name, title, description: description + PRIVACY, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { title, ...annotations } };
}

export function sealedTools(ctx) {
    return [
        {
            definition: tool('markest_sealed_create', 'Create an encrypted artifact',
                'Publish documents as a new Markest artifact encrypted end to end: sealed on this machine, unlisted or private, never public, holding no images and keeping no versions. Answers with its link, which carries the key; give it only to whoever should read it. The key is kept on this machine.',
                {
                    title: { type: 'string', description: 'Its title. The site can read titles.' },
                    documents: { type: 'array', items: DOCUMENT, minItems: 1, maxItems: MAX_DOCUMENTS },
                    visibility: { type: 'string', enum: ['unlisted', 'private'], default: 'unlisted' },
                    default_path: { type: 'string', description: 'The document it opens on; by default its first.' },
                    folder: { type: 'string', description: 'A folder to file it under in My Artifacts.' },
                }, ['documents'], { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
            run: (args) => createSealed(ctx, args),
        },
        {
            definition: tool('markest_sealed_read', 'Read an encrypted artifact',
                'Read a Markest artifact encrypted end to end, opened on this machine: one document (the one named, else the one it opens on) or every document with all: true. Set remember: true to keep the key in the link for later.',
                {
                    artifact: ARTIFACT,
                    path: { type: 'string', description: 'The document to read.' },
                    all: { type: 'boolean', description: 'Every document, not one.' },
                    remember: { type: 'boolean', description: 'Keep the link\'s key on this machine.' },
                }, ['artifact'], { readOnlyHint: true, openWorldHint: true }),
            run: (args) => readSealed(ctx, args),
        },
        {
            definition: tool('markest_sealed_write', 'Add or replace documents in an encrypted artifact',
                'Add documents to a Markest artifact encrypted end to end, or replace them: each sealed on this machine and sent as ciphertext. A document keeps its type unless another is given. Needs the artifact\'s key and a Markest API key that may change it.',
                { artifact: ARTIFACT, documents: { type: 'array', items: DOCUMENT, minItems: 1, maxItems: MAX_DOCUMENTS } },
                ['artifact', 'documents'], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }),
            run: (args) => writeSealed(ctx, args),
        },
        {
            definition: tool('markest_sealed_remove_documents', 'Take documents out of an encrypted artifact',
                'Remove documents from a Markest artifact encrypted end to end, by path. It cannot be undone; the artifact keeps at least one document.',
                { artifact: ARTIFACT, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_DOCUMENTS } },
                ['artifact', 'paths'], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }),
            run: (args) => removeSealed(ctx, args),
        },
        {
            definition: tool('markest_sealed_link', 'The link that shares an encrypted artifact',
                'The link that shares a Markest artifact encrypted end to end, carrying the key kept on this machine. Whoever has it can read the artifact: give it only when the user asks for it.',
                { artifact: ARTIFACT }, ['artifact'], { readOnlyHint: true, openWorldHint: false }),
            run: (args) => linkFor(ctx, args),
        },
        {
            definition: tool('markest_sealed_keys', 'Encrypted artifacts with keys kept here',
                'List the encrypted artifacts whose keys this machine keeps, by id and title - never the keys - or, with link, keep the key in a link once it has opened the artifact.',
                { link: { type: 'string', description: 'Optional: a link ending #key=... whose key to keep.' } }, [], { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
            run: (args) => keys(ctx, args),
        },
    ];
}

/** The keys kept here, or one kept from a link after it opened its artifact. */
async function keys(ctx, { link = null }) {
    const keyring = keyringFor(ctx);
    if (link === null) return { keys: (await keyring.list()).filter((one) => one.site === ctx.baseUrl).map(({ site, ...one }) => one) };
    const id = pasteIdFrom(link);
    const key = keyIn(link);
    if (id === null || key === null) throw new Refused('Give the artifact\'s whole link, the one ending #key=...');
    const { rest } = clientsFor(ctx);
    const artifact = await fetchArtifact(rest, { id, reference: link, keyed: hasCredential(ctx), pick: ALL });
    if (!artifact.sealed) throw new Refused('That artifact is not encrypted end to end: it needs no key.');
    await openAll(key, artifact.documents);
    await keyring.remember(ctx.baseUrl, id, key, artifact.title);
    return { kept: id, title: artifact.title };
}
