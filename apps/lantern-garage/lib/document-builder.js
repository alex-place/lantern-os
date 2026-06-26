// Document generation (Node) — turn a chat request into a downloadable document.
// Generates content with a model (Claude — its key works here), renders Markdown → clean,
// print-styled HTML → PDF via Playwright (already a dependency). Key stays server-side. Saves
// to data/generated-docs/ and returns an /api/document/download URL. Fail-safe by contract.
//
// Formats: pdf | md | html. docx/pptx/xlsx need a generator lib (not installed) → ok:false.
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const DOCS_DIR = path.join(repoRoot, "data", "generated-docs");
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Compact, safe Markdown → HTML (covers what the model emits: headings, lists, tables,
// bold/italic/code/links, blockquotes, code fences, hr, paragraphs). HTML is escaped.
function mdToHtml(md) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => `<a href="${esc(u)}">${t}</a>`);
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { // code fence
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\|(.+)\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const head = line.split("|").slice(1, -1).map((c) => `<th>${inline(c.trim())}</th>`).join("");
      i += 2; const rows = [];
      while (i < lines.length && /^\|(.+)\|\s*$/.test(lines[i])) {
        rows.push("<tr>" + lines[i].split("|").slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>"); i++;
      }
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\s*[-*+]\s+/, ""))}</li>`);
      out.push(`<ul>${buf.join("")}</ul>`); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) buf.push(`<li>${inline(lines[i++].replace(/^\s*\d+\.\s+/, ""))}</li>`);
      out.push(`<ol>${buf.join("")}</ol>`); continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+\.\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function htmlDoc(title, bodyHtml) {
  const t = String(title || "Document").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>
  @page { margin: 2.2cm 2cm; }
  body { font: 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:#1a1a1a; }
  h1 { font-size:26px; border-bottom:2px solid #06b6d4; padding-bottom:6px; margin-top:0; }
  h2 { font-size:20px; margin-top:1.4em; } h3 { font-size:16px; }
  table { border-collapse:collapse; width:100%; margin:1em 0; } th,td { border:1px solid #ccc; padding:6px 10px; text-align:left; vertical-align:top; }
  th { background:#f3f4f6; } code { background:#f3f4f6; padding:1px 5px; border-radius:4px; } pre { background:#f7f7f8; padding:12px; border-radius:8px; overflow:auto; }
  pre code { background:none; padding:0; } blockquote { border-left:3px solid #06b6d4; margin:1em 0; padding:.2em 1em; color:#444; }
  a { color:#0369a1; } ul,ol { padding-left:1.4em; }
</style></head><body>${bodyHtml}</body></html>`;
}

// System prompt shaped to the target format: prose for docx/pdf/html/md, a single
// table for xlsx (spreadsheets), a slide outline for pptx (decks).
function systemForFormat(fmt) {
  if (fmt === "xlsx") {
    return "You are a data analyst. For the user's request, output ONLY a single GitHub-Flavored Markdown TABLE: a header row, a separator row, then one row per record. Optionally a single top-level '# Title' line above it. No prose, no explanation, no extra tables.";
  }
  if (fmt === "pptx") {
    return "You are a presentation writer. Output ONLY a GitHub-Flavored Markdown outline for a slide deck: a top-level '# Deck Title', then one '## Slide Title' per slide, each followed by 3-6 concise '- bullet' points. Keep bullets short. No preamble.";
  }
  return "You are a professional document writer. Produce a complete, well-structured document in GitHub-Flavored Markdown: a top-level # title, clear ## headings, bullet/numbered lists, and Markdown tables where useful. Output ONLY the Markdown document — no preamble, no 'here is your document'.";
}

async function claudeMarkdown(prompt, title, signal, fmt = "pdf") {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const system = systemForFormat(fmt);
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: `Write a document${title ? ` titled "${title}"` : ""}: ${prompt}` }],
    }),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) throw new Error("empty document response");
  return text;
}

// ── Markdown → structured blocks (shared by the docx/xlsx/pptx renderers) ──
// Returns [{type:'h',level,text} | {type:'p',text} | {type:'list',ordered,items[]} |
//          {type:'table',head[],rows[][]} | {type:'code',text} | {type:'quote',text} | {type:'hr'}].
function mdBlocks(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push({ type: "code", text: buf.join("\n") }); continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { out.push({ type: "h", level: h[1].length, text: h[2].trim() }); i++; continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { out.push({ type: "hr" }); i++; continue; }
    if (/^\|(.+)\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const head = line.split("|").slice(1, -1).map((c) => c.trim());
      i += 2; const rows = [];
      while (i < lines.length && /^\|(.+)\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim())); i++;
      }
      out.push({ type: "table", head, rows }); continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push({ type: "quote", text: buf.join(" ") }); continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, "").trim());
      out.push({ type: "list", ordered: false, items }); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, "").trim());
      out.push({ type: "list", ordered: true, items }); continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+\.\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push({ type: "p", text: buf.join(" ") });
  }
  return out;
}

// Strip Markdown inline syntax to plain text (for pptx/xlsx cells where rich runs aren't worth it).
function stripInline(s) {
  return String(s)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .trim();
}

// ── Markdown → .docx (the `docx` package) ──
async function renderDocx(markdown, title) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = require("docx");
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

  // Inline **bold** / *italic* / `code` → TextRuns.
  function runs(text) {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0, m;
    const push = (t, o) => { if (t) parts.push(new TextRun({ text: t, ...o })); };
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index), {});
      const tok = m[0];
      if (tok.startsWith("**")) push(tok.slice(2, -2), { bold: true });
      else if (tok.startsWith("`")) push(tok.slice(1, -1), { font: "Consolas" });
      else if (tok.startsWith("*")) push(tok.slice(1, -1), { italics: true });
      else { const lm = tok.match(/\[([^\]]+)\]\(([^)\s]+)\)/); push(lm[1], {}); }
      last = re.lastIndex;
    }
    push(text.slice(last), {});
    return parts.length ? parts : [new TextRun("")];
  }

  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const b of mdBlocks(markdown)) {
    if (b.type === "h") {
      // skip a leading h1 equal to the title to avoid duplication
      if (b.level === 1 && stripInline(b.text).toLowerCase() === String(title).toLowerCase()) continue;
      children.push(new Paragraph({ heading: HEADINGS[b.level - 1], children: runs(b.text) }));
    } else if (b.type === "p") {
      children.push(new Paragraph({ children: runs(b.text) }));
    } else if (b.type === "quote") {
      children.push(new Paragraph({ children: runs(b.text), indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "06b6d4", space: 12 } } }));
    } else if (b.type === "code") {
      for (const ln of b.text.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: ln || " ", font: "Consolas", size: 18 })], shading: { fill: "F3F4F6" } }));
    } else if (b.type === "list") {
      b.items.forEach((it, idx) => children.push(new Paragraph(
        b.ordered ? { children: runs(`${idx + 1}. ${it}`), indent: { left: 360 } }
                  : { children: runs(it), bullet: { level: 0 } },
      )));
    } else if (b.type === "table") {
      const cell = (txt, bold) => new TableCell({ children: [new Paragraph({ children: runs(bold ? `**${txt}**` : txt) })] });
      const rows = [new TableRow({ tableHeader: true, children: b.head.map((c) => cell(c, true)) })];
      for (const r of b.rows) rows.push(new TableRow({ children: b.head.map((_, ci) => cell(r[ci] || "", false)) }));
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph(""));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Markdown → .xlsx (the `exceljs` package). First table → sheet; else lines in col A. ──
async function renderXlsx(markdown, title) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Keystone OS";
  const ws = wb.addWorksheet((String(title || "Sheet1")).slice(0, 28).replace(/[*?:/\\[\]]/g, " ") || "Sheet1");
  const blocks = mdBlocks(markdown);
  const table = blocks.find((b) => b.type === "table");
  if (table) {
    ws.addRow(table.head.map(stripInline));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
    for (const r of table.rows) ws.addRow(table.head.map((_, ci) => stripInline(r[ci] || "")));
    table.head.forEach((h, ci) => {
      const maxLen = Math.max(stripInline(h).length, ...table.rows.map((r) => stripInline(r[ci] || "").length));
      ws.getColumn(ci + 1).width = Math.min(60, Math.max(10, maxLen + 2));
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.head.length } };
  } else {
    // No table emitted — write a readable single-column outline so the file is never empty.
    ws.getColumn(1).width = 80;
    ws.addRow([String(title || "Document")]).font = { bold: true, size: 14 };
    for (const b of blocks) {
      if (b.type === "h") ws.addRow([stripInline(b.text)]).font = { bold: true };
      else if (b.type === "p" || b.type === "quote") ws.addRow([stripInline(b.text)]);
      else if (b.type === "list") b.items.forEach((it) => ws.addRow(["• " + stripInline(it)]));
      else if (b.type === "code") ws.addRow([b.text]);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── Markdown → .pptx (the `pptxgenjs` package). Title slide, then one slide per heading. ──
async function renderPptx(markdown, title) {
  const PptxGenJS = require("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "KEY", width: 10, height: 5.63 });
  pptx.layout = "KEY";

  const title0 = pptx.addSlide();
  title0.background = { color: "0B1220" };
  title0.addText(String(title || "Presentation"), { x: 0.5, y: 2.1, w: 9, h: 1.2, fontSize: 36, bold: true, color: "FFFFFF", align: "center" });

  const blocks = mdBlocks(markdown);
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const s = pptx.addSlide();
    s.addText(cur.title, { x: 0.5, y: 0.3, w: 9, h: 0.9, fontSize: 26, bold: true, color: "06B6D4" });
    if (cur.bullets.length) {
      s.addText(cur.bullets.map((t) => ({ text: t, options: { bullet: true, fontSize: 16, color: "1A1A1A", breakLine: true } })), { x: 0.7, y: 1.3, w: 8.6, h: 3.8, valign: "top" });
    }
    cur = null;
  };
  for (const b of blocks) {
    if (b.type === "h") {
      if (b.level === 1 && stripInline(b.text).toLowerCase() === String(title).toLowerCase()) continue;
      flush(); cur = { title: stripInline(b.text), bullets: [] };
    } else if (b.type === "list") {
      if (!cur) cur = { title: "Overview", bullets: [] };
      cur.bullets.push(...b.items.map(stripInline));
    } else if (b.type === "p" || b.type === "quote") {
      if (!cur) cur = { title: "Overview", bullets: [] };
      cur.bullets.push(stripInline(b.text));
    }
  }
  flush();
  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
}

async function renderPdf(markdown, title) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(htmlDoc(title, mdToHtml(markdown)), { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}

// generateDocument({prompt|markdown, title, format}) → { ok, url, filename, format } | { ok:false, error }.
async function generateDocument({ prompt = "", title = "", format = "pdf", markdown = "" } = {}) {
  const fmt = String(format || "pdf").toLowerCase();
  if (!["pdf", "md", "html", "docx", "xlsx", "pptx"].includes(fmt)) {
    return { ok: false, error: `format '${fmt}' not supported — pdf, md, html, docx, xlsx, pptx` };
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 90000);
  try {
    let content = markdown;
    if (!content) {
      if (!String(prompt).trim()) return { ok: false, error: "prompt or markdown required" };
      content = await claudeMarkdown(prompt, title, ctrl.signal, fmt);
    }
    const h1 = (content.match(/^#\s+(.+)$/m) || [])[1];
    const docTitle = title || h1 || "document";
    const slug = docTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
    if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
    const id = `${slug}-${Date.now().toString(36)}`;
    let filename, buffer;
    if (fmt === "pdf") { filename = `${id}.pdf`; buffer = await renderPdf(content, docTitle); }
    else if (fmt === "html") { filename = `${id}.html`; buffer = Buffer.from(htmlDoc(docTitle, mdToHtml(content)), "utf8"); }
    else if (fmt === "docx") { filename = `${id}.docx`; buffer = await renderDocx(content, docTitle); }
    else if (fmt === "xlsx") { filename = `${id}.xlsx`; buffer = await renderXlsx(content, docTitle); }
    else if (fmt === "pptx") { filename = `${id}.pptx`; buffer = await renderPptx(content, docTitle); }
    else { filename = `${id}.md`; buffer = Buffer.from(content, "utf8"); }
    fs.writeFileSync(path.join(DOCS_DIR, filename), buffer);
    return { ok: true, url: `/api/document/download?file=${encodeURIComponent(filename)}`, filename, format: fmt, title: docTitle, bytes: buffer.length };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "document generation timed out" : (e.message || String(e)) };
  } finally {
    clearTimeout(to);
  }
}

module.exports = { generateDocument, mdToHtml, DOCS_DIR };
