const fs = require("fs");
const path = require("path");

const DEFAULT_CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".ps1",
  ".sh",
  ".html",
  ".css",
]);

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
]);

function safeRelative(repoRoot, targetPath) {
  return path.relative(repoRoot, targetPath).replace(/\\/g, "/");
}

function walkCodeFiles(repoRoot, options = {}) {
  const maxFiles = Number(options.maxFiles || 500);
  const codeExtensions = options.codeExtensions || DEFAULT_CODE_EXTENSIONS;
  const ignoreDirs = options.ignoreDirs || DEFAULT_IGNORE_DIRS;
  const files = [];

  function visit(dir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (codeExtensions.has(ext)) files.push(fullPath);
    }
  }

  visit(repoRoot);
  return files;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function summarizeCodeFile(repoRoot, filePath) {
  const text = readText(filePath);
  const relativePath = safeRelative(repoRoot, filePath);
  const routeMatches = [...text.matchAll(/url\.pathname\s*={0,2}\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
  const writeSignals = [
    "writeFile",
    "appendFile",
    "appendJsonlQueued",
    "writeTextQueued",
    "spawn(",
    "spawnSync(",
  ].filter((signal) => text.includes(signal));
  const readSignals = [
    "readFile",
    "readFileSync",
    "readJson",
    "readJsonl",
    "sendFile",
  ].filter((signal) => text.includes(signal));

  return {
    path: relativePath,
    lines: text ? text.split(/\r?\n/).length : 0,
    routes: routeMatches,
    routeCount: routeMatches.length,
    writable: writeSignals.length > 0,
    writeSignals,
    readSignals,
  };
}

function buildReviewDoor(repoRoot = path.resolve(__dirname, "..", "..")) {
  const codeFiles = walkCodeFiles(repoRoot);
  const summaries = codeFiles.map((filePath) => summarizeCodeFile(repoRoot, filePath));
  const routeFiles = summaries.filter((item) => item.routeCount > 0);
  const writableFiles = summaries.filter((item) => item.writable);
  const readHeavyFiles = summaries.filter((item) => item.readSignals.length > 0 && !item.writable);
  const totalRoutes = summaries.reduce((sum, item) => sum + item.routeCount, 0);

  return {
    generatedAt: new Date().toISOString(),
    service: "lantern-garage-review-door",
    mode: "summary_only_static_scan",
    boundary: "Reports code structure and likely mutation surfaces. Does not read private JSONL contents or execute repo actions.",
    scanned: {
      repoRoot,
      codeFileCount: codeFiles.length,
      routeFileCount: routeFiles.length,
      writableFileCount: writableFiles.length,
      totalRouteCount: totalRoutes,
    },
    routeSurfaces: routeFiles.map((item) => ({
      path: item.path,
      routeCount: item.routeCount,
      routes: item.routes.slice(0, 40),
    })),
    writableSurfaces: writableFiles.map((item) => ({
      path: item.path,
      writeSignals: item.writeSignals,
    })),
    readOnlySurfaces: readHeavyFiles.slice(0, 40).map((item) => ({
      path: item.path,
      readSignals: item.readSignals,
    })),
    nextCodeDoors: [
      {
        label: "A",
        title: "The Safer Body",
        change: "Harden HTML responses by giving sendHtml the same security headers used by JSON and file responses.",
        risk: "Low. Header behavior can affect embedding or browser integrations.",
      },
      {
        label: "B",
        title: "The Review Lens",
        change: "Wire this review-door module into GET /api/review-door in server.js.",
        risk: "Low to medium. Summary must remain non-secret and read-only.",
      },
      {
        label: "C",
        title: "The Living Route",
        change: "Add GET /api/doors/next to return future-tense code-change choices from the current review signal.",
        risk: "Medium. Door generation must not become misleading automation.",
      },
    ],
  };
}

if (require.main === module) {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "..", "..");
  process.stdout.write(`${JSON.stringify(buildReviewDoor(repoRoot), null, 2)}\n`);
}

module.exports = {
  buildReviewDoor,
  walkCodeFiles,
  summarizeCodeFile,
};
