(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrchestrationResearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRIORITY_LABELS = { 3: "P0", 2: "P1", 1: "P2", 0: "Unlabeled" };

  function priorityLabel(item) {
    return PRIORITY_LABELS[Number(item?.priority) || 0] || "Unlabeled";
  }

  function matches(item, query, priority) {
    if (priority && priority !== "all" && priorityLabel(item).toLowerCase() !== priority.toLowerCase()) {
      return false;
    }
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return true;
    return [item?.issueNumber, item?.title, ...(Array.isArray(item?.labels) ? item.labels : [])]
      .join(" ").toLowerCase().includes(needle);
  }

  function filterAndSort(items, options = {}) {
    const sort = options.sort === "updated" ? "updated" : "priority";
    return (Array.isArray(items) ? items : [])
      .filter((item) => matches(item, options.query, options.priority || "all"))
      .slice()
      .sort((a, b) => {
        const updated = new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
        return sort === "updated" ? updated : (Number(b.priority || 0) - Number(a.priority || 0)) || updated;
      });
  }

  function buildHandoff(item, target = "Codex") {
    const issueNumber = String(item?.issueNumber ?? "").trim();
    const title = String(item?.title ?? "").trim();
    const url = String(item?.url ?? "").trim();
    return [
      `You are ${target}, working on lantern-os issue #${issueNumber}: ${title}`,
      "", "Goal", title, "", "Source of truth", url, "", "Constraints",
      "- Read the issue and relevant repo code before editing.",
      "- Do not broaden scope beyond the issue.",
      "- Preserve the single Convergence Core; do not add a parallel subsystem.",
      "- Keep changes on a dedicated branch and open a draft PR.",
      "- Run focused tests. If tests cannot run, say exactly why.",
      "- Do not claim completion without code/test evidence.",
      "", "Deliver", "- implementation summary", "- files changed",
      "- tests run and results", "- known limitations / follow-ups",
    ].join("\n");
  }

  function buildResearchPrompt(item) {
    return [
      buildHandoff(item, "Keystone Chat"),
      "",
      "Research this issue before proposing a patch. Read the issue, identify dependencies and current implementation, separate verified facts from assumptions, then return a recommended bounded plan and a copy-ready Codex handoff. Do not write code yet.",
    ].join("\n");
  }

  function appendHistory(history, entry, limit = 10) {
    return [entry, ...(Array.isArray(history) ? history : [])].slice(0, limit);
  }

  return { priorityLabel, matches, filterAndSort, buildHandoff, buildResearchPrompt, appendHistory };
});
