// export_document chat tool (#1923) — chat can now produce a downloadable .docx/.pdf/.xlsx/.pptx.
//
// Before this, the only doc tool offered to chat (generate_document) rendered the template
// library to HTML/Markdown in the workspace and could NOT make a Word file, so the model
// flatly refused "export it as a word doc" despite the capability existing (document-builder.js,
// #1237). This tool exposes that real binary generator to the tool loop and returns a clickable
// download link.
//
// Run: node apps/lantern-garage/test/export-document-tool.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { runTool, TOOL_NAMES, anthropicTools } = require("../lib/tool-runner");
const { DOCS_DIR } = require("../lib/document-builder");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

function linkedFile(result) {
  const m = (result || "").match(/file=([^)]+)\)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function main() {
  // Registered and advertised to operators, hidden from guests (writes files → operator-only).
  await check("registered in the tool registry", () => {
    assert.ok(TOOL_NAMES.includes("export_document"));
  });
  await check("advertised to operators, hidden from guests", () => {
    const op = anthropicTools({ operator: true }).map((t) => t.name);
    const guest = anthropicTools({ operator: false }).map((t) => t.name);
    assert.ok(op.includes("export_document"), "operator must see it");
    assert.ok(!guest.includes("export_document"), "guest must NOT see it (mutating/file-writing)");
  });

  // Empty content fails closed WITHOUT writing a file — no half-baked export.
  await check("empty content → graceful error, no file written", async () => {
    const before = fs.existsSync(DOCS_DIR) ? fs.readdirSync(DOCS_DIR).length : 0;
    const r = await runTool("export_document", { content: "   ", format: "docx" },
      { operator: true, executionEnabled: true });
    assert.match(r.result || r.error || "", /content is required/i);
    const after = fs.existsSync(DOCS_DIR) ? fs.readdirSync(DOCS_DIR).length : 0;
    assert.strictEqual(after, before, "no file should be written on the guard path");
  });

  // The real payoff: a Word (.docx) export produces a valid Office Open XML file (zip → 'PK')
  // and a clickable download link pointing at the served download route.
  await check("docx export → valid binary + download link", async () => {
    const md = "# Alex Place — Resume\n\n## Skills\n- AI systems\n- Node.js\n\n## Experience\nBuilt the unisona.ai convergence loop.";
    const r = await runTool("export_document", { content: md, format: "docx", title: "Alex Resume" },
      { operator: true, executionEnabled: true });
    const out = r.result || "";
    assert.match(out, /\/api\/document\/download\?file=/, "must return the download route link");
    assert.match(out, /DOCX/, "must confirm the format");
    const file = linkedFile(out);
    assert.ok(file && file.endsWith(".docx"), `expected a .docx filename, got ${file}`);
    const fp = path.join(DOCS_DIR, file);
    assert.ok(fs.existsSync(fp), "the file must actually exist on disk");
    const buf = fs.readFileSync(fp);
    assert.ok(buf.length > 0, "file must be non-empty");
    assert.strictEqual(buf.slice(0, 2).toString("latin1"), "PK", "docx is a zip → must start with PK");
    fs.unlinkSync(fp); // clean up the generated artifact
  });

  // An unsupported format is rejected honestly (no file), not silently mislabeled.
  await check("unsupported format → honest failure", async () => {
    const r = await runTool("export_document", { content: "# Hi", format: "rtf" },
      { operator: true, executionEnabled: true });
    // The schema enum blocks 'rtf' upstream on native paths; runTool still guards at execution.
    assert.ok(/failed|error|not supported|rtf/i.test(r.result || r.error || ""),
      "must not claim success for an unsupported format");
  });

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall export_document checks passed");
}

main();
