// Modal is a first-class GPU-training provider: registered in the default registry as
// an automatable bf16 provider, wired into dispatch/poll, and merged into any on-disk
// PCSF that predates it (so it appears on the fleet host without hand-editing the
// runtime-local, gitignored gpu-training.pcsf.json). This locks that wiring so a future
// refactor can't silently drop Modal from the orchestration page.
//
// Run: node test/modal-provider.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const dispatcher = require("../lib/training-dispatcher");

check("loadGpuPcsf returns modal as an automatable bf16 provider", () => {
  const pcsf = dispatcher.loadGpuPcsf();
  const modal = (pcsf.providers || []).find(p => p.provider_id === "modal");
  assert.ok(modal, "modal provider missing from registry");
  assert.strictEqual(modal.automatable, true, "modal must be automatable (dispatch-all)");
  assert.deepStrictEqual(modal.auth_env, ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]);
  assert.ok(/bf16/i.test(modal.gpu), "modal GPU should be bf16-capable (L4), got " + modal.gpu);
  assert.ok((modal.quota_hours_per_week || 0) > 0, "quota must be >0 so dispatch-all includes it");
});

check("modal sits in the rotation right after lightning (the redundant twin)", () => {
  const pcsf = dispatcher.loadGpuPcsf();
  const order = pcsf.rotation_order || [];
  assert.ok(order.includes("modal"), "rotation_order must include modal");
  const li = order.indexOf("lightning"), mi = order.indexOf("modal");
  if (li >= 0) assert.ok(mi === li + 1, "modal should immediately follow lightning in rotation");
});

check("loadGpuPcsf appends modal to an on-disk PCSF that lacks it (no clobber)", () => {
  // Simulate a host whose runtime file predates modal: it must be appended, and the
  // pre-existing lightning entry's live state must be preserved untouched.
  const REPO = path.resolve(__dirname, "..");
  const target = path.join(REPO, "data", "pcsf", "gpu-training.pcsf.json");
  const existed = fs.existsSync(target);
  const backup = existed ? fs.readFileSync(target) : null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, JSON.stringify({
      providers: [{ provider_id: "lightning", automatable: true, state: "degraded",
                    last_error: "keep-me", auth_env: ["LIGHTNING_USER_ID", "LIGHTNING_API_KEY"] }],
      rotation_order: ["lightning"],
    }));
    const pcsf = dispatcher.loadGpuPcsf();
    const ids = pcsf.providers.map(p => p.provider_id);
    assert.ok(ids.includes("modal"), "modal should be appended to the on-disk registry");
    const light = pcsf.providers.find(p => p.provider_id === "lightning");
    assert.strictEqual(light.state, "degraded", "on-disk lightning state must not be clobbered");
    assert.strictEqual(light.last_error, "keep-me", "on-disk lightning fields must be preserved");
    assert.ok(pcsf.rotation_order.includes("modal"), "modal spliced into on-disk rotation");
  } finally {
    if (backup) fs.writeFileSync(target, backup);
    else fs.rmSync(target, { force: true });
  }
});

// NOTE: we do NOT invoke dispatchTrainingJob("modal") here. The dispatcher syncs real
// GPU credentials from the OS User-env scope (_syncUserEnvKeys), so a call would launch a
// REAL Modal job regardless of process.env — deleting the vars can't neutralize it. We
// assert the wiring statically instead.
check("dispatcher wires modal into dispatch AND poll (static — never launches a job)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../lib/training-dispatcher.js"), "utf8");
  assert.ok(/provider === "modal"\)\s*return _dispatchModal/.test(src), "dispatch switch missing modal");
  assert.ok(/provider === "modal"\)\s*return _pollModal/.test(src), "poll switch missing modal");
  assert.ok(/function _dispatchModal\b/.test(src) && /function _pollModal\b/.test(src),
    "_dispatchModal/_pollModal must be defined");
  assert.ok(/modal_dispatch\.py/.test(src), "must invoke scripts/modal_dispatch.py");
});

check("modal_dispatch.py exists and exposes dispatch/poll/stop", () => {
  const script = path.resolve(__dirname, "..", "scripts", "modal_dispatch.py");
  assert.ok(fs.existsSync(script), "scripts/modal_dispatch.py missing");
  const src = fs.readFileSync(script, "utf8");
  for (const cmd of ["dispatch", "poll", "stop"]) {
    assert.ok(src.includes(`"${cmd}"`) || src.includes(`'${cmd}'`), `subcommand ${cmd} missing`);
  }
  assert.ok(/output\.modal\.csf/.test(src), "modal artifact must be namespaced to avoid clobbering output.csf");
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
