const path = require("path");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // italics: single * or _ not adjacent to a word char on the open/close boundary
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => (
      `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    ));
}

// Render an array of markdown lines to an array of HTML fragments.
// Recursive so blockquotes can contain headings, lists, tables, etc.
function renderBlock(lines) {
  const body = [];
  let inCode = false;
  let inList = false;
  let listTag = "ul";
  let inTable = false;
  let tableRows = [];
  let quoteBuf = null;

  const closeList = () => {
    if (inList) {
      body.push(`</${listTag}>`);
      inList = false;
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

  lines.forEach((line) => {
    if (/^```/.test(line.trim())) {
      flushQuote();
      closeList();
      closeTable();
      body.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      return;
    }
    if (inCode) {
      body.push(`${escapeHtml(line)}\n`);
      return;
    }
    // Blockquote: gather consecutive `>` lines, strip the marker, render recursively.
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      closeTable();
      if (!quoteBuf) quoteBuf = [];
      quoteBuf.push(quote[1]);
      return;
    }
    flushQuote();
    if (/^\s*\|.+\|\s*$/.test(line)) {
      closeList();
      inTable = true;
      tableRows.push(line);
      return;
    }
    closeTable();
    // Horizontal rule: ---, ***, ___ (3+).
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      body.push("<hr>");
      return;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      body.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      return;
    }
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ordered || unordered) {
      const tag = ordered ? "ol" : "ul";
      if (inList && listTag !== tag) closeList();
      if (!inList) {
        body.push(`<${tag}>`);
        inList = true;
        listTag = tag;
      }
      body.push(`<li>${inlineMarkdown((ordered || unordered)[1])}</li>`);
      return;
    }
    if (!line.trim()) {
      closeList();
      return;
    }
    closeList();
    body.push(`<p>${inlineMarkdown(line)}</p>`);
  });
  closeList();
  closeTable();
  flushQuote();
  if (inCode) body.push("</code></pre>");
  return body;
}

function renderMarkdownDocument(markdown, sourcePath) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const titleMatch = /^#\s+(.+)$/m.exec(normalized);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(sourcePath);
  const body = renderBlock(normalized.split("\n"));

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    }
    .md-page p, .md-page li { margin: 0 0 1.05em; }
    .md-page li { margin-bottom: 0.5em; }
    .md-page li::marker { color: var(--accent); }
    .md-page h1, .md-page h2, .md-page h3, .md-page h4, .md-page h5, .md-page h6 {
      color: var(--text); line-height: 1.25; font-weight: 700;
    }
    .md-page h1 { font-size: 2rem; font-weight: 800; margin: 0 0 .5em; letter-spacing: -0.02em; }
    .md-page h2 { font-size: 1.5rem; margin: 1.85em 0 .55em; padding-top: .7em; border-top: 1px solid var(--border); }
    .md-page h3 { font-size: 1.2rem; font-weight: 600; margin: 1.55em 0 .4em; }
    .md-page h4 { font-size: 0.9rem; font-weight: 700; margin: 1.4em 0 .3em; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .md-page a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    .md-page a:hover { color: var(--accent-hover); }
    .md-page strong { color: var(--text); font-weight: 700; }
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
    @media (max-width: 820px) { .md-page { padding: 28px 20px 48px; margin: 0; border-radius: 0; border-left: none; border-right: none; font-size: 1.02rem; } }
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
    <button class="nav-btn" id="theme-toggle" title="Toggle light / dark mode" aria-label="Toggle light or dark mode">☀</button>
  </div>
</nav>

<div class="md-page">
  <div class="md-source">${escapeHtml(sourcePath)}</div>
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
};
