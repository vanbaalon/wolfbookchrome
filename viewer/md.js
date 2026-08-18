// md.js — a small markdown subset for .wb markup cells.
//
// Supports: headings, fenced/inline code, bold, italic, links, images, lists,
// blockquotes, horizontal rules, paragraphs, and $…$ / $$…$$ math (emitted as
// placeholder spans carrying the TeX; wb-viewer typesets them with KaTeX).
//
// TWO DELIBERATE DECISIONS:
//
// 1. Raw HTML PASSES THROUGH rather than being escaped. It has to: the .nb
//    importer turns a pasted picture into a markdown cell containing an <img>,
//    and notebooks in the wild use <sub>, <br>, <details>. The safety story is
//    not escaping here — it is that wb-viewer runs this output through the same
//    sanitiser as stored cell outputs, which also resolves image paths. A lone
//    `<` that does not begin a tag is still escaped, so `a < b` survives.
//
// 2. Math is extracted BEFORE anything else and reinserted as an opaque token,
//    so `$a_1 * b_2$` is not mangled by the emphasis rules.
//
// This is not a markdown engine. If it ever needs to be one, vendor markdown-it
// and route it through the same sanitiser.

/** Escape only what would otherwise corrupt the HTML we emit. */
function escText(s) {
  return s
    // `&` that is not already an entity
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]{0,9};|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};)/g, '&amp;')
    // `<` that does not open a tag or a comment
    .replace(/<(?![/!a-zA-Z])/g, '&lt;');
}

/** Escape everything — for content that must never be read as markup. */
function escStrict(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderMarkdown(src) {
  const math = [];
  // The placeholder must survive trimming and every inline rule. An earlier
  // version wrapped it in spaces, which `line.trim()` then stripped, so a
  // display equation on its own line came out as the literal text "M0".
  const stash = (tex, display) => `@@WBMATH${math.push({ tex, display }) - 1}@@`;

  // Pull math out first, longest delimiter first.
  let text = String(src ?? '')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(tex, true))
    .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, pre, tex) => pre + stash(tex, false));

  const lines = text.split('\n');
  const out = [];
  let para = [];
  let inCode = false, codeLines = [], codeLang = '', codeFence = '';
  /** Stack of open lists: [{ tag: 'ul'|'ol', indent: number }] */
  let lists = [];

  const inline = (s) => {
    let h = escText(s);
    // Inline code before emphasis, so `*` inside code is literal.
    const codes = [];
    h = h.replace(/`([^`]+)`/g, (_, c) => `@@WBCODE${codes.push(c) - 1}@@`);
    h = h.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_, alt, url) => `<img alt="${escStrict(alt)}" src="${escStrict(url)}">`);
    h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label, url) => `<a href="${escStrict(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    // Strikethrough. Safe beside ~~~ fences: those are matched at line level
    // before any inline rule runs.
    h = h.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    h = h.replace(/@@WBCODE(\d+)@@/g, (_, i) => `<code>${escStrict(codes[+i])}</code>`);
    h = h.replace(/@@WBMATH(\d+)@@/g, (_, i) => {
      const m = math[+i];
      return `<span class="wb-math${m.display ? ' wb-math-display' : ''}" `
           + `data-tex="${escStrict(m.tex)}"><code>${escStrict(m.tex)}</code></span>`;
    });
    return h;
  };

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      out.push(`</${lists.pop().tag}>`);
    }
  };
  const emitCode = () => {
    out.push(`<pre class="wb-md-code" data-lang="${escStrict(codeLang)}">`
           + `<code>${escStrict(codeLines.join('\n'))}</code></pre>`);
    inCode = false; codeLines = []; codeLang = ''; codeFence = '';
  };

  /** GFM pipe table starting at `i`, or null. */
  const tableAt = (i) => {
    const head = lines[i], sep = lines[i + 1];
    if (!head || !sep || !head.includes('|')) return null;
    if (!/^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(sep) || !sep.includes('-')) return null;
    const split = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const aligns = split(sep).map((c) =>
      c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right'
        : c.startsWith(':') ? 'left' : '');
    const cells = split(head);
    if (cells.length < 2) return null;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(split(lines[j]));
    return { cells, aligns, rows, next: j };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code: ``` or ~~~ (both are CommonMark; notebooks in this workspace
    // use ~~~wolfram, which the earlier ```-only version silently flattened into
    // a paragraph).
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      if (inCode) {
        // Only a fence of the SAME kind closes the block, so ``` inside a ~~~
        // block stays literal.
        if (marker === codeFence) { emitCode(); continue; }
      } else {
        flushPara(); flushList();
        inCode = true; codeFence = marker; codeLang = fence[2] || '';
        continue;
      }
    }
    if (inCode) { codeLines.push(line); continue; }

    const table = tableAt(i);
    if (table) {
      flushPara(); flushList();
      const th = table.cells.map((c, k) =>
        `<th${table.aligns[k] ? ` style="text-align:${table.aligns[k]}"` : ''}>${inline(c)}</th>`).join('');
      const body = table.rows.map((r) =>
        '<tr>' + table.cells.map((_, k) =>
          `<td${table.aligns[k] ? ` style="text-align:${table.aligns[k]}"` : ''}>${inline(r[k] || '')}</td>`
        ).join('') + '</tr>').join('');
      out.push(`<table class="wb-md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      i = table.next - 1;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }

    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const m = ul || ol;
      const indent = m[1].replace(/\t/g, '    ').length;
      const tag = ul ? 'ul' : 'ol';
      // Close any lists indented deeper than this item, then open one if this
      // item starts a new (possibly nested) level.
      flushList(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) { out.push(`<${tag}>`); lists.push({ tag, indent }); }
      else if (top.tag !== tag) { out.push(`</${top.tag}>`); lists.pop(); out.push(`<${tag}>`); lists.push({ tag, indent }); }
      out.push(`<li>${inline(m[2])}</li>`);
      continue;
    }

    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) { flushPara(); flushList(); out.push(`<blockquote><p>${inline(bq[1])}</p></blockquote>`); continue; }

    if (!line.trim()) { flushPara(); flushList(); continue; }
    para.push(line.trim());
  }
  if (inCode) emitCode();
  flushPara(); flushList();
  return out.join('\n');
}
