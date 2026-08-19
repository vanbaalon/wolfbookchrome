// Unit checks for the markdown subset (viewer/md.js).
//
// NOTE ON SAFETY: md.js deliberately lets raw HTML through — markdown cells
// produced by the .nb importer contain <img> tags, and notebooks use <sub>,
// <br>, <details>. Sanitising is the VIEWER's job (wb-viewer runs this output
// through the same sanitiser as stored outputs), so the assertions here are
// about markdown correctness, and check-browser.mjs proves the sanitising.
import { renderMarkdown } from '../extension/viewer/md.js';

let failures = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? `  — ${extra}` : ''}`);
  if (!cond) failures++;
};

const h = renderMarkdown('# Title\n\nSome **bold** and `code` and $E=mc^2$.\n\n- one\n- two\n\n```wolfram\nSin[x]\n```');
check('heading', h.includes('<h1>Title</h1>'));
check('bold', h.includes('<strong>bold</strong>'));
check('inline code', h.includes('<code>code</code>'));
check('inline math placeholder carries tex', h.includes('data-tex="E=mc^2"'));
check('list', h.includes('<ul>') && h.includes('<li>one</li>'));
check('fenced code', h.includes('Sin[x]') && h.includes('wb-md-code'));

check('display math', renderMarkdown('$$\\int_0^1 x\\,dx$$').includes('wb-math-display'));
check('math is not mangled by emphasis rules',
  renderMarkdown('$a_1 * b_2 * c$').includes('data-tex="a_1 * b_2 * c"'));
check('escaped \\$ is not treated as math', !renderMarkdown('costs \\$5 and \\$6').includes('wb-math'));

// Raw HTML passthrough — required by .nb-imported notebooks.
check('raw HTML passes through', renderMarkdown('a <sub>x</sub> b').includes('<sub>x</sub>'));
check('raw img passes through', renderMarkdown('<img src="img/nb/x.png">').includes('src="img/nb/x.png"'));
check('stray < is escaped', renderMarkdown('if a < b then').includes('a &lt; b'));
check('bare & is escaped', renderMarkdown('Tom & Jerry').includes('Tom &amp; Jerry'));
check('existing entity is left alone', renderMarkdown('5 &amp; 6').includes('5 &amp; 6'));

// Code spans must not be interpreted as anything else.
check('markdown inside code span is literal',
  renderMarkdown('`**not bold**`').includes('<code>**not bold**</code>'));
check('html inside code span is escaped',
  renderMarkdown('`<b>x</b>`').includes('<code>&lt;b&gt;x&lt;/b&gt;</code>'));

// Tilde fences — notebooks in this workspace use ~~~wolfram, and a ```-only
// renderer silently flattened those blocks into a paragraph.
const tilde = renderMarkdown('~~~wolfram\nbr[q[A][i][down], alpha]\n~~~');
check('~~~ fence makes a code block', tilde.includes('wb-md-code'));
check('~~~ fence keeps its language', tilde.includes('data-lang="wolfram"'));
check('~~~ fence keeps content verbatim', tilde.includes('br[q[A][i][down], alpha]'));
check('~~~ fence content is not paragraph-joined', !tilde.includes('<p>~~~'));
check('``` inside a ~~~ block stays literal',
  renderMarkdown('~~~\n```\nstill code\n~~~').includes('still code'));
check('``` fence still works', renderMarkdown('```wolfram\nSin[x]\n```').includes('data-lang="wolfram"'));

// Strikethrough must not be confused with a tilde fence.
check('strikethrough', renderMarkdown('a ~~gone~~ b').includes('<del>gone</del>'));

// GFM tables.
const tbl = renderMarkdown('| a | b |\n|---|--:|\n| 1 | 2 |\n| 3 | 4 |');
check('table renders', tbl.includes('<table class="wb-md-table"'));
check('table header', tbl.includes('<th') && tbl.includes('a</th>'));
check('table rows', (tbl.match(/<tr>/g) || []).length === 3);
check('table alignment', tbl.includes('text-align:right'));
check('a lone pipe line is not a table', !renderMarkdown('a | b').includes('<table'));

// Nested lists.
const nested = renderMarkdown('- one\n  - inner\n- two');
check('nested list opens a second <ul>', (nested.match(/<ul>/g) || []).length === 2);
check('nested list closes both', (nested.match(/<\/ul>/g) || []).length === 2);

check('image syntax', renderMarkdown('![p](img/nb/x.png)').includes('src="img/nb/x.png"'));
check('link gets noopener',
  renderMarkdown('[t](https://e.com)').includes('rel="noopener noreferrer"'));
check('horizontal rule', renderMarkdown('---').includes('<hr>'));
check('blockquote', renderMarkdown('> quoted').includes('<blockquote>'));
check('ordered list', renderMarkdown('1. first\n2. second').includes('<ol>'));

process.exit(failures ? 1 : 0);
