/**
 * CI/CD Gate Regression Tests
 * Validates the expectations set in .github/workflows/ before they hit CI.
 *
 * Run: node tests/regression/cicd-gates.js
 * Fails fast with clear messages so operators catch violations locally.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? " — " + detail : ""}`);
  }
}

function readFile(relPath) {
  const p = path.join(ROOT, relPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

function listFiles(dir, ext) {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter((f) => f.endsWith(ext));
}

function listDirs(dir) {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// ── Gate 1: Required top-level files ───────────────────────────────────────
console.log("\n=== Gate 1 — Required top-level files ===");
assert("README.md exists", fs.existsSync(path.join(ROOT, "README.md")));
assert("AGENTS.md exists", fs.existsSync(path.join(ROOT, "AGENTS.md")));
assert("docs/CONVERGENCE-LOOP.md exists", fs.existsSync(path.join(ROOT, "docs", "CONVERGENCE-LOOP.md")));
assert("docs/REPO-CONTRACT.md exists", fs.existsSync(path.join(ROOT, "docs", "REPO-CONTRACT.md")));

// ── Gate 2: Required manifests ───────────────────────────────────────────
console.log("\n=== Gate 2 — Required manifests ===");
assert("manifests/FOUNDRY-MATRIX-RAG-DOLLHOUSE.md exists",
  fs.existsSync(path.join(ROOT, "manifests", "FOUNDRY-MATRIX-RAG-DOLLHOUSE.md")));
assert("manifests/open-issues.md exists",
  fs.existsSync(path.join(ROOT, "manifests", "open-issues.md")));

// ── Gate 3: Required surfaces ────────────────────────────────────────────
console.log("\n=== Gate 3 — Required surfaces ===");
assert("surfaces/shareholder-index/index.html exists",
  fs.existsSync(path.join(ROOT, "surfaces", "shareholder-index", "index.html")));
assert("surfaces/shareholder-index/styles.css exists",
  fs.existsSync(path.join(ROOT, "surfaces", "shareholder-index", "styles.css")));

// ── Gate 4: HTML links valid (no broken relative links) ──────────────────
console.log("\n=== Gate 4 — HTML link integrity ===");
const indexHtml = readFile("surfaces/shareholder-index/index.html");
if (indexHtml) {
  const hrefs = [...indexHtml.matchAll(/href=["']([^"']+)["']/g)].map((m) => m[1]);
  const broken = [];
  for (const href of hrefs) {
    if (href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:")) continue;
    const target = path.resolve(path.join(ROOT, "surfaces", "shareholder-index"), href);
    if (!fs.existsSync(target)) broken.push(href);
  }
  assert("No broken relative links in shareholder-index", broken.length === 0,
    broken.length ? `broken: ${broken.join(", ")}` : "");
} else {
  assert("HTML link check skipped (missing file)", false);
}

// ── Gate 5: CI workflow has all required jobs ────────────────────────────
console.log("\n=== Gate 5 — CI workflow structure ===");
const ciYml = readFile(".github/workflows/ci.yml");
assert("ci.yml exists", !!ciYml);
if (ciYml) {
  assert("CI has validate-repo job", ciYml.includes("validate-repo"));
  assert("CI has test-python job", ciYml.includes("test-python"));
  assert("CI has test-node job", ciYml.includes("test-node"));
  assert("CI has convergence-check job", ciYml.includes("convergence-check"));
  assert("CI has integration-checks job", ciYml.includes("integration-checks"));
}

// ── Gate 7: Anti-sprawl — no new top-level dirs without approval ──────────
console.log("\n=== Gate 7 — Anti-sprawl: top-level directory policy ===");
// Only flag dirs that are newly added in the working tree vs HEAD
let unknownTop = [];
try {
  const { execSync } = require("child_process");
  const tracked = execSync("git ls-tree --name-only HEAD", { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const trackedSet = new Set(tracked);
  const status = execSync("git status --short", { cwd: ROOT, encoding: "utf8" }).trim();
  // Untracked dirs appear as ?? dirname/ or ?? dirname/file
  const untrackedDirs = new Set();
  for (const line of status.split("\n")) {
    if (line.startsWith("?? ")) {
      const rel = line.slice(3).trim();
      const top = rel.split("/")[0];
      // Only flag actual directories, not root-level files like package-lock.json
      if (top && !trackedSet.has(top) && fs.existsSync(path.join(ROOT, top)) && fs.statSync(path.join(ROOT, top)).isDirectory()) {
        untrackedDirs.add(top);
      }
    }
  }
  // Exempt standard build/cache dirs
  const exempt = new Set(["node_modules", "__pycache__", ".pytest_cache", "test-results", ".tmp.drivedownload", ".tmp.driveupload"]);
  unknownTop = [...untrackedDirs].filter((d) => !exempt.has(d) && !d.startsWith("."));
} catch (e) {
  assert("git available for anti-sprawl", false, e.message);
}
assert("No unapproved top-level directories", unknownTop.length === 0,
  unknownTop.length ? `new untracked dirs: ${unknownTop.join(", ")}` : "");

// ── Gate 8: No submodules ────────────────────────────────────────────────
console.log("\n=== Gate 8 — No submodule sprawl ===");
assert(".gitmodules does not exist", !fs.existsSync(path.join(ROOT, ".gitmodules")));

// ── Gate 9: No secrets in tracked files ──────────────────────────────────
console.log("\n=== Gate 9 — Secret leak prevention ===");
const secretPatterns = [
  /sk-[a-zA-Z0-9]{20,}/,          // OpenAI/Anthropic keys
  /ghp_[a-zA-Z0-9]{36}/,          // GitHub PAT
  /glpat-[a-zA-Z0-9\-]{20}/,      // GitLab token
  /AKIA[0-9A-Z]{16}/,             // AWS access key
  /[a-zA-Z0-9_-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // email (lightweight)
];
const scanDirs = ["src", "apps", "tests", "scripts", "skills", "docs"];
let secretHits = [];
for (const dir of scanDirs) {
  const files = listFiles(dir, ".js")
    .concat(listFiles(dir, ".ts"))
    .concat(listFiles(dir, ".py"))
    .concat(listFiles(dir, ".md"));
  for (const f of files) {
    const content = readFile(path.join(dir, f));
    if (!content) continue;
    for (const pattern of secretPatterns) {
      if (pattern.test(content) && !content.includes("process.env")) {
        // Allow process.env references (env var names, not values)
        secretHits.push(`${dir}/${f}`);
        break;
      }
    }
  }
}
assert("No hardcoded secrets in source/docs",
  secretHits.length === 0,
  secretHits.length ? `suspicious files: ${[...new Set(secretHits)].join(", ")}` : "");

// ── Gate 10: AGENTS.md rules are present ─────────────────────────────────
console.log("\n=== Gate 10 — AGENTS.md contract enforcement ===");
const agentsMd = readFile("AGENTS.md");
assert("AGENTS.md has build/test section", agentsMd && agentsMd.includes("pytest"));
assert("AGENTS.md mentions monoworkstream", agentsMd && agentsMd.includes("monoworkstream"));
assert("AGENTS.md mentions no secrets", agentsMd && agentsMd.includes("secret"));

// ── Gate 11: Dream Journal agent integrity ────────────────────────────────
console.log("\n=== Gate 11 — Dream Journal agent integrity ===");
const serverJs = readFile("apps/lantern-garage/server.js");
const dreamChatJs = readFile("apps/lantern-garage/lib/dream-chat.js");
const streamChatJs = readFile("apps/lantern-garage/lib/stream-chat.js");
assert("server.js exists", !!serverJs);
assert("dream-chat.js exists", !!dreamChatJs);
assert("stream-chat.js exists", !!streamChatJs);
if (serverJs) {
  assert("AGENT_PERSONAS defined", serverJs.includes("AGENT_PERSONAS"));
  assert("OpenAI provider present", serverJs.includes("OPENAI_API_KEY"));
  assert("Anthropic provider present", serverJs.includes("ANTHROPIC_API_KEY"));
  assert("Ollama fallback present", serverJs.includes("OLLAMA_BASE_URL"));
}
if (dreamChatJs) {
  assert("selectAgent function exists", dreamChatJs.includes("function selectAgent"));
}
if (streamChatJs) {
  assert("Offline fallback present", streamChatJs.includes("sendFail"));
  assert("Grok provider present", streamChatJs.includes("grok"));
}

// ── Gate 12: Chat settings drawer in UI ──────────────────────────────────
console.log("\n=== Gate 12 — Chat UX settings drawer ===");
// Reads chat.html, not dream-chat.html. #2751 renamed the surface and left an
// 8-line redirect stub behind; this gate kept reading the stub, so every content
// assertion below was checking a file that contains none of these markers. The
// stub was retired in #3109 — pointing at the real page restores the gate.
const chatHtmlPath = path.join(ROOT, "apps", "lantern-garage", "public", "chat.html");
const chatHtml = fs.existsSync(chatHtmlPath) ? fs.readFileSync(chatHtmlPath, "utf8") : null;
assert("chat.html exists", !!chatHtml);
if (chatHtml) {
  assert("settings-drawer defined", chatHtml.includes("settings-drawer"));
  assert("provider-card defined", chatHtml.includes("provider-card"));
  assert("saveKey function", chatHtml.includes("saveKey"));
  assert("Grok option present", chatHtml.includes("grok"));
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Fix failures before opening a PR.");
  process.exit(1);
} else {
  console.log("All CI/CD expectations met. Safe to push.");
  process.exit(0);
}
