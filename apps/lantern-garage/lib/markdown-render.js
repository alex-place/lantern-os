const path = require("path");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// URL-scheme allowlist for link href / image src. The renderer escapes HTML, but
// escaping does NOT neutralize a dangerous scheme — `[x](javascript:alert(1))`
// would still produce a clickable script sink. Markdown rendered here can come
// from repo files written by automation / research-intake / harvest pipelines,
// so an attacker-authored .md viewed by an admin is a stored-XSS path. Block
// everything except http(s), mailto, tel, and (for images) safe raster data URIs.
// Relative / anchor URLs (no scheme before the first / ? #) pass through.
function safeUrl(url, { allowData = false } = {}) {
  const raw = String(url ?? "");
  // Strip control/whitespace chars that smuggle a scheme past the regex,
  // e.g. "java\tscript:" or a leading newline before "javascript:".
  const probe = raw.replace(/[\u0000-\u0020\u007F-\u00A0]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!scheme) return raw; // relative, anchor, or protocol-relative — safe
  const proto = scheme[1].toLowerCase();
  if (proto === "http" || proto === "https" || proto === "mailto" || proto === "tel") {
    return raw;
  }
  // Raster data images only — never svg+xml (it can carry inline script).
  if (allowData && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(probe)) {
    return raw;
  }
  return "#"; // javascript:, vbscript:, data:text/html, file:, etc.
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
        `<img src="${escapeHtml(safeUrl(src, { allowData: true }))}" alt="${escapeHtml(alt)}"` +
          (title ? ` title="${escapeHtml(title)}"` : "") +
          ` loading="lazy">`
      )
  );

  // Links — the label may already contain a stashed image placeholder.
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, label, href, title) => {
      const safeHref = safeUrl(href);
      const rel = /^https?:/i.test(safeHref) ? ' rel="noopener"' : "";
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return hold(
        `<a href="${escapeHtml(safeHref)}"${t}${rel}>${emphasize(escapeHtml(label))}</a>`
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

// Group the flat block list into newspaper "panels": everything before the first
// H2 becomes the masthead (<header class="md-lead">), then each H2 and the blocks
// that follow it (until the next H2) become one <section class="md-panel">. The
// panels are what receive the alternating background + border treatment in CSS.
function groupSections(blocks) {
  const lead = [];
  const panels = [];
  let cur = null;
  for (const b of blocks) {
    if (/^<h2[\s>]/.test(b)) {
      if (cur) panels.push(cur);
      cur = [b];
    } else if (cur) {
      cur.push(b);
    } else {
      lead.push(b);
    }
  }
  if (cur) panels.push(cur);
  // Pick a column tier from each section's *flowing* text depth (paragraphs and
  // lists — not the full-width spanners h2/pre/table/blockquote/hr, which don't
  // balance into columns). Shallow sections stay 1 column, normal sections use up
  // to 2, and only a genuinely deep section earns a 3rd — so a short section never
  // fragments into thin, vertically-meaningless stubs.
  const colClass = (blocks) => {
    const flow = blocks
      .filter((b) => !/^<(h2|pre|table|blockquote|hr)[\s>]/.test(b))
      .join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
    const n = flow >= 1700 ? 3 : flow <= 360 ? 1 : 2;
    return `md-panel md-cols-${n}`;
  };
  // No H2 anywhere → wrap the whole doc in one panel so it still gets chrome.
  if (!panels.length) return `<section class="${colClass(lead)}">\n${lead.join("\n")}\n</section>`;
  const parts = [];
  if (lead.length) parts.push(`<header class="md-lead">\n${lead.join("\n")}\n</header>`);
  for (const p of panels) parts.push(`<section class="${colClass(p)}">\n${p.join("\n")}\n</section>`);
  return parts.join("\n");
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
       so it follows the global light/dark toggle. No fixed palette, no web fonts.
       The page is a transparent container; each H2 section is rendered as a boxed
       "newspaper panel" (.md-panel) with alternating contrast and its own chrome,
       so the page reads as stacked panels rather than one long card. */
    .md-page {
      max-width: 1080px; margin: 16px auto 56px; padding: 0 14px;
      color: var(--text);
      font-size: 1.05rem; line-height: 1.75;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      overflow-wrap: anywhere;
    }
    /* Masthead — the H1 + intro that precede the first H2. */
    .md-lead { padding: 6px 6px 20px; margin-bottom: 24px; border-bottom: 3px solid var(--accent); }
    /* Newspaper panels — one per H2 section. A hairline border + alternating
       background give the high-contrast, sharp-edged stacked-panel look; the
       generous bottom margin is the spacing between horizontal panels. */
    .md-panel {
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      padding: 20px 28px 6px; margin: 0 0 30px;
    }
    .md-panel:nth-of-type(even) { background: var(--surface2); border-left: 3px solid var(--accent); }
    .md-panel:last-of-type { margin-bottom: 0; }
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
    .md-page h2 { font-size: 1.4rem; margin: .1em 0 .7em; padding-bottom: .35em; border-bottom: 2px solid var(--accent); }
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
    .md-page blockquote h2 { margin-top: .6em; border-top: none; border-bottom: none; padding-top: 0; padding-bottom: 0; font-size: 1.2rem; }
    .md-page blockquote h3 { margin-top: .5em; }
    .md-page blockquote > :first-child { margin-top: .4em; }
    .md-page hr { border: none; border-top: 1px solid var(--border); margin: 2.4em 0; }
    .md-source { color: var(--muted); font-size: 0.8rem; margin-bottom: 26px; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; letter-spacing: .01em; }
    .md-byline { color: var(--muted); font-size: 0.82rem; margin: -18px 0 24px; }
    @media (max-width: 820px) {
      .md-page { padding: 0 8px; margin: 8px auto 40px; font-size: 1.02rem; }
      .md-panel { padding: 16px 16px 4px; margin-bottom: 18px; border-radius: 6px; }
      .md-lead { padding: 4px 2px 14px; margin-bottom: 16px; }
    }

    /* ── Large-screen "newspaper panels" ──────────────────────────────────
       Column COUNT follows each section's content depth (.md-cols-N, assigned at
       render time in groupSections) rather than the viewport width: 2 columns is
       the default and only a genuinely deep section earns a 3rd, so shallow
       sections never fragment into thin stubs. The 22rem column-width floor also
       lets the browser drop to fewer columns when a panel is too narrow. Page
       width is capped at 1280px so the 2-column measure stays readable instead of
       stretching across ultrawide displays. Headings + wide blocks span all
       columns like newspaper figures. */
    @media (min-width: 1100px) {
      .md-page { max-width: 1280px; }
      .md-panel { padding: 26px 34px 10px; column-gap: 48px; }
      .md-panel.md-cols-2 { columns: 22rem 2; }
      .md-panel.md-cols-3 { columns: 22rem 3; }
      /* .md-cols-1 stays a single column — a short section has nothing to balance */
      .md-panel > h2,
      .md-panel > pre,
      .md-panel > table,
      .md-panel > blockquote,
      .md-panel > hr { column-span: all; }
      .md-panel > ul,
      .md-panel > ol,
      .md-panel li,
      .md-panel > figure,
      .md-panel > img { break-inside: avoid; }
      .md-panel > h3,
      .md-panel > h4 { break-after: avoid; }
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
  ${groupSections(body)}
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
  safeUrl,
  inlineMarkdown,
  renderMarkdownDocument,
  slugify,
};
