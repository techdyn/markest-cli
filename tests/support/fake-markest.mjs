/**
 * @module cli/tests/support/fake-markest
 * @description A stand-in for the site the tool speaks to, on a real local
 *              port: the REST API - creating, listing, reading, changing and
 *              deleting artifacts, their documents, images and versions, and
 *              visibility through its one door - the public API a browser
 *              reads, drafts with no account, and the agent tools (support/
 *              fake-agent). Each answers as the site does, with its permission
 *              and ownership refusals. Every request is recorded, a test can
 *              answer any one itself first, and seed artifacts directly.
 *
 * @input `{ requireApproval, permissions, tools, agentAccess, pageSize, drafts }`
 * @output `{ url, requests, pastes, agent, addPaste(fields), answerOnce(match, handler), close() }`
 * @dependencies node:http, node:crypto, cli/tests/support/fake-agent
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fakeAgent } from './fake-agent.mjs';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let serial = 0;

export function newId() {
    serial++;
    let n = serial;
    let id = '';
    for (let i = 0; i < 26; i++) {
        id = ALPHABET[n % 32] + id;
        n = Math.floor(n / 32);
    }
    return id;
}

function typeOf(path, given) {
    if (given) return given;
    if (/\.html?$/i.test(path)) return 'html';
    if (/\.(py|js|json|svg|css)$/i.test(path)) return 'code';
    return 'markdown';
}

const SETTABLE = ['title', 'folder', 'tags', 'default_path', 'expires_in', 'burn_after_reading', 'track_versions', 'proxy_images'];

export async function startFakeMarkest({ requireApproval = false, permissions = ['create_paste', 'read_own', 'delete_own', 'list_own'], tools = {}, agentAccess = true, pageSize = 0, drafts = { enabled: true } } = {}) {
    const requests = [];
    const pastes = new Map();
    const overrides = [];
    const agent = fakeAgent({ tools, agentAccess, pageSize });
    let base = '';

    const send = (res, status, body, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    const error = (res, status, message) => send(res, status, { error: message });
    const can = (permission) => permissions.includes(permission);
    const describe = (paste) => ({ id: paste.id, title: paste.title, visibility: paste.visibility, url: base + '/p/' + paste.id, sealed: paste.sealed });
    const documentsOf = (paste) => paste.documents.map((doc, i) => ({ path: doc.path, title: doc.title ?? doc.path, content: doc.content, content_type: doc.content_type, sort_order: i, bytes: Buffer.byteLength(doc.content) }));
    const settingsOf = (paste) => ({
        ...describe(paste), folder: paste.folder, default_path: paste.defaultPath, burn_after_reading: paste.burn, password_protected: paste.password !== null,
        expires_at: paste.expiresAt, track_versions: paste.trackVersions, proxy_images: paste.proxyImages, document_count: paste.documents.length,
    });

    function addPaste(fields = {}) {
        const paste = {
            id: newId(), owner: 'me', title: null, visibility: 'unlisted', documents: [], images: [], defaultPath: null, sealed: false, folder: null, tags: '',
            burn: false, password: null, expiresAt: null, trackVersions: false, proxyImages: true, versions: [], signature: null,
            created_at: '2026-10-01T09:00:00+00:00', updated_at: '2026-10-01T10:30:00+00:00', ...fields,
        };
        paste.documents = paste.documents.map((doc) => ({ title: null, ...doc, content_type: typeOf(doc.path, doc.content_type) }));
        pastes.set(paste.id, paste);
        return paste;
    }

    function write(paste, incoming) {
        const at = paste.documents.findIndex((doc) => doc.path === incoming.path);
        const record = {
            path: incoming.path,
            content: String(incoming.content ?? ''),
            // As the site does, a type not named is told again from the path
            content_type: typeOf(incoming.path, incoming.content_type),
            title: 'title' in incoming ? incoming.title : at === -1 ? null : paste.documents[at].title,
        };
        if (at === -1) paste.documents.push(record);
        else paste.documents[at] = record;
    }

    /** The public API reads what a browser may: public, unlisted, or private with its signature. */
    function readable(id, url) {
        const paste = pastes.get(id);
        if (!paste) return null;
        if (paste.visibility !== 'private') return paste;
        return paste.signature !== null && url.searchParams.get('sig') === paste.signature && url.searchParams.get('exp') !== null ? paste : null;
    }

    async function handle(req, res, bodyBytes) {
        const url = new URL(req.url, base);
        const path = url.pathname;
        const body = (() => {
            try {
                return JSON.parse(bodyBytes.toString('utf8'));
            } catch {
                return null;
            }
        })();
        const owned = (id) => {
            const paste = pastes.get(id);
            return paste && paste.owner === 'me' ? paste : null;
        };
        let match;

        if (path === '/mcp' && req.method === 'POST') return agent.answerAgent(req, res, body, (status, answer) => send(res, status, answer));
        if (path === '/api/v1/drafts') {
            if (req.method === 'GET') return send(res, 200, { enabled: drafts.enabled, visibility: 'unlisted', max_documents: 10, max_total_bytes: 262144, html: false, images: false });
            if (req.headers.authorization) return error(res, 400, 'A draft is published with no credential.');
            if (!drafts.enabled) return error(res, 403, 'Publishing without an account is turned off on this site.');
            const paste = addPaste({ owner: 'nobody', title: body.title ?? null, defaultPath: body.default_path ?? null, documents: body.documents ?? [] });
            return send(res, 201, { id: paste.id, url: base + '/p/' + paste.id, claim_url: base + '/app/claim/' + 'c'.repeat(64), expires_at: '2026-10-02T10:00:00+00:00', visibility: 'unlisted', draft: true });
        }
        if ((match = /^\/api\/p\/([0-9A-Z]{26})\/(manifest|doc)$/.exec(path))) {
            const paste = readable(match[1], url);
            if (!paste) return error(res, 404, 'Not found');
            if (match[2] === 'manifest') {
                return send(res, 200, { id: paste.id, title: paste.title, defaultPath: paste.defaultPath, visibility: paste.visibility, documents: paste.documents.map((doc, i) => ({ path: doc.path, title: doc.title ?? doc.path, contentType: doc.content_type, sortOrder: i })) });
            }
            const doc = paste.documents.find((one) => one.path === url.searchParams.get('path'));
            return doc ? send(res, 200, doc.content, 'text/plain; charset=utf-8') : error(res, 404, 'Document not found');
        }
        if (req.method === 'GET' && path === '/api/v1/pastes') {
            if (!can('list_own')) return error(res, 403, 'API key does not have list_own permission.');
            const query = (url.searchParams.get('query') ?? '').toLowerCase();
            const all = [...pastes.values()].filter((paste) => paste.owner === 'me' && (query === '' || String(paste.title ?? '').toLowerCase().includes(query))
                && (!url.searchParams.get('folder') || paste.folder === url.searchParams.get('folder')) && (!url.searchParams.get('visibility') || paste.visibility === url.searchParams.get('visibility')));
            const limit = Number(url.searchParams.get('limit') ?? 100);
            const offset = Number(url.searchParams.get('offset') ?? 0);
            const page = all.slice(offset, offset + limit);
            const hasMore = offset + page.length < all.length;
            return send(res, 200, {
                pastes: page.map((paste) => ({ ...describe(paste), folder: paste.folder, document_count: paste.documents.length, created_at: paste.created_at, updated_at: paste.updated_at, expires_at: paste.expiresAt })),
                total: all.length, count: page.length, offset, has_more: hasMore, ...(hasMore ? { next_offset: offset + page.length } : {}),
            });
        }
        if (req.method === 'POST' && path === '/api/v1/pastes') {
            if (!can('create_paste')) return error(res, 403, 'API key does not have create_paste permission.');
            if (body.sealed && body.visibility === 'public') return error(res, 422, 'An artifact encrypted in the browser cannot be public.');
            const paste = addPaste({ title: body.title ?? null, visibility: body.visibility ?? 'unlisted', defaultPath: body.default_path ?? null, sealed: Boolean(body.sealed), documents: [] });
            for (const doc of body.documents ?? []) write(paste, doc);
            if (paste.visibility === 'public' && requireApproval) {
                paste.visibility = 'unlisted';
                return send(res, 202, { ...describe(paste), status: 'approval_required', approval_url: base + '/app/approve/1' });
            }
            return send(res, 201, describe(paste));
        }
        if (req.method === 'POST' && path === '/api/v1/pastes/visibility') {
            const ids = body.paste_ids ?? [body.paste_id];
            const found = ids.map(owned);
            if (found.some((paste) => !paste)) return error(res, 422, 'No such paste.');
            if (body.visibility === 'public' && requireApproval) return send(res, 202, { status: 'approval_required', approval_url: base + '/app/approve/2' });
            const changed = found.filter((paste) => paste.visibility !== body.visibility);
            for (const paste of changed) paste.visibility = body.visibility;
            return send(res, 200, { status: 'applied', visibility: body.visibility, changed: changed.map(describe), unchanged: found.filter((p) => !changed.includes(p)).map(describe) });
        }
        if ((match = /^\/api\/v1\/pastes\/([0-9A-Z]{26})$/.exec(path))) {
            const id = match[1];
            if (req.method === 'GET') {
                if (!can('read_own')) return error(res, 403, 'API key does not have read_own permission.');
                const paste = pastes.get(id);
                if (!paste) return error(res, 404, 'Paste not found.');
                return send(res, 200, { ...describe(paste), folder: paste.folder, default_path: paste.defaultPath, documents: documentsOf(paste), created_at: paste.created_at, updated_at: paste.updated_at, expires_at: paste.expiresAt });
            }
            if (req.method === 'PATCH') {
                const paste = owned(id);
                if (!paste) return error(res, 404, 'Paste not found.');
                if ('documents' in body && paste.sealed) return error(res, 409, 'This artifact is encrypted in the browser.');
                if (!SETTABLE.some((field) => field in body) && !('password' in body)) return error(res, 400, 'Nothing to change.');
                if (body.burn_after_reading && paste.sealed) return error(res, 422, 'Burn-after-reading is not available for an artifact encrypted in the browser.');
                if ('title' in body) paste.title = body.title;
                if ('folder' in body) paste.folder = body.folder === '' ? null : body.folder;
                if ('tags' in body) paste.tags = body.tags;
                if ('default_path' in body) {
                    if (!paste.documents.some((doc) => doc.path === body.default_path)) return error(res, 422, 'No such document.');
                    paste.defaultPath = body.default_path;
                }
                if ('expires_in' in body) paste.expiresAt = body.expires_in > 0 ? '2026-10-08T10:00:00+00:00' : null;
                if ('password' in body) paste.password = body.password;
                if ('burn_after_reading' in body) paste.burn = body.burn_after_reading;
                if ('track_versions' in body) paste.trackVersions = body.track_versions;
                if ('proxy_images' in body) paste.proxyImages = body.proxy_images;
                return send(res, 200, settingsOf(paste));
            }
            if (req.method === 'DELETE') {
                if (!can('delete_own')) return error(res, 403, 'API key does not have delete_own permission.');
                if (!owned(id)) return error(res, 404, 'Paste not found.');
                pastes.delete(id);
                return send(res, 200, { success: true });
            }
        }
        if ((match = /^\/api\/v1\/pastes\/([0-9A-Z]{26})\/versions(?:\/(\d+))?$/.exec(path)) && req.method === 'GET') {
            const paste = owned(match[1]);
            if (!paste) return error(res, 404, 'Paste not found.');
            if (match[2] === undefined) return send(res, 200, { paste_id: paste.id, track_versions: paste.trackVersions, versions: paste.versions.map(({ documents, ...summary }) => summary) });
            const version = paste.versions.find((one) => one.number === Number(match[2]));
            if (!version) return error(res, 404, 'No version ' + match[2] + '.');
            const answer = { paste_id: paste.id, ...version };
            if (url.searchParams.get('path')) answer.document = version.documents.find((doc) => doc.path === url.searchParams.get('path')) ?? null;
            return send(res, 200, answer);
        }
        if ((match = /^\/api\/v1\/pastes\/([0-9A-Z]{26})\/documents$/.exec(path))) {
            const paste = owned(match[1]);
            if (req.method === 'POST') {
                if (!can('create_paste')) return error(res, 403, 'API key does not have create_paste permission.');
                if (!paste) return error(res, 404, 'Paste not found.');
                if (paste.sealed && body.documents.some((doc) => !String(doc.content).startsWith('MKSEAL1:'))) return error(res, 409, 'This artifact is encrypted in the browser.');
                const conflicts = body.documents.filter((doc) => !body.overwrite && paste.documents.some((one) => one.path === doc.path));
                if (conflicts.length > 0) return error(res, 409, 'This paste already has a document there.');
                for (const doc of body.documents) write(paste, doc);
                return send(res, 201, { id: paste.id, url: base + '/p/' + paste.id, documents: documentsOf(paste) });
            }
            if (req.method === 'DELETE') {
                if (!can('delete_own')) return error(res, 403, 'API key does not have delete_own permission.');
                if (!paste) return error(res, 404, 'Paste not found.');
                const target = url.searchParams.get('path');
                const at = paste.documents.findIndex((doc) => doc.path === target);
                if (at === -1) return error(res, 404, 'This paste has no document at "' + target + '".');
                if (paste.documents.length === 1) return error(res, 422, 'A paste must keep at least one document.');
                paste.documents.splice(at, 1);
                return send(res, 200, { id: paste.id, documents: documentsOf(paste) });
            }
        }
        if ((match = /^\/api\/v1\/pastes\/([0-9A-Z]{26})\/images(?:\/([0-9A-Z]{26}))?$/.exec(path))) {
            const paste = owned(match[1]);
            if (req.method === 'GET' && match[2] === undefined) {
                if (!can('read_own')) return error(res, 403, 'API key does not have read_own permission.');
                if (!paste) return error(res, 404, 'Paste not found.');
                return send(res, 200, { images: paste.images });
            }
            if (req.method === 'PUT' && match[2] === undefined) {
                if (!paste) return error(res, 404, 'Paste not found.');
                if (paste.sealed) return error(res, 409, 'An artifact encrypted in the browser holds no images.');
                const imageId = newId();
                const image = {
                    id: imageId, source: 'upload', name: url.searchParams.get('name'), sha256: createHash('sha256').update(bodyBytes).digest('hex'),
                    content_type: req.headers['content-type'], size: bodyBytes.length, path: '/img/' + paste.id + '/' + imageId,
                };
                paste.images.push(image);
                return send(res, 201, image);
            }
            if (req.method === 'DELETE' && match[2] !== undefined) {
                if (!paste) return error(res, 404, 'Paste not found.');
                const at = paste.images.findIndex((image) => image.id === match[2]);
                if (at === -1) return error(res, 404, 'No such image.');
                paste.images.splice(at, 1);
                return send(res, 200, { deleted: true });
            }
        }
        return error(res, 404, 'No route ' + req.method + ' ' + path);
    }

    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
            const bodyBytes = Buffer.concat(chunks);
            const url = new URL(req.url, 'http://x');
            const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, bytes: bodyBytes, json: null };
            try {
                record.json = JSON.parse(bodyBytes.toString('utf8'));
            } catch {
                record.json = null;
            }
            requests.push(record);
            const at = overrides.findIndex((one) => one.match(record));
            if (at !== -1) {
                const [one] = overrides.splice(at, 1);
                const handled = await one.handler(req, res, record, () => handle(req, res, bodyBytes));
                if (handled !== false) return;
            }
            await handle(req, res, bodyBytes);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;

    return {
        url: base,
        requests,
        pastes,
        agent,
        addPaste,
        writes: () => requests.filter((one) => one.method !== 'GET'),
        /** Answer the next request `match` accepts with `handler(req, res, record, proceed)`. */
        answerOnce(match, handler) {
            overrides.push({ match, handler });
        },
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
        }),
    };
}
