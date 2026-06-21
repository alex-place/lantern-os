const path = require("path");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// GitHub-ish heading slug: lowercased, punctuation dropped, spaces → hyphens,
// unicode letters/numbers preserved (so anchors like #σ₀-sigma-zero work).
function slugify(text) {
  return String(text ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // strip link/image syntax, keep label
    .replace(/[`*_~]/g, "")                    // strip inline emphasis markers
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")         // drop punctuation, keep letters/numbers
    .replace(/\s+/g, "-");
}

// Bold / italic / strikethrough on an already-escaped string. Placeholders
// ( N ) for stashed inline HTML pass through untouched.
function emphasize(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
}

// Inline renderer. Stashes code spans, images, links and autolinks as opaque
// placeholders so emphasis parsing can't corrupt their URLs, then restores them
// (iteratively, so a linked image — [![alt](img)](href) — nests correctly).
function inlineMarkdown(value) {
  const stash = [];
  const hold = (html) => ` ${stash.push(html) - 1} `;
  let s = String(value ?? "");

  // Inline code — content escaped, no further inline parsing inside.
  s = s.replace(/`([^`]+)`/g, (_m, code) => hold(`<code>${escapeHtml(code)}</code>`));

  // Images (must run before links so a linked badge's image is captured first).
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, alt, src, title) =>
      hold(
        `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"` +
          (title ? ` title="${escapeHtml(title)}"` : "") +
          ` loading="lazy">`
      )
  );

  // Links — the label may already contain a stashed image placeholder.
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, label, href, title) => {
      const rel = /^https?:/i.test(href) ? ' rel="noopener"' : "";
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return hold(
        `<a href="${escapeHtml(href)}"${t}${rel}>${emphasize(escapeHtml(label))}</a>`
      );
    }
  );

  // Autolinks: <https://…> and <mailto:…>
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_m, url) =>
    hold(`<a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(url.replace(/^mailto:/, ""))}</a>`)
  );

  // Escape the remaining plain text, then apply emphasis.
  s = emphasize(escapeHtml(s));

  // Restore stashed HTML (loop handles nested placeholders, e.g. img inside a link).
  for (let i = 0; i < 6 && s.indexOf(" ") !== -1; i++) {
    s = s.replace(/ (\d+) /g, (_m, idx) => stash[Number(idx)] ?? "");
  }
  return s;
}

// Render an array of markdown lines to an array of HTML fragments.
// Recursive so blockquotes can contain headings, lists, tables, etc.
function renderBlock(lines) {
  const body = [];
  let inCode = false;
  let inTable = false;
  let tableRows = [];
  let quoteBuf = null;
  let paraBuf = [];
  const listStack = []; // [{ indent, tag }]

  const flushPara = () => {
    if (paraBuf.length) {
      body.push(`<p>${inlineMarkdown(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeLists = () => {
    while (listStack.length) {
      const top = listStack.pop();
      body.push(`</li></${top.tag}>`);
    }
  };
  const closeTable = () => {
    if (inTable) {
      const rows = tableRows.filter((row) => !/^\s*\|?\s*:?-{3,}:?\s*\|/.test(row));
      body.push("<table>");
      rows.forEach((row, index) => {
        const cells = row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
        body.push(index === 0 ? "<thead><tr>" : "<tbody><tr>");
        cells.forEach((cell) => body.push(index === 0 ? `<th>${inlineMarkdown(cell)}</th>` : `<td>${inlineMarkdown(cell)}</td>`));
        body.push(index === 0 ? "</tr></thead>" : "</tr></tbody>");
      });
      body.push("</table>");
      tableRows = [];
      inTable = false;
    }
  };
  const flushQuote = () => {
    if (quoteBuf) {
      body.push("<blockquote>");
      renderBlock(quoteBuf).forEach((html) => body.push(html));
      body.push("</blockquote>");
      quoteBuf = null;
    }
  };
  // Add a list item, opening/closing nested <ul>/<ol> levels by indentation.
  const addListItem = (indent, tag, content) => {
    while (listStack.length && indent < listStack[listStack.length - 1].indent) {
      const top = listStack.pop();
      body.push(`</li></${top.tag}>`);
    }
    let top = listStack[listStack.length - 1];
    if (!top || indent > top.indent) {
      listStack.push({ indent, tag });
      body.push(`<${tag}>`);
    } else {
      body.push("</li>");
      if (top.tag !== tag) {
        body.push(`</${top.tag}><${tag}>`);
        top.tag = tag;
      }
    }
    // Task-list item: - [ ] / - [x]
    const task = content.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      const checked = task[1].toLowerCase() === "x" ? " checked" : "";
      body.push(`<li class="task"><input type="checkbox" disabled${checked}> ${inlineMarkdown(task[2])}`);
    } else {
      body.push(`<li>${inlineMarkdown(content)}`);
    }
  };

  lines.forEach((rawLine) => {
    const line = rawLine.replace(/\t/g, "    "); // tabs → spaces for indent math

    if (/^```/.test(line.trim())) {
      flushPara();
      closeLists();
      closeTable();
      flushQuote();
      body.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      return;
    }
    if (inCode) {
      body.push(`${escapeHtml(rawLine)}\n`);
      return;
    }
    // Blockquote: gather consecutive `>` lines, strip the marker, render recursively.
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      closeLists();
      closeTable();
      if (!quoteBuf) quoteBuf = [];
      quoteBuf.push(quote[1]);
      return;
    }
    flushQuote();
    if (/^\s*\|.+\|\s*$/.test(line)) {
      flushPara();
      closeLists();
      inTable = true;
      tableRows.push(line);
      return;
    }
    closeTable();
    // Horizontal rule: ---, ***, ___ (3+).
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      closeLists();
      body.push("<hr>");
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushPara();
      closeLists();
      const level = Math.min(heading[1].length, 6);
      const id = slugify(heading[2]);
      body.push(`<h${level}${id ? ` id="${escapeHtml(id)}"` : ""}>${inlineMarkdown(heading[2])}</h${level}>`);
      return;
    }
    const listItem = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushPara();
      const indent = listItem[1].length;
      const tag = /^\s*\d/.test(line) ? "ol" : "ul";
      addListItem(indent, tag, listItem[2]);
      return;
    }
    if (!line.trim()) {
      flushPara(); // blank line ends a paragraph but leaves lists open (loose lists)
      return;
    }
    // Plain text: a continuation line that isn't a new list item closes any list.
    closeLists();
    paraBuf.push(line.trim());
  });

  flushPara();
  closeLists();
  closeTable();
  flushQuote();
  if (inCode) body.push("</code></pre>");
  return body;
}

// Strip a leading YAML frontmatter block (--- ... ---) and parse its simple
// `key: value` pairs, so doc metadata (author, updated) renders as a tidy byline
// instead of a stray <hr> + paragraphs at the top of the page.
function parseFrontmatter(text) {
  const stripped = text.replace(/^﻿/, "");
  const m = stripped.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: stripped };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: stripped.slice(m[0].length) };
}

function renderMarkdownDocument(markdown, sourcePath) {
  const { meta, body: parsed } = parseFrontmatter(markdown.replace(/\r\n/g, "\n"));
  // Drop HTML comments (READMEs place badge rows next to <!-- … --> dividers).
  let content = parsed;
  for (let prev = null; prev !== content; ) {
    prev = content;
    content = content.replace(/<!--[\s\S]*?-->/g, "");
  }
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(sourcePath);
  const body = renderBlock(content.split("\n"));
  const byline = meta.author
    ? `<div class="md-byline">By ${escapeHtml(meta.author)}${meta.updated ? ` · Updated ${escapeHtml(meta.updated)}` : ""}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#06b6d4">
  <script>
    /* Theme bootstrap before first paint — follows the site's saved light/dark
       choice instead of forcing dark, matching index.html / the Knowledge Center. */
    (function () {
      try {
        var stored = localStorage.getItem('lantern-theme');
        var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', (stored ? stored === 'dark' : prefersDark) ? 'dark' : 'light');
      } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
    })();
  </script>
  <title>${escapeHtml(title)} — Keystone OS</title>
  <link rel="stylesheet" href="/css/site.css">
  <link rel="stylesheet" href="/css/narrator.css">
  <style>
    /* Doc reading view — built entirely on the site theme variables (css/site.css)
       so it follows the global light/dark toggle. No fixed palette, no web fonts:
       a clean centered card that inherits the site's "Segoe UI" sans. */
    .md-page {
      max-width: 820px; margin: 32px auto 96px; padding: 44px 56px 64px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 16px;
      font-size: 1.05rem; line-height: 1.75;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      overflow-wrap: anywhere;
    }
    .md-page p, .md-page li { margin: 0 0 1.05em; }
    .md-page li { margin-bottom: 0.5em; }
    .md-page li::marker { color: var(--accent); }
    .md-page ul ul, .md-page ol ol, .md-page ul ol, .md-page ol ul { margin: .4em 0 .2em; }
    .md-page li.task { list-style: none; margin-left: -1.2em; }
    .md-page li.task input { margin: 0 .5em 0 0; accent-color: var(--accent); vertical-align: middle; }
    .md-page h1, .md-page h2, .md-page h3, .md-page h4, .md-page h5, .md-page h6 {
      color: var(--text); line-height: 1.25; font-weight: 700; scroll-margin-top: 68px;
    }
    .md-page h1 { font-size: 2rem; font-weight: 800; margin: 0 0 .5em; letter-spacing: -0.02em; }
    .md-page h2 { font-size: 1.5rem; margin: 1.85em 0 .55em; padding-top: .7em; border-top: 1px solid var(--border); }
    .md-page h3 { font-size: 1.2rem; font-weight: 600; margin: 1.55em 0 .4em; }
    .md-page h4 { font-size: 0.9rem; font-weight: 700; margin: 1.4em 0 .3em; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .md-page a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    .md-page a:hover { color: var(--accent-hover); }
    .md-page strong { color: var(--text); font-weight: 700; }
    .md-page del { color: var(--muted); }
    .md-page img { max-width: 100%; height: auto; vertical-align: middle; }
    /* Badge / shield rows: keep small inline images tidy with a little breathing room. */
    .md-page p img { margin: 3px 5px 3px 0; border-radius: 3px; }
    .md-page code { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; background: var(--surface2); color: var(--accent); border: 1px solid var(--border); padding: 1px 6px; border-radius: 5px; font-size: 0.85em; }
    .md-page pre { background: var(--surface2); color: var(--text); border: 1px solid var(--border); overflow: auto; padding: 16px 18px; border-radius: 10px; margin: 1.4em 0; line-height: 1.55; }
    .md-page pre code { background: none; border: none; color: inherit; padding: 0; font-size: 0.85rem; }
    .md-page table { width: 100%; border-collapse: collapse; margin: 1.6em 0; font-size: 0.9rem; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .md-page th, .md-page td { border-bottom: 1px solid var(--border); padding: 10px 14px; text-align: left; vertical-align: top; line-height: 1.5; }
    .md-page thead th { background: var(--surface2); color: var(--text); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: .03em; }
    .md-page tbody tr:nth-child(even) { background: var(--surface2); }
    .md-page blockquote { margin: 1.5em 0; padding: 6px 22px; background: var(--surface2); border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0; color: var(--text); }
    .md-page blockquote h2 { margin-top: .6em; border-top: none; padding-top: 0; font-size: 1.2rem; }
    .md-page blockquote h3 { margin-top: .5em; }
    .md-page blockquote > :first-child { margin-top: .4em; }
    .md-page hr { border: none; border-top: 1px solid var(--border); margin: 2.4em 0; }
    .md-source { color: var(--muted); font-size: 0.8rem; margin-bottom: 26px; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; letter-spacing: .01em; }
    .md-byline { color: var(--muted); font-size: 0.82rem; margin: -18px 0 24px; }
    @media (max-width: 820px) { .md-page { padding: 28px 20px 48px; margin: 0; border-radius: 0; border-left: none; border-right: none; font-size: 1.02rem; } }

    /* ── Large-screen "newspaper" reading layout ──────────────────────────
       A single 820px column wastes most of a 1080p / ultrawide display and
       reads dense. On wider viewports the page widens and the body flows into
       balanced columns. Section headings (h1/h2) and wide blocks (code,
       tables, quotes, rules) span the FULL width like newspaper figures, so
       each section's columns reset and stay short — you read a section's
       columns left-to-right, not one endless ribbon. */
    @media (min-width: 1100px) {
      .md-page { max-width: 1240px; padding: 48px 64px 72px; }
      .md-page article {
        column-count: 2;
        column-gap: 52px;
        column-rule: 1px solid var(--border);
      }
      /* full-width spanners: section heads + wide blocks */
      .md-page article > h1,
      .md-page article > h2,
      .md-page article > pre,
      .md-page article > table,
      .md-page article > blockquote,
      .md-page article > hr { column-span: all; }
      /* keep atomic blocks from splitting across a column boundary */
      .md-page article > ul,
      .md-page article > ol,
      .md-page article li,
      .md-page article > figure,
      .md-page article > img { break-inside: avoid; }
      /* never strand a sub-heading at the foot of a column */
      .md-page article > h3,
      .md-page article > h4 { break-after: avoid; }
      .md-page h2 { margin-top: 1.2em; }
    }
    @media (min-width: 1700px) {
      .md-page { max-width: 1640px; }
      .md-page article { column-count: 3; column-gap: 56px; }
    }
    /* ultrawide (≈3440px and up) */
    @media (min-width: 2400px) {
      .md-page { max-width: 2200px; }
      .md-page article { column-count: 4; column-gap: 60px; }
    }
  </style>
</head>
<body>
<nav class="site-nav">
  <a class="nav-brand" href="/">
    <img src="/mandala.svg" alt="" aria-hidden="true" style="width:24px;height:24px;vertical-align:middle">
    <span style="font-size:18px;font-weight:600">Keystone OS</span>
  </a>
  <div class="nav-links">
    <a href="/dream-chat.html">Chat</a>
    <a href="/trader-dashboard.html">Trader</a>
    <a href="/create.html">Create</a>
    <a href="/explore.html">Explore</a>
    <a href="/knowledgecenter.html" class="active">Help</a>
    <span class="sep" style="margin: 0 4px;">·</span>
    <a href="https://www.patreon.com/lanternos" class="nav-support" target="_blank" rel="noopener noreferrer">♥ Support Keystone on Patreon</a>
  </div>
  <div class="nav-actions">
    <a href="/profile.html" class="nav-btn" id="profile-btn" title="Your profile" aria-label="View your profile">👤</a>
    <button class="nav-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle light / dark mode" aria-label="Toggle light or dark mode">🌙</button>
  </div>
</nav>

<div class="md-page">
  <div class="md-source">${escapeHtml(sourcePath)}</div>
  ${byline}
  <article data-narrate>
  ${body.join("\n")}
  </article>
</div>

<footer class="site-footer">
  <div class="footer-inner">
    <span class="footer-brand">
      <span class="mandala-icon spin-slow" aria-hidden="true"></span> Keystone OS
    </span>
    <span class="sep">·</span>
    <a href="/">Home</a>
    <a href="/dream-chat.html">Chat</a>
    <a href="/trader-dashboard.html">Trader</a>
    <a href="/create.html">Create</a>
    <a href="/explore.html">Explore</a>
    <a href="/knowledgecenter.html">Help</a>
  </div>
</footer>

<script src="/js/theme-toggle.js"></script>
<script src="/js/narrator.js" defer></script>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  inlineMarkdown,
  renderMarkdownDocument,
  slugify,
};
