"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const research = require("../apps/lantern-garage/public/js/orchestration-research.js");

const items = [
  { issueNumber: 20, title: "Later unlabeled", labels: ["docs"], priority: 0, updatedAt: "2026-06-24T12:00:00Z", url: "https://example.test/20" },
  { issueNumber: 10, title: "Urgent routing fix", labels: ["p0", "convergence"], priority: 3, updatedAt: "2026-06-24T10:00:00Z", url: "https://example.test/10" },
  { issueNumber: 15, title: "Second priority", labels: ["p1"], priority: 2, updatedAt: "2026-06-24T11:00:00Z", url: "https://example.test/15" },
];

assert.deepStrictEqual(research.filterAndSort(items).map((x) => x.issueNumber), [10, 15, 20]);
assert.deepStrictEqual(
  research.filterAndSort(items, { sort: "updated" }).map((x) => x.issueNumber),
  [20, 15, 10]
);
assert.deepStrictEqual(
  research.filterAndSort(items, { query: "convergence", priority: "p0" }).map((x) => x.issueNumber),
  [10]
);
assert.strictEqual(research.priorityLabel(items[0]), "Unlabeled");

const handoff = research.buildHandoff(items[1], "Codex");
assert(handoff.includes("issue #10: Urgent routing fix"));
const handoffLines = handoff.split("\n");
const sourceIndex = handoffLines.indexOf("Source of truth");
assert(sourceIndex >= 0);
assert.strictEqual(handoffLines[sourceIndex + 1], "https://example.test/10");
assert(handoff.includes("Do not broaden scope beyond the issue."));
assert(handoff.includes("Do not claim completion without code/test evidence."));

const prompt = research.buildResearchPrompt(items[1]);
assert(prompt.includes("Do not write code yet."));
assert(prompt.includes("copy-ready Codex handoff"));

const history = research.appendHistory(
  Array.from({ length: 10 }, (_, i) => ({ issueNumber: i })),
  { issueNumber: 99, target: "codex" }
);
assert.strictEqual(history.length, 10);
assert.strictEqual(history[0].issueNumber, 99);

const html = fs.readFileSync(
  path.join(__dirname, "../apps/lantern-garage/public/work.html"),
  "utf8"
);
for (const contract of [
  'id="researchHandoffPanel"',
  'id="researchSearch"',
  'id="researchPriority"',
  'id="researchSort"',
  'id="researchRefresh"',
  "/api/queue/list?status=pending",
  "/chat.html?seed=",
  "Copy Codex handoff",
  "Copy Claude Code handoff",
  "Nothing is auto-dispatched",
  "/js/orchestration-research.js",
]) {
  assert(html.includes(contract), `orchestration page missing contract: ${contract}`);
}

console.log("orchestration research handoff tests passed");
