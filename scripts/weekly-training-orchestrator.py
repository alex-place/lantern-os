#!/usr/bin/env python3
"""
Weekly Training Orchestrator
Σ₀ self-improvement loop: dispatch → train → benchmark → archive → update issues

Runs every Monday at 00:00 UTC. Fans out to all automatable GPU providers (Kaggle + Lightning).
Polls for completion, runs HumanEval benchmarks, logs convergence records, updates GitHub issues.

Usage:
    python scripts/weekly-training-orchestrator.py

Environment:
    LANTERN_SERVER_URL — local server (default: http://127.0.0.1:4177)
    GITHUB_TOKEN — for updating issues with results
    HF_TOKEN — for checkpoint transport between providers
"""

import asyncio
import json
import os
import sys
import subprocess
import time
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Optional

# Configure logging
import logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).parent.parent
SERVER_URL = os.environ.get("LANTERN_SERVER_URL", "http://127.0.0.1:4177")
JOBS_LOG = REPO_ROOT / "data" / "self-improvement" / "training-jobs.jsonl"
CONVERGENCE_LOG = REPO_ROOT / "data" / "training" / "convergence-records.jsonl"


class WeeklyTrainingOrchestrator:
    """Orchestrate Ouro model training + benchmarking + issue updates."""

    def __init__(self):
        self.run_id = f"weekly-{datetime.utcnow().isoformat()}"
        self.dispatched_jobs = []
        self.benchmark_results = {"measured": False, "status": "not_run"}

    async def dispatch_all(self):
        """POST /api/gpu-training/dispatch-all to fan out to all automatable providers."""
        logger.info("📤 Dispatching training jobs to all automatable providers...")
        try:
            import urllib.request
            import json as j

            url = f"{SERVER_URL}/api/gpu-training/dispatch-all"
            body = j.dumps({"steps": 600})
            req = urllib.request.Request(
                url,
                data=body.encode(),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req) as resp:
                result = j.loads(resp.read())

            if "dispatched" in result:
                self.dispatched_jobs = result["dispatched"]
                logger.info(f"✓ Dispatched {len(self.dispatched_jobs)} jobs")
                for job in self.dispatched_jobs:
                    if not job.get("error"):
                        logger.info(f"  - {job.get('provider')}: {job.get('jobId', 'manual')}")
            return result
        except Exception as e:
            logger.error(f"❌ Dispatch failed: {e}")
            return {"error": str(e)}

    async def poll_jobs(self, timeout_hours: int = 12):
        """Poll all dispatched jobs until completion or timeout."""
        logger.info(f"⏳ Polling {len(self.dispatched_jobs)} jobs (timeout: {timeout_hours}h)...")

        start_time = time.time()
        timeout_sec = timeout_hours * 3600

        # Filter to auto-dispatched jobs only (ignore manual_required)
        auto_jobs = [j for j in self.dispatched_jobs if j.get("status") != "manual_required" and not j.get("error")]

        if not auto_jobs:
            logger.info("No auto-dispatchable jobs to poll (all manual or failed)")
            return

        while True:
            elapsed = time.time() - start_time
            if elapsed > timeout_sec:
                logger.warning(f"⏱️ Timeout after {timeout_hours}h — stopping poll")
                break

            try:
                import urllib.request
                import json as j

                all_done = True
                for job in auto_jobs:
                    provider = job.get("provider")
                    job_id = job.get("jobId")

                    if not provider or not job_id:
                        continue

                    url = f"{SERVER_URL}/api/gpu-training/poll"
                    body = j.dumps({"provider": provider, "jobId": job_id})
                    req = urllib.request.Request(
                        url,
                        data=body.encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST"
                    )
                    with urllib.request.urlopen(req) as resp:
                        result = j.loads(resp.read())

                    status = result.get("status", "unknown")
                    if status in ["running", "queued"]:
                        all_done = False
                        logger.info(f"  {provider} {job_id}: {status}")
                    elif status == "done":
                        logger.info(f"  ✓ {provider} {job_id}: done")
                    elif status == "failed":
                        logger.error(f"  ✗ {provider} {job_id}: failed")

                if all_done:
                    logger.info("✓ All jobs completed!")
                    break

                # Poll every 5 minutes
                await asyncio.sleep(300)
            except Exception as e:
                logger.warning(f"Poll error: {e}, retrying...")
                await asyncio.sleep(60)

    async def run_humaneval_benchmarks(self):
        """Run HumanEval on the latest Ouro checkpoint."""
        logger.info("🧪 Running HumanEval benchmarks...")

        # Find latest checkpoint from Hugging Face
        checkpoint_repo = os.environ.get("HF_TRAINING_REPO", "ouro-checkpoints")

        try:
            # Download checkpoint from HF and evaluate
            script = REPO_ROOT / "experiments" / "humaneval_runner.py"
            if not script.exists():
                logger.warning(f"HumanEval script not found: {script}")
                return

            result = subprocess.run(
                [sys.executable, str(script), "--repo", checkpoint_repo],
                capture_output=True,
                text=True,
                timeout=3600
            )

            if result.returncode == 0:
                output = result.stdout
                logger.info(f"✓ HumanEval results:\n{output}")
                # Parse and store results
                try:
                    self.benchmark_results = json.loads(output)
                except:
                    self.benchmark_results = {"raw": output}
            else:
                logger.error(f"HumanEval failed:\n{result.stderr}")
        except subprocess.TimeoutExpired:
            logger.error("HumanEval timeout (1h)")
        except Exception as e:
            logger.error(f"HumanEval error: {e}")

    async def update_github_issues(self):
        """Update open GitHub issues with training + benchmark results."""
        logger.info("🔧 Updating GitHub issues with results...")

        github_token = os.environ.get("GITHUB_TOKEN")
        if not github_token:
            logger.warning("GITHUB_TOKEN not set; skipping issue updates")
            return

        try:
            # Get current test matrix issue (#1127)
            # and update it with:
            # 1. Latest training run results
            # 2. HumanEval benchmark scores per provider
            # 3. Convergence confidence metrics

            issue_number = 1127  # Test matrix issue
            summary = {
                "timestamp": datetime.utcnow().isoformat(),
                "run_id": self.run_id,
                "providers_trained": len([j for j in self.dispatched_jobs if not j.get("error")]),
                "benchmark_results": self.benchmark_results,
                "jobs_dispatched": len(self.dispatched_jobs),
            }

            # External Reality Rule (#1188): only post benchmark numbers that were
            # actually measured by the real HumanEval harness. Never post the
            # not_measured / fabricated placeholder as if it were a result.
            measured = bool(self.benchmark_results.get("measured")) if isinstance(self.benchmark_results, dict) else False
            if measured:
                benchmark_section = (
                    "### Benchmark Results (HumanEval — measured)\n"
                    "```json\n" + json.dumps(self.benchmark_results, indent=2) + "\n```"
                )
            else:
                reason = self.benchmark_results.get("reason") if isinstance(self.benchmark_results, dict) else None
                benchmark_section = (
                    "### Benchmark Results (HumanEval)\n"
                    "_Not measured this run — no real benchmark output"
                    + (f" ({reason})" if reason else "")
                    + ". No scores are reported rather than fabricated ones._"
                )

            body = f"""## Weekly Training Update — {datetime.utcnow().strftime('%Y-%m-%d')}

Training run: `{self.run_id}`

### Dispatch Summary
- Providers trained: {summary['providers_trained']}
- Total jobs dispatched: {summary['jobs_dispatched']}

{benchmark_section}

### Provider Coverage
{self._provider_coverage_table()}

Orchestrator: `scripts/weekly-training-orchestrator.py`
"""

            # Post comment via GitHub CLI (shell:false via safe-exec)
            from lantern_garage.lib.safe_exec import safeExec
            safeExec([
                "gh", "issue", "comment", str(issue_number),
                "--repo", "alex-place/lantern-os",
                "--body", body
            ])
            logger.info(f"✓ Updated issue #{issue_number}")
        except Exception as e:
            logger.error(f"Issue update failed: {e}")

    def _provider_coverage_table(self) -> str:
        """Generate markdown table of provider training results."""
        rows = []
        for job in self.dispatched_jobs:
            provider = job.get("provider", "?")
            status = job.get("status", "?")
            steps = job.get("steps", "?")
            error = job.get("error")
            status_badge = "❌" if error else "✓"
            rows.append(f"| {status_badge} | {provider} | {steps} | {status} |")

        if not rows:
            return "No jobs dispatched."

        return (
            "| Status | Provider | Steps | Result |\n"
            "|--------|----------|-------|--------|\n" +
            "\n".join(rows)
        )

    async def run(self):
        """Execute full training + benchmark + update cycle."""
        logger.info(f"🚀 Starting weekly training orchestration: {self.run_id}")

        try:
            # Dispatch to all automatable providers
            await self.dispatch_all()
            if not self.dispatched_jobs:
                logger.error("No jobs dispatched; exiting")
                return

            # Poll until completion (timeout: 24h for safety)
            await self.poll_jobs(timeout_hours=24)

            # Run HumanEval benchmarks on completed checkpoint
            await self.run_humaneval_benchmarks()

            # Update GitHub issues with results
            await self.update_github_issues()

            logger.info(f"✓ Training cycle complete: {self.run_id}")
        except Exception as e:
            logger.error(f"❌ Training cycle failed: {e}", exc_info=True)
            sys.exit(1)


async def main():
    orchestrator = WeeklyTrainingOrchestrator()
    await orchestrator.run()


if __name__ == "__main__":
    asyncio.run(main())
