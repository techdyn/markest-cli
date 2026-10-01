import test from 'node:test';
import assert from 'node:assert/strict';
import { imageTargets, localWarnings, maskMarkdownCode, resolveReference, rewriteImageRefs } from '../src/publish/image-refs.mjs';

const at = (map) => new Map(Object.entries(map));

test('a reference resolves from the document\'s folder, or from the root after a slash', () => {
    assert.deepEqual(resolveReference('docs/a.md', 'img/x.png'), { path: 'docs/img/x.png' });
    assert.deepEqual(resolveReference('docs/a.md', '../img/x.png'), { path: 'img/x.png' });
    assert.deepEqual(resolveReference('docs/a.md', '/img/x.png'), { path: 'img/x.png' });
    assert.deepEqual(resolveReference('a.md', './img/My%20Chart.png?v=2#top'), { path: 'img/My Chart.png' });
    assert.deepEqual(resolveReference('a.md', '<img/a b.png>'), { path: 'img/a b.png' });
    assert.deepEqual(resolveReference('a.md', '../x.png'), { outside: true });
    for (const external of ['https://e.test/x.png', '//e.test/x.png', 'data:image/png;base64,AA', '#top', 'mailto:a@b.test', '']) {
        assert.equal(resolveReference('a.md', external), null, external);
    }
});

test('markdown images and reference definitions are found; code is not', () => {
    const text = [
        '![a](x.png) ![b](<y z.png> "T") ![c](w.png (paren))',
        '[ref]: r.png',
        '`![inline](no1.png)`',
        '```',
        '![fenced](no2.png)',
        '```',
        '~~~~',
        '![tilde](no3.png)',
        '~~~~',
        '[link](l.png) ![escaped]\\(no4.png)',
    ].join('\n');
    assert.deepEqual(imageTargets(text, 'a.md', 'markdown').sort(), ['r.png', 'w.png', 'x.png', 'y z.png']);
    assert.equal(maskMarkdownCode(text).length, text.length, 'masking keeps every offset');
});

test('HTML src, srcset, poster, icons and CSS url() are found', () => {
    const html = '<img src="a.png"><img srcset="b.png 1x, c.png 2x"><video poster=\'d.png\'></video>'
        + '<link rel="icon" href="e.png"><div style="background:url(f.png)"></div><style>.x{background:url("g.png")}</style>'
        + '<a href="h.png">h</a><script src="app.js"></script>';
    assert.deepEqual(imageTargets(html, 'index.html', 'html').sort(), ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png']);
    assert.deepEqual(imageTargets('print("![x](x.png)")', 'a.py', 'code'), [], 'code shows nothing');
});

test('rewriting replaces the whole destination and nothing else', () => {
    const md = '# T\n\n![a](img/x.png?v=2 "Title") and ![b](img/y.png)\n\n```\n![c](img/x.png)\n```\n[r]: img/x.png\n';
    const out = rewriteImageRefs(md, 'README.md', 'markdown', at({ 'img/x.png': '/img/P/X' }));
    assert.equal(out, '# T\n\n![a](/img/P/X "Title") and ![b](img/y.png)\n\n```\n![c](img/x.png)\n```\n[r]: /img/P/X\n');
    const html = '<img srcset="a.png 1x, b.png 2x" src=\'a.png#frag\'>';
    assert.equal(rewriteImageRefs(html, 'i.html', 'html', at({ 'a.png': '/img/P/A', 'b.png': '/img/P/B' })),
        '<img srcset="/img/P/A 1x, /img/P/B 2x" src=\'/img/P/A\'>');
    assert.equal(rewriteImageRefs(md, 'README.md', 'markdown', new Map()), md, 'nothing to point at leaves the text byte for byte');
});

test('what will not work once published is said', () => {
    const codes = (text, path, type, sending = new Set()) => localWarnings(text, path, type, sending).map((w) => w.code + ':' + w.target);
    assert.deepEqual(codes('![a](gone.png) [b](pic.png) ![c](../up.png)', 'a.md', 'markdown'), ['unpublished_image:gone.png', 'image_link:pic.png', 'outside_folder:../up.png']);
    assert.deepEqual(codes('<link rel="stylesheet" href="s.css"><script src="a.js"></script><a href="two.html">2</a><iframe src="f.html"></iframe>', 'i.html', 'html'),
        ['html_local_resource:s.css', 'html_local_resource:a.js', 'html_page_link:two.html', 'html_page_link:f.html']);
    assert.deepEqual(codes('![a](x.png)', 'a.md', 'markdown', new Set(['x.png'])), []);
});

test('a destination is trimmed, a scheme is one only at its start, and a query or anchor alone is nothing', () => {
    const cases = [
        ['  x.png  ', { path: 'x.png' }],
        ['< x.png >', { path: 'x.png' }],
        ['<x.png', { path: '<x.png' }],
        ['x.png>', { path: 'x.png>' }],
        ['img/x.png?ref=docs:intro', { path: 'img/x.png' }],
        ['x.png?caption=a b', { path: 'x.png' }],
        ['x.png#a b', { path: 'x.png' }],
    ];
    for (const [raw, expected] of cases) assert.deepEqual(resolveReference('a.md', raw), expected, raw);
    for (const nothing of [undefined, null, '/', '?v=2', '#', '<>']) {
        assert.equal(resolveReference('docs/a.md', nothing), null, String(nothing));
    }
});

test('a markdown image is read in every form CommonMark gives one, and nothing else is', () => {
    const cases = [
        // Space, tab or a line end before the destination, around a title, and each kind of title.
        ['![a]( x.png )', ['x.png']],
        ['![a](\tx.png)', ['x.png']],
        ['![a](\nx.png)', ['x.png']],
        ['![a](x.png\t"T")', ['x.png']],
        ['![a](x.png\n"T")', ['x.png']],
        ["![a](x.png 'T')", ['x.png']],
        ['![a](x.png "T" )', ['x.png']],
        ['![a](x.png "T"\t)', ['x.png']],
        ['![a](x.png "T"\n)', ['x.png']],
        // Parentheses in a name, brackets and escapes in the text, escapes in the name.
        ['![a](a(1).png)', ['a(1).png']],
        ['![a](a\\(b.png)', ['a(b.png']],
        ['![a](chart\\_v2.png)', ['chart_v2.png']],
        ['![a [b] c](x.png)', ['x.png']],
        ['![a\\]b](x.png)', ['x.png']],
        ['![\\_a](x.png)', ['x.png']],
        ['![a\nb](x.png)', ['x.png']],
        // Reference definitions: no space, more space, the destination on the next line, in angle brackets, escaped.
        ['[r]:x.png', ['x.png']],
        ['[r]:  x.png', ['x.png']],
        ['[r]:\nx.png', ['x.png']],
        ['[r]:\n  x.png', ['x.png']],
        ['[r]: <a b.png>', ['a b.png']],
        ['[r]: a\\_b.png', ['a_b.png']],
        // Not an image: an unquoted word after the name, no closing parenthesis or title, a line end in angle
        // brackets, a blank line in the text (even after a backslash), a bracket for a parenthesis, an unclosed
        // bracket, a definition that does not start its line.
        ['![a](x.png junk)', []],
        ['![a](x.png', []],
        ['![a](<x\n.png>)', []],
        [') ![a](x.png "unclosed', []],
        ['![a\n\nb](x.png)', []],
        ['![a\\\n\nb](x.png)', []],
        ['![a][x.png)', []],
        ['(x.png) ![a', []],
        ['ab(x.png) ![a', []],
        ['ab(x.png) ![a\n\nb](y.png)', []],
        ['see [r]: x.png', []],
        // A remote image is passed over; the local one beside it is not.
        ['![r](https://e.test/x.png) ![l](l.png)', ['l.png']],
    ];
    for (const [text, expected] of cases) assert.deepEqual(imageTargets(text, 'a.md', 'markdown'), expected, JSON.stringify(text));
});

test('fenced blocks open and close as CommonMark says, and code spans of any length are masked', () => {
    const cases = [
        ['``![x](no.png)``', []],
        ['```\n```text\n![a](no.png)\n```\n![b](b.png)', ['b.png']],
        ['```\nx ```\n![a](no.png)\n```\n![b](b.png)', ['b.png']],
        ['```\n~~~\n![a](no.png)\n```\n![b](b.png)', ['b.png']],
        ['````\n```\n![a](no.png)\n````\n![b](b.png)', ['b.png']],
        ['~~~\n![a](no.png)\n~~~\n![b](b.png)', ['b.png']],
        ['```\r\n![a](no.png)\r\n```\r\n![b](b.png)', ['b.png']],
        ['Use ``` to fence.\n![a](a.png)', ['a.png']],
        ['~~struck~~ ![s](s.png)', ['s.png']],
    ];
    for (const [text, expected] of cases) {
        assert.deepEqual(imageTargets(text, 'a.md', 'markdown'), expected, JSON.stringify(text));
        assert.equal(maskMarkdownCode(text).length, text.length, 'masking keeps every offset');
    }
});

test('HTML values are read quoted or not, trimmed, on SVG images and sprites, and never in a code document', () => {
    assert.deepEqual(imageTargets('<img src=" a.png "><img src=b.png alt=x>', 'i.html', 'html'), ['a.png', 'b.png']);
    assert.deepEqual(imageTargets('<svg><image href="p.png"/><use xlink:href="s.svg#i"/></svg>', 'i.html', 'html'), ['p.png', 's.svg']);
    assert.deepEqual(imageTargets('el.innerHTML = \'<img src="x.png">\';', 'app.js', 'code'), []);
});

test('rewriting walks the destinations in the order the text holds them, and never one inside another', () => {
    const both = at({ 'a.png': '/img/P/A', 'b.png': '/img/P/B' });
    const md = '[r]: a.png\n![x](b.png)';
    assert.deepEqual(imageTargets(md, 'a.md', 'markdown'), ['a.png', 'b.png']);
    assert.equal(rewriteImageRefs(md, 'a.md', 'markdown', both), '[r]: /img/P/A\n![x](/img/P/B)');
    assert.equal(rewriteImageRefs('<div style="background:url(a.png)"></div><img src="b.png">', 'i.html', 'html', both),
        '<div style="background:url(/img/P/A)"></div><img src="/img/P/B">');
    assert.equal(rewriteImageRefs('![a](x(![b](y.png)).png)', 'a.md', 'markdown', at({ 'x(![b](y.png)).png': '/img/P/X', 'y.png': '/img/P/Y' })),
        '![a](/img/P/X)');
    assert.equal(rewriteImageRefs('<img src=x.png?url(>y.png)', 'i.html', 'html', at({ 'x.png': '/img/P/X', '>y.png': '/img/P/Y' })),
        '<img src=/img/P/X/img/P/Y)', 'a destination starting where another ends is rewritten too');
    assert.equal(rewriteImageRefs('![a](chart\\_v2.png?v=1)', 'a.md', 'markdown', at({ 'chart_v2.png': '/img/P/C' })), '![a](/img/P/C)');
});

test('a link to a page, a script or stylesheet beside a page and a markdown link to an image are told apart', () => {
    const codes = (text, path, type) => localWarnings(text, path, type, new Set()).map((w) => w.code + ':' + w.target);
    const cases = [
        ['<a href="h.png">h</a>', 'i.html', 'html', ['html_page_link:h.png']],
        ['<a href="theme.css">t</a><a href="app.js">a</a>', 'i.html', 'html', ['html_page_link:theme.css', 'html_page_link:app.js']],
        ['<link rel="preload" href="font.woff2">', 'i.html', 'html', []],
        ['<script type="module" src="app.mjs"></script>', 'i.html', 'html', ['html_local_resource:app.mjs']],
        ['[doc](b.md) [shot](s.png)', 'a.md', 'markdown', ['image_link:s.png']],
        ['\\[a](pic.png)', 'a.md', 'markdown', []],
    ];
    for (const [text, path, type, expected] of cases) assert.deepEqual(codes(text, path, type), expected, text);
    for (const type of ['markdown', 'html', 'code']) {
        assert.deepEqual(codes('../notes.png', 'a', type), [], 'a path written as plain text refers to nothing in ' + type);
    }
});

test('line ends, blank lines and runs of backslashes are read as CommonMark reads them', () => {
    const cases = [
        // A line of spaces and tabs, or a Windows one, is a blank line; a hard line break and a line end
        // with text on both sides are not.
        ['![a\n \t \nb](x.png)', []],
        ['![a\r\n\r\nb](x.png)', []],
        ['![a  \nb](x.png)', ['x.png']],
        ['![a\nb](x.png)\nmore', ['x.png']],
        // At most one line end, Windows' or not, before a destination, before its title and before the parenthesis.
        ['![a](\n\tx.png)', ['x.png']],
        ['![a](\r\nx.png)', ['x.png']],
        ['![a](x.png\r\n"T")', ['x.png']],
        ['![a](x.png "T"\r\n)', ['x.png']],
        ['![a](\n\nx.png)', []],
        ['![a](x.png\n\n"T")', []],
        ['![a](x.png "T"\n\n)', []],
        ['![a](x.png\n  \n)', []],
        // Two backslashes are an escaped backslash, three that and an escaped "!".
        ['\\\\![a](x.png)', ['x.png']],
        ['\\\\\\![a](x.png)', []],
    ];
    for (const [text, expected] of cases) assert.deepEqual(imageTargets(text, 'a.md', 'markdown'), expected, JSON.stringify(text));
    const warned = (text) => localWarnings(text, 'a.md', 'markdown', new Set()).map((w) => w.code + ':' + w.target);
    assert.deepEqual(warned('\\![a](x.png) [b](y.png)'), ['image_link:x.png', 'image_link:y.png']);
    assert.deepEqual(warned('\\\\\\[a](x.png)'), [], 'an odd run of backslashes escapes the bracket');
    assert.deepEqual(warned('\\\\[a](x.png)'), ['image_link:x.png'], 'an even run escapes nothing after it');
});

test('HTML character references are decoded by name and by number, and nothing else is', () => {
    const shown = (src) => imageTargets('<img src="' + src + '">', 'i.html', 'html');
    const cases = [
        ['a&amp;b&lt;c&gt;d&quot;e&apos;f&#39;g.png', 'a&b<c>d"e\'f\'g.png'],
        ['x&#X4A;&#x4a;&#74;.png', 'xJJJ.png'],
        ['&#x10FFFF;.png', '\u{10FFFF}.png'],
        ['&#1114112;&#x110000;.png', '��.png'],
        ['a&amp.png', 'a&amp.png'],
        ['a&nbsp;b.png', 'a&nbsp;b.png'],
    ];
    for (const [src, path] of cases) assert.deepEqual(shown(src), [path], src);
    assert.deepEqual(imageTargets("<img src=a&amp;b.png><img src='c&#38;d.png'>", 'i.html', 'html'), ['a&b.png', 'c&d.png']);
});

test('an address is written only when it is a plain path, which no document reads specially', () => {
    const page = '<img src="a.png">';
    const text = '![a](a.png)';
    for (const odd of ['/img/P/A" onerror="x', '/img/P/A B', '/img/P/(A)', 'javascript:x', '']) {
        assert.equal(rewriteImageRefs(page, 'i.html', 'html', at({ 'a.png': odd })), page, odd);
        assert.equal(rewriteImageRefs(text, 'a.md', 'markdown', at({ 'a.png': odd })), text, odd);
    }
    assert.equal(rewriteImageRefs(page, 'i.html', 'html', at({ 'a.png': '/img/01J_Z-9/a.b~c%20' })), '<img src="/img/01J_Z-9/a.b~c%20">');
});
