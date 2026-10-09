import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scanFolder, comparePaths, foldPath, MAX_IMAGE_BYTES, MAX_READ_BYTES, MAX_SCAN_ENTRIES } from '../src/publish/folder-scan.mjs';
import { IMAGE_EXTENSIONS } from '../src/publish/image-refs.mjs';
import { IMAGE_TYPES } from '../src/shared.mjs';
import { makeFolder } from './support/cli-harness.mjs';

const reasons = (scan) => Object.fromEntries(scan.skipped.map((one) => [one.path, one.reason]));
const KEY_LINE = 'token: mk_live_' + 'a'.repeat(48);
/** libuv's UV_FS_O_EXLOCK, which Node does not export: on Windows, open with no sharing at all. */
const UV_FS_O_EXLOCK = 0x10000000;

/**
 * An entry cap that changes the folder as it counts: `changes[n]` runs as the
 * nth entry is counted - after the folder was listed, before the entry is read.
 */
function changingCap(changes) {
    let counted = 0;
    return { valueOf() { changes[counted++]?.(); return MAX_SCAN_ENTRIES; } };
}

test('hidden, dependency and output folders are passed over unread; output only when asked for', async () => {
    const root = await makeFolder({
        'a.md': 'a', '.git/HEAD': 'x', 'node_modules/p/i.js': 'x', '__pycache__/c.py': 'x', 'dist/out.js': 'x', 'sub/.cache/c.md': 'x',
    });
    const scan = await scanFolder(root);
    assert.deepEqual(scan.documents.map((doc) => doc.path), ['a.md']);
    assert.deepEqual(reasons(scan), { '.git/': 'hidden', 'dist/': 'output', 'node_modules/': 'generated', '__pycache__/': 'generated', 'sub/.cache/': 'hidden' });
    const withOutput = await scanFolder(root, { includeOutput: true });
    assert.deepEqual(withOutput.documents.map((doc) => doc.path), ['a.md', 'dist/out.js']);
});

test('every hidden file is left out, at any depth, and whatever the ignore rules name', async () => {
    const root = await makeFolder({ '.env': 'K=1', 'docs/.npmrc': 't', 'docs/a.md': 'a', 'drafts/b.md': 'b', 'c.md': 'c' });
    const scan = await scanFolder(root, { ignoreLines: ['drafts/', 'c.md'] });
    assert.deepEqual(scan.documents.map((doc) => doc.path), ['docs/a.md']);
    assert.deepEqual(reasons(scan), { '.env': 'hidden', 'docs/.npmrc': 'hidden', 'drafts/': 'ignored', 'c.md': 'ignored' });
    const folderRule = await scanFolder(root, { ignoreLines: ['docs/a.md/'] });
    assert.ok(folderRule.documents.some((doc) => doc.path === 'docs/a.md'), 'a rule ending in / names folders alone');
});

test('files that hold keys are left out unless allowed by name', async () => {
    const root = await makeFolder({
        'credentials.json': '{}', 'service-account-prod.json': '{}', 'deploy.pem': 'x', 'terraform.tfstate': '{}',
        'settings.yaml': 'token: mk_live_' + 'a'.repeat(48), 'app.ini': 'key=-----BEGIN ' + 'PRIVATE KEY-----', 'secrets.md': '# About secrets',
        'ok.json': '{"a": 1}',
    });
    const scan = await scanFolder(root);
    assert.deepEqual(scan.documents.map((doc) => doc.path), ['ok.json', 'secrets.md'], 'prose about secrets is judged by what it holds');
    assert.deepEqual(scan.skipped.filter((one) => one.reason === 'secret').map((one) => one.path),
        ['app.ini', 'credentials.json', 'service-account-prod.json', 'settings.yaml']);
    assert.equal(reasons(scan)['deploy.pem'], 'type', 'a key file is no document either way');
    assert.deepEqual(scan.skipped.find((one) => one.path === 'credentials.json'), { path: 'credentials.json', reason: 'secret', code: 'secret_name' });
    const allowed = await scanFolder(root, { allowFiles: ['./settings.yaml'] });
    assert.ok(allowed.documents.some((doc) => doc.path === 'settings.yaml'));
});

test('an allowed file is named by its path in the folder, backslashes read as /, and lets no other file through', async () => {
    const root = await makeFolder({ 'config/app.yaml': KEY_LINE, 'notesapp.yaml': KEY_LINE });
    const scan = await scanFolder(root, { allowFiles: ['config\\app.yaml', 'notes./app.yaml'] });
    assert.deepEqual(scan.documents.map((doc) => doc.path), ['config/app.yaml']);
    assert.deepEqual(reasons(scan), { 'notesapp.yaml': 'secret' }, 'only a leading ./ is dropped from an allowed name');
});

test('images carry their checksum; an SVG is an image and, unshown, a document too; unknown types are said', async () => {
    const root = await makeFolder({ 'a.png': Buffer.from('PNG'), 'b.svg': '<svg/>', 'c.zip': 'x', 'd.md': 'd' });
    const scan = await scanFolder(root);
    assert.deepEqual(scan.images.map((image) => image.path), ['a.png', 'b.svg']);
    assert.equal(scan.images[0].sha256, createHash('sha256').update('PNG').digest('hex'));
    assert.equal(scan.images[0].contentType, 'image/png');
    assert.deepEqual(scan.documents.map((doc) => doc.path + ':' + doc.svg), ['b.svg:true', 'd.md:false']);
    assert.equal(reasons(scan)['c.zip'], 'type');
});

test('an SVG that is no UTF-8 is an image alone; one holding a key is neither, and takes no other image with it', async () => {
    const root = await makeFolder({
        'a.png': Buffer.from('PNG'), 'b.yaml': KEY_LINE, 'c.svg': '<svg><!-- ' + KEY_LINE + ' --></svg>', 'd.svg': Buffer.from([0x3c, 0xff, 0xfe]),
    });
    const scan = await scanFolder(root);
    assert.deepEqual(scan.images.map((image) => image.path), ['a.png', 'd.svg']);
    assert.deepEqual(scan.documents, []);
    assert.deepEqual(scan.skipped.map(({ path, reason }) => [path, reason]), [['b.yaml', 'secret'], ['c.svg', 'secret']]);
});

test('an image is read up to the image store\'s ceiling, anything else up to the largest document allowance; an SVG past that is an image alone', async () => {
    const root = await makeFolder({
        'cap.png': Buffer.alloc(MAX_IMAGE_BYTES), 'over.png': Buffer.alloc(MAX_IMAGE_BYTES + 1),
        'cap.html': 'x'.repeat(MAX_READ_BYTES), 'cap.svg': 'x'.repeat(MAX_READ_BYTES), 'over.svg': 'x'.repeat(MAX_READ_BYTES + 1),
    });
    const scan = await scanFolder(root);
    assert.deepEqual(scan.images.map((image) => image.path), ['cap.png', 'cap.svg', 'over.svg']);
    assert.deepEqual(scan.documents.map((doc) => doc.path), ['cap.html', 'cap.svg']);
    assert.deepEqual(scan.skipped, [{ path: 'over.png', reason: 'too_large' }]);
});

test('what is passed over is listed in code point order wherever the folder is, and images in natural order', async () => {
    // A Windows folder lists these a, b, C; code points put C first.
    const root = await makeFolder({ 'a.zip': 'x', 'b.zip': 'x', 'C.zip': 'x', 'img10.png': 'x', 'img2.png': 'x' });
    const scan = await scanFolder(root);
    assert.deepEqual(scan.skipped.map((one) => one.path), ['C.zip', 'a.zip', 'b.zip']);
    assert.deepEqual(scan.images.map((image) => image.path), ['img2.png', 'img10.png']);
});

test('each entry is looked at again before it is read: a file or folder gone since the listing is unreadable, a folder in a file\'s place is not read', async () => {
    const root = await makeFolder({ 'a.md': 'a', 'b.md': 'b', 'c/d.md': 'd', 'e.md': 'e' });
    const maxEntries = changingCap([
        () => unlinkSync(join(root, 'a.md')),
        () => { unlinkSync(join(root, 'b.md')); mkdirSync(join(root, 'b.md')); },
        () => rmSync(join(root, 'c'), { recursive: true }),
    ]);
    const scan = await scanFolder(root, { maxEntries });
    assert.deepEqual(scan.documents.map((doc) => doc.path), ['e.md']);
    assert.deepEqual(scan.skipped.map((one) => one.reason), ['unreadable', 'special', 'unreadable']);
    assert.deepEqual(scan.skipped.slice(0, 2).map((one) => one.path), ['a.md', 'b.md']);
});

test('a file that cannot be opened once looked at is unreadable', { skip: process.platform !== 'win32' && 'an exclusive lock is Windows\' own' }, async () => {
    const root = await makeFolder({ 'a.md': 'a', 'b.md': 'b' });
    // Held open with no sharing: its size can be read, its bytes cannot.
    const lock = openSync(join(root, 'a.md'), constants.O_RDONLY | UV_FS_O_EXLOCK);
    try {
        const scan = await scanFolder(root);
        assert.deepEqual(scan.documents.map((doc) => doc.path), ['b.md']);
        assert.deepEqual(scan.skipped, [{ path: 'a.md', reason: 'unreadable' }]);
    } finally {
        closeSync(lock);
    }
});

test('text is UTF-8 with its byte-order mark dropped; anything else, or too large, is not read as a document', async () => {
    const root = await makeFolder({ 'bom.md': Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x41]), 'bad.md': Buffer.from([0xff, 0xfe, 0x00]), 'big.html': 'x'.repeat(1048577) });
    const scan = await scanFolder(root);
    assert.deepEqual(scan.documents.map((doc) => [doc.path, doc.content]), [['bom.md', '# A']]);
    assert.deepEqual(reasons(scan), { 'bad.md': 'not_text', 'big.html': 'too_large' });
});

test('paths are NFC; two the database would take for one keep the first in natural order; one the site refuses is passed over', async () => {
    // Distinct names on every file system, one name to production's collation.
    const root = await makeFolder({ 'Cafe\u0301.md': 'nfd', 'resume.md': 'a', 'r\u00e9sum\u00e9.md': 'b', 'doc10.md': '10', 'doc2.md': '2', 'notes#1.md': 'n' });
    const scan = await scanFolder(root);
    const paths = scan.documents.map((doc) => doc.path);
    assert.ok(paths.includes('Caf\u00e9.md'), 'NFC');
    assert.ok(paths.indexOf('doc2.md') < paths.indexOf('doc10.md'), 'natural order');
    assert.equal(paths.filter((path) => foldPath(path) === 'resume.md').length, 1);
    assert.equal(scan.skipped.find((one) => one.reason === 'path_collision').code, paths.find((path) => foldPath(path) === 'resume.md'));
    assert.ok(!paths.includes('notes#1.md'));
    assert.deepEqual(scan.skipped.find((one) => one.path === 'notes#1.md'), { path: 'notes#1.md', reason: 'invalid_path', code: 'forbidden_chars' });
});

test('natural order and the collation fold', () => {
    assert.ok(comparePaths('a/doc2.md', 'a/doc10.md') < 0);
    assert.ok(comparePaths('docs/z.md', 'index.html') < 0, 'folder by folder');
    assert.ok(comparePaths('A.md', 'b.md') < 0, 'case does not order');
    assert.equal(foldPath('Über/ÉTÉ.md'), foldPath('uber/ete.md'));
});

test('a path comes before those that go deeper below it, whatever its case; names the collation takes for one are ordered by code point', () => {
    assert.ok(comparePaths('docs', 'docs/index.md') < 0);
    assert.ok(comparePaths('b', 'B/c.md') < 0);
    assert.ok(comparePaths('B/c.md', 'b') > 0);
    assert.equal(comparePaths('A.md', 'a.md'), -1);
    assert.equal(comparePaths('a.md', 'A.md'), 1);
    assert.equal(comparePaths('a.md', 'a.md'), 0);
});

test('a scan stops at its entry cap rather than walking a whole disk', async () => {
    assert.equal(MAX_SCAN_ENTRIES, 20000);
    const root = await makeFolder({ 'a.md': 'a', 'b/c.md': 'c', 'b/d.md': 'd' });
    assert.deepEqual((await scanFolder(root, { maxEntries: 4 })).fatal, []);
    assert.deepEqual((await scanFolder(root, { maxEntries: 3 })).fatal, [{ code: 'too_many_entries', limit: 3 }], 'folders count as entries');
    const after = await makeFolder({ 'a.md': 'a', 'b/c.md': 'c', 'b/d.md': 'd', 'e.md': 'e' });
    assert.deepEqual((await scanFolder(after, { maxEntries: 3 })).fatal, [{ code: 'too_many_entries', limit: 3 }], 'said once: nothing after a folder that reached it is counted');
});

test('the command\'s image extensions are the types the image store keeps', () => {
    assert.deepEqual([...new Set(Object.values(IMAGE_EXTENSIONS))].sort(), [...IMAGE_TYPES].sort());
});
