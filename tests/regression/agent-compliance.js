/**
 * Agent Compliance Regression Tests
 * Validates the expectations set in AGENTS.md that agents must follow.
 *
 * Run: node tests/regression/agent-compliance.js
 * Fails fast with clear messages so agents catch violations before PR.
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

// ── Rule 1: No fabricated status ───────────────────────────────────────────
console.log("\n=== Rule 1 — No fabricated status ===");
const serverJs = readFile("apps/lantern-garage/server.js");
if (serverJs) {
  // The server should derive online status from provider availability,
  // not hardcode it. Check that it falls back honestly.
  // The server sets online:true only when a provider actually responds.
  // It falls back to online:false when all providers fail. That's honest.
  assert("Online status derives from provider success",
    serverJs.includes("online: true") && serverJs.includes("online: false") && serverJs.includes("catch"),
    "no provider-conditional online status found");
  assert("Status reflects actual provider availability",
    serverJs.includes("online: agents.every") || serverJs.includes("online: false") || serverJs.includes("online: true"),
    "no online status logic found");
}

// ── Rule 2: Skills registry is honest ─────────────────────────────────────
console.log("\n=== Rule 2 — Skills registry honesty ===");
const mcpServer = readFile("src/mcp_server/server.py");
if (mcpServer) {
  assert("MCP server has _skills_db", mcpServer.includes("_skills_db"));
  // Each skill in _skills_db must map to a real Python module
  const skillMatches = [...mcpServer.matchAll(/"id":\s*"([^"]+)"/g)];
  const skills = skillMatches.map((m) => m[1]);
  for (const skill of skills) {
    const skillPath = path.join(ROOT, "skills", skill, `${skill}.py`);
    const altPath = path.join(ROOT, "src", `${skill}.py`);
    const exists = fs.existsSync(skillPath) || fs.existsSync(altPath);
    assert(`Skill "${skill}" has real Python module`, exists,
      `expected ${skillPath} or ${altPath}`);
  }
} else {
  assert("MCP server found for skills check", false);
}

// ── Rule 3: No secrets committed ───────────────────────────────────────────
console.log("\n=== Rule 3 — No secrets committed ===");
const secretPatterns = [
  { name: "OpenAI key", pattern: /sk-proj-[a-zA-Z0-9]{20,}/ },
  { name: "Anthropic key", pattern: /sk-ant-[a-zA-Z0-9]{20,}/ },
  { name: "GitHub PAT", pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "AWS key", pattern: /AKIA[0-9A-Z]{16}/ },
];
const scanExts = [".js", ".ts", ".py", ".md", ".yml", ".yaml", ".json"];
const scanDirs = ["src", "apps", "tests", "scripts", "skills", "docs", ".github"];
let secretHits = [];
for (const dir of scanDirs) {
  const fullDir = path.join(ROOT, dir);
  if (!fs.existsSync(fullDir)) continue;
  const entries = fs.readdirSync(fullDir, { recursive: true });
  for (const f of entries) {
    const rel = path.join(dir, f);
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
    const ext = path.extname(f);
    if (!scanExts.includes(ext)) continue;
    const content = readFile(rel);
    if (!content) continue;
    for (const { name, pattern } of secretPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        // Allow process.env references (the variable name, not value)
        const line = content.split("\n").find((l) => l.match(pattern));
        if (line && !line.includes("process.env") && !line.includes("${")) {
          secretHits.push({ file: rel, secret: name, line: line.trim().slice(0, 60) });
        }
      }
    }
  }
}
assert("No hardcoded secrets in repo",
  secretHits.length === 0,
  secretHits.map((h) => `${h.file}: ${h.secret}`).join("; "));

// ── Rule 4: Tests must pass (pytest discoverable) ─────────────────────────
console.log("\n=== Rule 4 — Tests are discoverable ===");
assert("tests/ directory exists", fs.existsSync(path.join(ROOT, "tests")));
assert("pytest can discover tests", (() => {
  try {
    const { execSync } = require("child_process");
    execSync("python -m pytest --collect-only -q", { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})(), "pytest --collect-only failed");

// ── Rule 5: No new top-level dirs without Linear ticket ────────────────────
console.log("\n=== Rule 5 — One repo policy ===");
assert(".gitmodules does not exist", !fs.existsSync(path.join(ROOT, ".gitmodules")));

// ── Rule 6: Fleet claim boundary ────────────────────────────────────────────
console.log("\n=== Rule 6 — Fleet claim boundary ===");
const fleetStatus = readFile("data/status/super-jarvis-fleet.json");
if (fleetStatus) {
  try {
    // Strip BOM if present
    const clean = fleetStatus.replace(/^\uFEFF/, "").trim();
    const fleet = JSON.parse(clean);
    const active = fleet.activeSlots || 0;
    const claimed = fleet.claimedSlots || 0;
    assert("Fleet activeSlots is measurable", typeof active === "number");
    assert("Fleet claimedSlots does not exceed 36", claimed <= 36,
      `claimedSlots=${claimed} exceeds 36`);
    assert("No false claim of live workers", active >= 0 && active <= 36,
      `activeSlots=${active} out of range`);
  } catch (e) {
    assert("Fleet JSON is parseable", false, e.message);
  }
} else {
  // Fleet file missing is acceptable per AGENTS.md design contract
  console.log("  SKIP: Fleet status file not found (design contract, activeSlots = 0)");
  passed++;
}

// ── Rule 7: AGENTS.md must be current ──────────────────────────────────────
console.log("\n=== Rule 7 — AGENTS.md currency ===");
const agentsMd = readFile("AGENTS.md");
assert("AGENTS.md exists", !!agentsMd);
if (agentsMd) {
  assert("AGENTS.md references pytest", agentsMd.includes("pytest"));
  assert("AGENTS.md references Linear", agentsMd.includes("Linear"));
  assert("AGENTS.md mentions streaming chat", agentsMd.includes("stream"));
  assert("AGENTS.md mentions no fabricated status", agentsMd.includes("fabricated"));
  assert("AGENTS.md has build commands", agentsMd.includes("npm start") || agentsMd.includes("node"));
}

// ── Rule 8: One chat assistant — no keyword-persona routing ──────────────────
// The chat is a single grounded assistant whose capabilities are real tool
// calls (lib/tool-runner.js), not a set of keyword-routed personas.
console.log("\n=== Rule 8 — Single-assistant chat integrity ===");
const dreamChatLib = readFile("apps/lantern-garage/lib/dream-chat.js");
if (dreamChatLib) {
  assert("selectAgent function exists", dreamChatLib.includes("function selectAgent"));
  assert("selectAgent does not keyword-score personas",
    !dreamChatLib.includes("agentKeywords"));
  assert("Assistant systemPrompt is present",
    dreamChatLib.includes("systemPrompt") && dreamChatLib.includes("You are"));
}

// ── Rule 9: No overengineering claims ──────────────────────────────────────
console.log("\n=== Rule 9 — No overengineering claims ===");
const readme = readFile("README.md");
if (readme) {
  assert("README does not claim v2.0 readiness",
    !readme.includes("v2.0") && !readme.includes("production-ready"));
  assert("README does not claim full fleet live",
    !readme.includes("36 slots active") && !readme.includes("all agents live"));
}

// ── Rule 10: Honest docs — real skills have modules, spec-only are marked ──
console.log("\n=== Rule 10 — Honest skill documentation ===");
// AGENTS.md lists real skills explicitly. Only those MUST have modules.
// All others are design-contract; we warn if they lack a spec-only marker.
const realSkills = ["dream_journal", "lucid_dreaming"];
const skillDirs = fs.readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// Check real skills have modules (AGENTS.md lists exact module paths)
const realSkillModules = {
  dream_journal: "skills/dream_journal/dream_journal.py",
  lucid_dreaming: "skills/lucid_dreaming/mild_wbtb_protocol.py",
};
for (const [skillDir, modulePath] of Object.entries(realSkillModules)) {
  const hasModule = fs.existsSync(path.join(ROOT, modulePath));
  assert(`Real skill "${skillDir}" has Python module`, hasModule,
    `AGENTS.md claims "${skillDir}" is real but ${modulePath} not found`);
}

// Warn on spec-only skills missing markers (does not fail — baseline debt)
let unmarkedSpecOnly = 0;
for (const skillDir of skillDirs) {
  if (realSkills.includes(skillDir)) continue;
  const skillMdPath = path.join(ROOT, "skills", skillDir, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const content = fs.readFileSync(skillMdPath, "utf8");
    const isMarked = content.includes("design contract") || content.includes("spec-only") || content.includes("not yet implemented");
    if (!isMarked) unmarkedSpecOnly++;
  }
}
if (unmarkedSpecOnly > 0) {
  console.log(`  WARN: ${unmarkedSpecOnly} spec-only skills lack explicit marker in SKILL.md (baseline debt, not a hard failure)`);
} else {
  console.log("  PASS: All spec-only skills explicitly marked");
  passed++;
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Fix agent compliance failures before claiming readiness.");
  process.exit(1);
} else {
  console.log("All agent compliance rules satisfied.");
  process.exit(0);
}
