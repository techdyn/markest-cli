import test from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor, renderHuman, renderJson } from '../src/publish/publish-report.mjs';
import { EXIT, printable } from '../src/core/output.mjs';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const result = (status, extra = {}) => ({
    status, url: 'https://marke.st/p/' + ID, approval_url: null, title: 'T', default_path: 'README.md',
    documents: { created: 1, updated: 0, unchanged: 0, deleted: 0 }, images: { uploaded: [], reused: [], refused: [], unshown: [] },
    skipped: [], warnings: [], errors: [], error: null, ...extra,
});

test('each exit code means one thing', () => {
    assert.deepEqual(['published', 'updated', 'unchanged', 'dry_run', 'approval_required', 'incomplete', 'failed', 'refused', 'usage', 'odd'].map((status) => exitCodeFor({ status })),
        [0, 0, 0, 0, 3, 1, 1, 4, 2, 1]);
    assert.deepEqual(EXIT, { OK: 0, FAILED: 1, USAGE: 2, AWAITING_APPROVAL: 3, REFUSED: 4 });
});

test('read by a person, stdout is the address alone; everything else goes to stderr, without control characters', () => {
    assert.deepEqual(renderHuman(result('published')), { stdout: 'https://marke.st/p/' + ID + '\n', stderr: '' });
    const refused = renderHuman(result('refused', { error: 'No.\u001b[31m', url: null, skipped: [{ path: 'a\u001b]0;x\u0007.json', reason: 'secret' }] }));
    assert.equal(refused.stdout, '');
    assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(refused.stderr), 'no escape sequence reaches the terminal');
    assert.match(refused.stderr, /markest: No\.\[31m/);
    assert.equal(renderHuman(result('incomplete')).stdout, 'https://marke.st/p/' + ID + '\n', 'the artifact exists, so its address is given');
    assert.match(renderHuman(result('approval_required', { approval_url: 'https://marke.st/a' })).stderr, /confirmation: open https:\/\/marke\.st\/a/);
    assert.equal(printable('ok\ttab\nline'), 'ok\ttab\nline');
});

test('as JSON it is one object with every key, and a long list of what was left out is cut and says so', () => {
    const skipped = Array.from({ length: 150 }, (_, i) => ({ path: i + '.bin', reason: 'type' }));
    const text = renderJson(result('published', { skipped }));
    assert.equal(text.split('\n').length, 2, 'one line');
    const parsed = JSON.parse(text);
    assert.equal(parsed.exit_code, 0);
    assert.equal(parsed.skipped.length, 100);
    assert.equal(parsed.skipped_total, 150);
    assert.equal(parsed.skipped_truncated, true);
    for (const key of ['status', 'url', 'approval_url', 'title', 'default_path', 'documents', 'images', 'warnings', 'errors', 'error']) assert.ok(key in parsed, key);
});

test('what was left out, warned of, refused and wrong is said in full, each reason in its own words', () => {
    const reasons = ['hidden', 'hidden', 'generated', 'output', 'ignored', 'symlink', 'special', 'type', 'secret', 'too_large', 'not_text', 'invalid_path', 'path_collision', 'unreadable', 'odd'];
    const text = renderHuman(result('refused', {
        url: null,
        error: 'No.',
        skipped: reasons.map((reason, i) => ({ path: reason === 'secret' ? 'keys/creds.json' : 'f' + i, reason })),
        warnings: ['unpublished_image', 'image_link', 'html_local_resource', 'html_page_link', 'outside_folder', 'key_not_kept', 'odd_warning'].map((code) => ({ code, path: 'a.md', target: 't' })),
        images: { uploaded: [], reused: [], refused: [{ path: 'big.png', error: 'Too large.' }], unshown: [] },
        errors: [{ code: 'file_size', path: 'big.md', limit: 524288 }, { code: 'case_rename', path: 'a.md', target: 'A.md' }, { code: 'no_documents' }, { code: 'max_docs', limit: 0 }],
    })).stderr;
    assert.equal(text, [
        'Left out: 2 hidden, 1 dependencies, 1 build output (--include-output sends it), 1 ignored, 1 a link, 1 not a file, 1 not a document or image, 1 looks like a secret (--allow-file sends it), 1 too large, 1 not UTF-8 text, 1 a name the site refuses, 1 differs from another only in case or accents, 1 unreadable, 1 odd.',
        '  not sent: keys/creds.json',
        'Warning: a.md shows an image that is not being sent: t',
        'Warning: a.md links to an image; only an image shown with ![...](...) is displayed: t',
        'Warning: a.md loads a stylesheet or script from beside it, which a published page cannot: t',
        'Warning: a.md links to another page, which cannot open inside a published page: t',
        'Warning: a.md points outside the folder: t',
        'Warning: a.md could not keep the key; keep the link printed, which holds it: t',
        'Warning: a.md odd_warning: t',
        'Image refused: big.png: Too large.',
        'Error: file_size big.md, limit 524288',
        'Error: case_rename a.md (A.md)',
        'Error: no_documents',
        'Error: max_docs, limit 0',
        'markest: No.',
    ].join('\n') + '\n');
});

test('each state says its own lines: a dry run, an incomplete publish, a failure with what was made, an encrypted one', () => {
    const dry = renderHuman(result('dry_run', { default_path: null, documents: { created: 2, updated: 3, unchanged: 4, deleted: 5 }, images: { uploaded: [{}, {}], reused: [], refused: [], unshown: [] } }));
    assert.equal(dry.stdout, 'Would publish "T", opening on (unchanged):\n  2 new, 3 changed, 4 unchanged and 5 removed documents; 2 images to upload.\n');
    assert.equal(dry.stderr, '');
    assert.equal(renderHuman(result('dry_run')).stdout.split('\n')[0], 'Would publish "T", opening on README.md:');
    assert.deepEqual(renderHuman(result('incomplete')), { stdout: 'https://marke.st/p/' + ID + '\n', stderr: 'Published, but not everything was accepted: see above.\n' });
    assert.deepEqual(renderHuman(result('failed', { error: 'Lost.' })), { stdout: '', stderr: 'markest: Lost.\nThe artifact so far: https://marke.st/p/' + ID + '\n' });
    assert.deepEqual(renderHuman(result('failed', { error: 'Lost.', url: null })), { stdout: '', stderr: 'markest: Lost.\n' });
    assert.deepEqual(renderHuman(result('updated', { encrypted: true })), {
        stdout: 'https://marke.st/p/' + ID + '\n',
        stderr: 'Encrypted end to end: the key is in this link and kept on this machine (markest keys). Whoever has the link can read it.\n',
    });
    assert.deepEqual(renderHuman(result('unchanged')), { stdout: 'https://marke.st/p/' + ID + '\n', stderr: 'Nothing changed.\n' });
    assert.deepEqual(renderHuman({ status: 'published', url: 'u' }), { stdout: 'u\n', stderr: '' }, 'nothing missing is a matter');
    assert.equal(renderHuman(result('approval_required', { approval_url: 'https://a' })).stderr, 'Making it public needs your confirmation: open https://a. Nothing is public until you approve it.\n');
});

test('as JSON, exactly a hundred left out is the whole list, and none is none', () => {
    const hundred = JSON.parse(renderJson(result('published', { skipped: Array.from({ length: 100 }, (_, i) => ({ path: String(i), reason: 'type' })) })));
    assert.equal(hundred.skipped_truncated, false);
    assert.equal(hundred.skipped.length, 100);
    const none = JSON.parse(renderJson({ status: 'published' }));
    assert.deepEqual([none.skipped, none.skipped_total, none.skipped_truncated, none.exit_code], [[], 0, false, 0]);
});
