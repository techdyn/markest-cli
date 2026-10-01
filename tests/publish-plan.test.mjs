import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesOf, chooseDefault, chooseTitle, diffDocuments, documentPayload, headingOf, orderDocuments, planImages, preflight, MAX_REQUEST_BYTES } from '../src/publish/publish-plan.mjs';

const doc = (path, content = 'x', type = 'markdown') => ({ path, content, type, svg: false });

test('the artifact opens on the document asked for, else the root README or index, else the first', () => {
    assert.equal(chooseDefault(['a.md', 'docs/README.md', 'Index.html', 'readme.MD']), 'readme.MD');
    assert.equal(chooseDefault(['a.md', 'index.md', 'index.html']), 'index.md');
    assert.equal(chooseDefault(['b.md', 'docs/README.md']), 'b.md', 'only a README at the root counts');
    assert.equal(chooseDefault(['a.md', 'b.md'], 'b.md'), 'b.md');
    assert.equal(chooseDefault(['a.md'], 'missing.md'), null);
    assert.equal(chooseDefault([]), null);
});

test('the title is asked for, else front matter, else the first heading outside code, else the folder', () => {
    assert.equal(headingOf('---\ntitle: "From Front"\n---\n# Heading\n'), 'From Front');
    assert.equal(headingOf('```\n# not this\n```\n\n# This One #\n'), 'This One');
    assert.equal(headingOf('no heading'), null);
    assert.equal(chooseTitle('Asked', doc('a.md', '# H'), 'folder'), 'Asked');
    assert.equal(chooseTitle(null, doc('a.md', '# H'), 'folder'), 'H');
    assert.equal(chooseTitle(null, doc('a.html', '<h1>x</h1>', 'html'), 'folder'), 'folder');
    assert.equal(chooseTitle(null, undefined, 'folder'), 'folder');
    assert.equal(chooseTitle('文'.repeat(250), null, 'f'), '文'.repeat(200), 'counted in characters');
});

test('every root README and index is known by name, in order: README before index, the commonest form first', () => {
    for (const name of ['README.md', 'Readme.markdown', 'readme.txt', 'README', 'index.md', 'Index.html', 'INDEX.HTM']) {
        assert.equal(chooseDefault(['a.md', name]), name, name);
    }
    const leastFirst = ['index.htm', 'index.html', 'index.md', 'readme', 'readme.txt', 'readme.markdown', 'readme.md'];
    leastFirst.forEach((name, i) => assert.equal(chooseDefault(['a.md', ...leastFirst.slice(0, i + 1)]), name, name + ' wins over those before it'));
});

test('front matter names a document only from its very start, by a title line of its own', () => {
    assert.equal(headingOf('---\ntitle:Plain\n---\n'), 'Plain', 'no space is needed after the colon');
    assert.equal(headingOf('---\nsubtitle: Sub\ntitle: Main\n---\n'), 'Main');
    assert.equal(headingOf('---\nauthor: A\n---\n# From Heading\n'), 'From Heading', 'front matter with no title gives way to the heading');
    assert.equal(headingOf('# Real\n\n---\ntitle: Wrong\n---\n'), 'Real', 'a block lower down is no front matter');
    assert.equal(headingOf('---\r\ntitle: Windows\r\n---\r\n'), 'Windows');
    assert.equal(headingOf("---\ntitle: 'Single'\n---\n"), 'Single');
    assert.equal(headingOf('---\ntitle: "  Padded  "\n---\n'), 'Padded', 'inside its quotes too');
    assert.equal(headingOf('---\ntitle: "Spaced after"   \n---\n'), 'Spaced after', 'spaces after the closing quote');
    assert.equal(headingOf('---\ntitle: Say "hi"\n---\n'), 'Say "hi"', 'quotes come off only when they wrap the whole title');
    assert.equal(headingOf('---\ntitle: "Quoted" Subtitle\n---\n'), '"Quoted" Subtitle');
});

test('a code fence opens at a line\'s start with three marks or more; a heading is a first-level one at a line\'s start', () => {
    for (const before of ['Run ``` inline', '`code` first', '``two ticks', '~struck~', '~~ two tildes', '    ```']) {
        assert.equal(headingOf(before + '\n# After\n'), 'After', before);
    }
    assert.equal(headingOf('~~~\n# hidden\n~~~\n   ```js\n# hidden too\n```\n# Shown\n'), 'Shown');
    assert.equal(headingOf('Issue # 5\n# Real\n'), 'Real', 'a hash inside a line is no heading');
    assert.equal(headingOf('    # Indented code\n# Real\n'), 'Real');
    assert.equal(headingOf('#NoSpace\n## Second level\n# First\n'), 'First');
    assert.equal(headingOf('#  Two spaces in\n'), 'Two spaces in');
    for (const [line, title] of [['# Learning C#', 'Learning C#'], ['# C# #', 'C#'], ['# Title ##', 'Title'], ['# Title #  ', 'Title'], ['# Title\t#', 'Title'],
        ['# #', null], ['#  ##', null], ['#', null], ['# ', null], ['# a #b', 'a #b']]) {
        assert.equal(headingOf(line + '\n# Later\n'), title, 'closing hashes only after a space, as CommonMark has it: ' + line);
    }
    assert.equal(headingOf('#\tTabbed\n'), 'Tabbed');
});

test('an empty first heading names nothing, closed with hashes or not', () => {
    for (const empty of ['# ', '#   ', '# #', '#  ##', '# \t#  ']) {
        assert.equal(headingOf(empty + '\n# Later\n'), null, JSON.stringify(empty));
    }
    assert.equal(chooseTitle(null, doc('a.md', '# #\n'), 'folder'), 'folder');
});

test('only a markdown document is read for a heading, and the title is trimmed whichever names it', () => {
    assert.equal(chooseTitle(null, doc('a.html', '# Looks like markdown\n<p>x</p>', 'html'), 'folder'), 'folder');
    assert.equal(chooseTitle('  Asked  ', null, 'f'), 'Asked');
    assert.equal(chooseTitle(null, null, '  folder  '), 'folder');
});

test('the default document comes first, then natural order', () => {
    const ordered = orderDocuments([doc('main.py'), doc('index.html'), doc('docs/setup.md'), doc('README.md'), doc('doc10.md'), doc('doc2.md')], 'README.md');
    assert.deepEqual(ordered.map((one) => one.path), ['README.md', 'doc2.md', 'doc10.md', 'docs/setup.md', 'index.html', 'main.py']);
});

test('images a document shows are sent once per content; an SVG shown is an image, unshown a document', () => {
    const documents = [doc('a.md', '![x](x.png) ![y](y.png) ![s](s.svg)'), { ...doc('s.svg', '<svg/>', 'code'), svg: true }, { ...doc('t.svg', '<svg/>', 'code'), svg: true }];
    const images = [
        { path: 'x.png', sha256: 'same' }, { path: 'y.png', sha256: 'same' }, { path: 'z.png', sha256: 'z' },
        { path: 's.svg', sha256: 's' }, { path: 't.svg', sha256: 't' },
    ];
    const plan = planImages(documents, images);
    assert.deepEqual(plan.send.map((one) => one.path), ['x.png', 's.svg']);
    assert.deepEqual(plan.documents.map((one) => one.path), ['a.md', 't.svg']);
    assert.deepEqual(plan.unshown, ['z.png']);
    const missing = planImages([doc('a.md', '![x](x.png) ![gone](gone.png)')], [{ path: 'x.png', sha256: 'x' }]);
    assert.deepEqual([...missing.shown], ['x.png'], 'an image the folder does not hold is not shown, so it is warned of');
});

test('the folder is checked by the editor\'s own rules, with no document cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => doc('d' + i + '.md'));
    assert.deepEqual(preflight(many, { defaultPath: 'd0.md' }), [], 'the plan\'s cap is the server\'s to say');
    assert.deepEqual(preflight([], {}).map((one) => one.code), ['no_documents']);
    assert.deepEqual(preflight([doc('a.md')], { defaultPath: null }).map((one) => one.code), ['default_missing']);
    assert.deepEqual(preflight([doc('a.md', 'x'.repeat(524289))], { defaultPath: 'a.md' }).map((one) => one.code), ['file_size']);
    assert.deepEqual(preflight([doc('a.md')], { defaultPath: 'a.md', fatal: [{ code: 'too_many_entries' }] }).map((one) => one.code), ['too_many_entries']);
});

test('an update is added, changed, unchanged and removed documents; a case-only rename is a conflict', () => {
    const local = [doc('same.md', 's'), doc('edit.md', 'new'), doc('add.md', 'a'), doc('Case.md', 'c')];
    const remote = [doc('same.md', 's'), doc('edit.md', 'old'), doc('gone.md', 'g'), doc('case.md', 'c')];
    const diff = diffDocuments(local, remote);
    assert.deepEqual(diff.add.map((one) => one.path), ['add.md']);
    assert.deepEqual(diff.change.map((one) => one.path), ['edit.md']);
    assert.deepEqual(diff.unchanged.map((one) => one.path), ['same.md']);
    assert.deepEqual(diff.remove.map((one) => one.path), ['gone.md'], 'the conflicting remote document is not removed');
    assert.deepEqual(diff.conflicts, [{ code: 'case_rename', path: 'Case.md', target: 'case.md' }]);
});

test('a replaced document keeps a type the editor chose on purpose, and only then says one', () => {
    assert.deepEqual(documentPayload(doc('a.md', 'x')), { path: 'a.md', content: 'x' });
    assert.deepEqual(documentPayload(doc('a.md', 'y'), { path: 'a.md', content: '# x', content_type: 'markdown' }), { path: 'a.md', content: 'y' });
    assert.deepEqual(documentPayload(doc('a.md', 'y'), { path: 'a.md', content: '# x', content_type: 'code' }), { path: 'a.md', content: 'y', content_type: 'code' });
});

test('requests are cut under the budget, in order, and never empty', () => {
    const payloads = Array.from({ length: 5 }, (_, i) => ({ path: i + '.md', content: 'x'.repeat(40) }));
    const batches = batchesOf(payloads, 140); // each weighs 69 bytes as JSON
    assert.deepEqual(batches.map((batch) => batch.map((one) => one.path)), [['0.md', '1.md'], ['2.md', '3.md'], ['4.md']]);
    assert.deepEqual(batchesOf([{ path: 'huge', content: 'x'.repeat(500) }], 100).length, 1, 'one too large for the budget still goes, alone');
    assert.deepEqual(batchesOf([]), []);
    assert.equal(MAX_REQUEST_BYTES, 16777216);
});

test('a request holds what fits its budget to the byte, each document counted with its comma', () => {
    const payloads = Array.from({ length: 3 }, (_, i) => ({ path: i + '.md', content: 'x'.repeat(40) })); // 68 bytes of JSON each, 69 with its comma
    assert.deepEqual(batchesOf(payloads, 138).map((batch) => batch.length), [2, 1], 'two fill 138 bytes exactly');
    assert.deepEqual(batchesOf(payloads, 137).map((batch) => batch.length), [1, 1, 1], 'a byte less, and each goes alone');
});
