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
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => (
      `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    ));
}

function renderMarkdownDocument(markdown, sourcePath) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const body = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  let tableRows = [];
  let title = path.basename(sourcePath);

  const closeList = () => {
    if (inList) {
      body.push("</ul>");
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

  lines.forEach((line) => {
    if (/^```/.test(line.trim())) {
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
    if (/^\s*\|.+\|\s*$/.test(line)) {
      closeList();
      inTable = true;
      tableRows.push(line);
      return;
    }
    closeTable();
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      if (level === 1) title = heading[2].trim();
      body.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      return;
    }
    const listItem = /^\s*[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      body.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
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
  if (inCode) body.push("</code></pre>");

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Lantern OS</title>
  <link rel="stylesheet" href="/css/site.css">
  <link rel="stylesheet" href="/css/narrator.css">
  <style>
    .md-page { max-width: 880px; margin: 0 auto; padding: 32px 20px 80px; }
    .md-page h1 { font-size: 2rem; font-weight: 800; margin: 0 0 12px; line-height: 1.15; }
    .md-page h2 { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 18px; }
    .md-page p, .md-page li { line-height: 1.6; }
    .md-page code { background: var(--surface2); border: 1px solid var(--border); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
    .md-page pre { background: var(--surface2); overflow: auto; padding: 14px; border-radius: 8px; border: 1px solid var(--border); }
    .md-page pre code { background: none; border: none; padding: 0; }
    .md-page table { width: 100%; border-collapse: collapse; background: var(--surface); margin: 18px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .md-page th, .md-page td { border: 1px solid var(--border); padding: 9px; vertical-align: top; }
    .md-page th { text-align: left; background: var(--surface2); color: var(--muted); text-transform: uppercase; font-size: 0.78rem; }
    .md-page a { color: var(--accent); font-weight: 600; }
    .md-source { color: var(--muted); font-size: 0.86rem; margin-bottom: 24px; }
  </style>
</head>
<body>
<nav class="site-nav">
  <a class="nav-brand" href="/">
    <img src="/mandala.svg" alt="" aria-hidden="true" style="width:18px;height:18px;vertical-align:middle">
    Lantern OS
  </a>
  <div class="nav-links">
    <a href="/">Home</a>
    <a href="/dream-chat.html">Journal</a>
    <a href="/three-doors-game.html">Explore</a>
    <a href="/flourishing">Dashboard</a>
    <a href="/knowledgecenter.html">Help</a>
  </div>
  <div class="nav-actions">
    <button class="nav-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle theme">☀</button>
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
    <span><strong>Lantern OS</strong> · <a href="/">Home</a> · <a href="/dream-chat.html">Journal</a> · <a href="/three-doors-game.html">Explore</a></span>
    <span style="margin-left: auto;"><a href="/knowledgecenter.html">Help</a></span>
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
