"use strict";

// Deterministic mock coding backend — used by tests and as the reference adapter
// contract. A backend PROPOSES a change (new file contents) without applying it;
// the control plane holds it for approval and emits a receipt.

module.exports = {
  name: "mock",
  installHint: null,
  async available() {
    return true;
  },
  async propose({ task, model }) {
    const slug =
      String(task || "task")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "task";
    const rel = `keystone-notes/${slug}.md`;
    const content = `# ${task}\n\n_Proposed by the mock coding backend (control-plane slice)._\n`;
    const patchPreview =
      `+++ b/${rel}\n` + content.split("\n").map((l) => `+${l}`).join("\n");
    return {
      ok: true,
      backend: "mock",
      model: model || "mock-1", // echoes the registry-resolved local engine (#2171)
      costUsd: 0,
      filesChanged: [{ path: rel, content }],
      patchPreview,
    };
  },
};
