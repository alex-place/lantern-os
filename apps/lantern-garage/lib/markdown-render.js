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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Lantern OS</title>
  <style>
    :root { color-scheme: light; --ink:#11191f; --muted:#596874; --paper:#eef4ef; --line:#bdc9c9; --arc:#08756f; --blue:#1e5f89; }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family:"Segoe UI", Arial, sans-serif; }
    main { width:min(980px, calc(100% - 28px)); margin:0 auto; padding:24px 0 48px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:22px; }
    .source { color:var(--muted); font-size:0.86rem; overflow-wrap:anywhere; }
    a { color:var(--blue); font-weight:800; }
    .back { border:1px solid var(--line); padding:10px 12px; background:white; text-decoration:none; white-space:nowrap; }
    h1 { font-size:2.1rem; line-height:1.05; margin:0 0 10px; letter-spacing:0; }
    h2 { margin-top:28px; border-top:1px solid var(--line); padding-top:18px; }
    p, li { line-height:1.58; }
    code { background:white; border:1px solid var(--line); padding:1px 5px; }
    pre { background:#11191f; color:white; overflow:auto; padding:14px; }
    table { width:100%; border-collapse:collapse; background:white; margin:18px 0; }
    th, td { border:1px solid var(--line); padding:9px; vertical-align:top; }
    th { text-align:left; background:#f7faf8; color:var(--muted); text-transform:uppercase; font-size:0.78rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <div><strong>Lantern Reader</strong><div class="source">${escapeHtml(sourcePath)}</div></div>
      <a class="back" href="/">Dashboard</a>
    </header>
    ${body.join("\n")}
  </main>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  inlineMarkdown,
  renderMarkdownDocument,
};
