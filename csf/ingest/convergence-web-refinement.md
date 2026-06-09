# Convergence Web Refinement — v1.0.2+ Roadmap

**Status:** Design contract — pending web research validation  
**Slot:** `dream_journal/convergence_web_refinement` (priority 8)  
**Owner:** Agent pool (any)  
**Effort estimate:** 2–3 sessions  
**Files to change:** `src/convergence_io_engine.py`, `.github/workflows/ci.yml`, `data/pcsf/*.pcsf.json`, `manifests/validation/`

---

## Problem

The current 12-phase convergence loop (`src/convergence_io_engine.py`) is effective but manual:

1. **No automated evidence collection** — receipts are JSON files written locally, not surfaced to CI.
2. **No promotion gate integration** — `promotion_ready=True` is a local check; GitHub Actions does not read it.
3. **No drift detection** — Phase 4 "state_objective" always returns `"unknown"` because there is no objective manifest.
4. **No rollback coupling** — convergence pass and git revert are not linked.
5. **Monoworkstream is shell-script enforced** — not backed by a GitHub App or branch protection rule.

## Proposed Refinements

### 1. Automated Evidence Collection (Phase 11 → CI Artifact)

**Current:** `record_evidence` writes to `manifests/evidence/convergence-*.json`.  
**Target:** Upload convergence receipt as a CI artifact + post a PR comment with the promotion verdict.

```yaml
# .github/workflows/ci.yml addition
- name: Convergence Evidence
  run: python src/convergence_io_engine.py loop > convergence-report.json
- name: Upload Evidence
  uses: actions/upload-artifact@v4
  with:
    name: convergence-evidence
    path: convergence-report.json
- name: PR Promotion Gate
  if: github.event_name == 'pull_request'
  run: |
    verdict=$(jq -r '.promotion_ready' convergence-report.json)
    if [ "$verdict" != "true" ]; then
      echo "::error::Convergence loop failed — promotion blocked"
      exit 1
    fi
```

### 2. Objective Manifest (Phase 4 Fix)

**Current:** `"objective": "unknown"` always.  
**Target:** Read `manifests/objective-v1.0.2.json` if present; fall back to parsing the PR title/body for objective keywords.

```python
# src/convergence_io_engine.py
OBJECTIVE_PATH = REPO_ROOT / "manifests" / "objective-current.json"

def _read_objective():
    if OBJECTIVE_PATH.exists():
        return json.loads(OBJECTIVE_PATH.read_text()).get("objective", "unknown")
    # Fallback: parse CHANGELOG [Unreleased] or PR body
    return "unknown"
```

### 3. Drift Detection Between Runs (Phase 1 Enhancement)

Compare current convergence receipt with previous run:

```python
def _detect_drift(current, previous_path):
    if not previous_path.exists():
        return {"status": "first_run", "drift": []}
    prev = json.loads(previous_path.read_text())
    drift = []
    for check in current["checks"]:
        prev_check = next((c for c in prev.get("checks", []) if c["id"] == check["id"]), {})
        if prev_check.get("state") != check["state"]:
            drift.append({"id": check["id"], "from": prev_check.get("state"), "to": check["state"]})
    return {"status": "drift_detected" if drift else "stable", "drift": drift}
```

### 4. Git-Coupled Rollback Path

If convergence fails post-merge, auto-tag the last known good commit:

```bash
# scripts/convergence-rollback.sh
LAST_GOOD=$(git log --grep="promotion_ready=True" --oneline -1 | cut -d' ' -f1)
git tag -f "convergence-good-${LAST_GOOD}" "$LAST_GOOD"
```

### 5. Branch Protection Rule for Monoworkstream

Replace shell-hook enforcement with a GitHub branch protection rule:

```yaml
# .github/workflows/monoworkstream-gate.yml
name: Monoworkstream Gate
on:
  pull_request:
    types: [opened, reopened, synchronize]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check open PR count
        run: |
          open_count=$(gh pr list --state open --json number --jq 'length')
          if [ "$open_count" -gt 1 ]; then
            echo "::error::Monoworkstream violation: $open_count PRs open"
            exit 1
          fi
```

---

## Implementation Order

1. **Phase A** — CI artifact upload + PR comment (1 session)
2. **Phase B** — Objective manifest parser + drift detection (1 session)
3. **Phase C** — Branch protection rule + rollback tag script (1 session)

---

## Validation

- [x] `python src/convergence_io_engine.py loop` produces artifact in CI — implemented in `.github/workflows/ci.yml` (job `convergence-loop`)
- [ ] PR with `promotion_ready=false` is blocked by CI gate — gate logic added; needs live PR test
- [x] `manifests/objective-current.json` changes Phase 4 output — Phase B (implemented 2026-06-09)
- [x] Drift between two runs is detectable and reported — Phase B (implemented 2026-06-09)
- [x] `git tag -l "convergence-good-*"` shows rollback targets — Phase C (implemented 2026-06-09)

---

## Validated Research Findings

### 1. GitOps Promotion Gates (Kargo / Argo CD model)
**Source:** Akuity — "Kargo: The Missing GitOps Promotion Layer" (2026-03-18)

Key insight: **CI tools are built for synchronous, short-lived tasks; continuous deployment is asynchronous, multi-environment, and approval-gated.** Classic pipelines are linear, stateless, and do not reconcile — they cannot reliably answer "what is actually deployed, and where?"

Kargo solves this with:
- **Freight model:** Each promotion moves a bundle (container image + Git commit + config values) through defined stages
- **Stage-gated verification:** Each stage pulls metrics from monitoring to confirm deployment health before promotion continues
- **Git-backed audit trail:** Rendered manifests go back into Git, making every environment state auditable and reviewable
- **Set-and-forget promotions:** Developers merge; the pipeline handles the rest with fewer manual handoffs

**Lantern OS applicability:** The convergence loop's `promotion_ready` flag is conceptually identical to Kargo's stage verification. We should treat convergence receipts as "freight verification artifacts" and surface them to CI.

---

### 2. Monorepo CI Convergence Patterns
**Source:** monorepo.tools (Nx / Turborepo / Bazel canonical reference)

Key capabilities for monorepo CI optimization:
- **Affected Detection:** Only run tasks for projects changed by a commit — skip everything else
- **Remote Caching:** Share computation results across the organization; if a teammate already built it, you get the result instantly
- **Distributed Task Execution:** Distribute work across multiple machines while preserving local developer experience
- **Task Splitting:** Break large tasks into fine-grained cacheable units; each slice can be cached independently
- **Deflaking:** Automatically detect flaky tests, quarantine them, and re-run only what failed

**Lantern OS applicability:** The repo is small enough that full Bazel/Nx is overkill, but **affected detection** is directly relevant. The convergence loop should skip phases that don't apply to the files changed in a PR. For example, a docs-only change doesn't need the full 12-phase convergence.

---

### 3. DORA / Four Keys Metrics
**Source:** Google Cloud — "Use Four Keys metrics like change failure rate to measure your DevOps performance"

The four metrics:
1. **Deployment Frequency** — how often an organization successfully releases to production
   - Bucketing: "daily" = median ≥3 days per week with at least one deployment
   - Must define what counts as a "successful deployment" (full traffic vs. partial rollout)
2. **Lead Time for Changes** — time from commit to production
   - Requires SHA mapping from deployment table back to commits table
   - Median lead time is the standard calculation
3. **Change Failure Rate** — % of deployments causing failure in production
   - Links deployment table to incidents (bugs, GitHub issues, incident management system)
   - Requires deployment ID in incident records for JOIN
4. **Time to Restore Services** — recovery time from production failure
   - Needs incident creation time + resolution time + deployment that resolved it

**Lantern OS applicability:** The convergence loop's `promotion_ready` gate is a proxy for Change Failure Rate. We should track:
- How many PRs passed convergence vs. failed
- Median time from PR open to merge (Lead Time)
- How often `master` is promoted (Deployment Frequency)
- Time from convergence failure to fix (Time to Restore)

These can be extracted from `data/agent-fleet/tesseract-convergence.jsonl` logs.

---

## References

1. Akuity. *Kargo: The Missing GitOps Promotion Layer.* Mar 2026. https://akuity.io/blog/kargo-gitops-promotion-layer
2. Nx Team. *Monorepo Explained.* https://monorepo.tools/
3. Google Cloud. *Use Four Keys metrics like change failure rate to measure your DevOps performance.* https://cloud.google.com/blog/products/devops-sre/using-the-four-keys-to-measure-your-devops-performance
4. Forsgren, Humble, Kim. *Accelerate: The Science of Lean Software and DevOps.* 2018.

**Next action:** Implement Phase B — Objective manifest parser + drift detection (`src/convergence_io_engine.py`).
