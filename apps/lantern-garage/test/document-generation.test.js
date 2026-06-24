// Document generation tests — #1097
// Verifies document-templates.js render functions and the generate_document /
// list_document_templates tools in tool-runner.js.
//
// Run: node apps/lantern-garage/test/document-generation.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), "keystone-doc-test-"));
process.env.KEYSTONE_WORKSPACE = TMP_WS;

delete require.cache[require.resolve("../lib/tool-runner")];
delete require.cache[require.resolve("../lib/document-templates")];
const { runTool } = require("../lib/tool-runner");
const { render, listTemplates } = require("../lib/document-templates");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
function r(envelope) { return envelope.result || envelope.reason || JSON.stringify(envelope); }

async function main() {
  // ── document-templates unit tests ─────────────────────────────────────────

  check("resume HTML render contains name", async () => {
    const { content } = render("resume", { name: "Jane Smith" }, "html");
    assert.ok(content.includes("Jane Smith"), `name not found in: ${content.slice(0, 200)}`);
    assert.ok(content.includes("<!DOCTYPE html>"), "not HTML");
  });

  check("resume HTML render includes experience bullets", async () => {
    const { content } = render("resume", {
      name: "Jane Smith",
      experience: [{ title: "Engineer", company: "Acme", dates: "2020–2026", bullets: ["Did stuff"] }],
    }, "html");
    assert.ok(content.includes("Did stuff"));
    assert.ok(content.includes("Acme"));
  });

  check("resume markdown render starts with heading", async () => {
    const { content, extension } = render("resume", { name: "John Doe" }, "markdown");
    assert.ok(content.startsWith("# John Doe"));
    assert.strictEqual(extension, ".md");
  });

  check("resume markdown render includes skills from string", async () => {
    const { content } = render("resume", { name: "A", skills: "Python, Node.js" }, "markdown");
    assert.ok(content.includes("Python"));
    assert.ok(content.includes("Node.js"));
  });

  check("cover-letter HTML render contains company name", async () => {
    const { content } = render("cover-letter", { name: "Jane", company: "Acme Corp", role: "SWE" }, "html");
    assert.ok(content.includes("Acme Corp"));
    assert.ok(content.includes("SWE"));
  });

  check("cover-letter markdown render includes salutation", async () => {
    const { content } = render("cover-letter", {
      name: "Jane", company: "X", role: "Eng",
      hiring_manager: "Alex Place",
    }, "markdown");
    assert.ok(content.includes("Dear Alex Place"));
  });

  check("render throws on unknown template", async () => {
    assert.throws(() => render("bio", {}, "html"), /Unknown template/);
  });

  check("listTemplates returns resume and cover-letter", async () => {
    const tpls = listTemplates();
    const names = tpls.map(t => t.name);
    assert.ok(names.includes("resume"));
    assert.ok(names.includes("cover-letter"));
  });

  check("listTemplates includes field definitions", async () => {
    const tpls = listTemplates();
    const resume = tpls.find(t => t.name === "resume");
    assert.ok(Array.isArray(resume.fields));
    assert.ok(resume.fields.some(f => f.name === "name" && f.required));
  });

  // ── generate_document tool ─────────────────────────────────────────────────

  await check("generate_document creates HTML resume in workspace", async () => {
    const env = await runTool("generate_document", {
      template: "resume",
      fields: { name: "Test User", email: "test@example.com" },
    }, { operator: true });
    assert.ok(env.ok, `expected ok, got: ${JSON.stringify(env)}`);
    const result = r(env);
    assert.ok(result.includes("workspace/resume"), `unexpected: ${result}`);
    const htmlPath = path.join(TMP_WS, "resume.html");
    assert.ok(fs.existsSync(htmlPath), `HTML file not created at ${htmlPath}`);
    const content = fs.readFileSync(htmlPath, "utf8");
    assert.ok(content.includes("Test User"));
  });

  await check("generate_document creates markdown cover-letter", async () => {
    const env = await runTool("generate_document", {
      template: "cover-letter",
      fields: { name: "Test User", company: "Acme", role: "Engineer" },
      format: "markdown",
    }, { operator: true });
    assert.ok(env.ok);
    const mdPath = path.join(TMP_WS, "cover-letter.md");
    assert.ok(fs.existsSync(mdPath));
    const content = fs.readFileSync(mdPath, "utf8");
    assert.ok(content.includes("Acme"));
  });

  await check("generate_document respects custom filename", async () => {
    await runTool("generate_document", {
      template: "resume",
      fields: { name: "Custom" },
      filename: "my-resume",
      format: "html",
    }, { operator: true });
    assert.ok(fs.existsSync(path.join(TMP_WS, "my-resume.html")));
  });

  await check("generate_document returns print-to-PDF hint for HTML", async () => {
    const env = await runTool("generate_document", {
      template: "resume",
      fields: { name: "X" },
      filename: "hint-test",
    }, { operator: true });
    assert.ok(r(env).includes("PDF"), `expected PDF hint, got: ${r(env)}`);
  });

  // ── list_document_templates tool ──────────────────────────────────────────

  await check("list_document_templates returns template names", async () => {
    const env = await runTool("list_document_templates", {}, { operator: false });
    const result = r(env);
    assert.ok(result.includes("resume"));
    assert.ok(result.includes("cover-letter"));
  });

  await check("list_document_templates lists field names", async () => {
    const env = await runTool("list_document_templates", {}, { operator: false });
    const result = r(env);
    assert.ok(result.includes("name"));
    assert.ok(result.includes("company"));
  });

  // ── cleanup ───────────────────────────────────────────────────────────────
  fs.rmSync(TMP_WS, { recursive: true, force: true });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  else           { console.log("\nAll tests passed"); }
}

main().catch(e => { console.error("Unexpected error:", e); process.exit(1); });
