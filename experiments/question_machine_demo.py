"""The Question Machine, end to end — run it and watch it ask.

Builds a small CIO_SDE, consolidates the forward (predict) and backward (adjoint) passes
toward a goal, and shows:

  1. the seam ‖∂H/∂u‖ descending as forward and backward agree (finding the safe passage);
  2. at the consolidated optimum the questions go quiet (coherent — and the honest danger:
     coherent ≠ correct);
  3. an EXTERNAL anchor that contradicts the coherent trajectory reopening the question
     (grounding revives it);
  4. CAP/NAP gating — the top question routed around a NAP denial even though CAP allows it.

Run: python experiments/question_machine_demo.py
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import torch  # noqa: E402

from src.cio_sde import CIO_SDE, LinearDynamics, QuestionMachine  # noqa: E402
from src.convergence_io import (  # noqa: E402
    CapabilityGate, CapabilityClaim, AuthorityGate, NegativeAuthorityProfile,
)


def banner(t: str) -> None:
    print(f"\n{'─' * 70}\n{t}\n{'─' * 70}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    torch.manual_seed(7)

    # A small stable 3-state system; controls are the 3 "channels" the machine can probe.
    A = torch.tensor([[-0.4, 0.3, 0.0], [-0.2, -0.5, 0.2], [0.1, -0.1, -0.6]])
    node = LinearDynamics(A, B=torch.eye(3))
    m = CIO_SDE(dim=3, ctrl_dim=3, hidden=4)
    m.graph.active = node
    dt, T = 0.1, 10
    x0 = torch.tensor([[1.0, -0.8, 0.5]])
    goal = torch.zeros(1, 3)

    channels = {0: "ask_human", 1: "web_search", 2: "market_probe"}
    qm = QuestionMachine(channels=channels)
    us0 = [torch.zeros(1, 3) for _ in range(T)]

    banner("1. CONSOLIDATE — forward predict ⇄ backward adjoint, drive the seam → 0")
    res = qm.consolidate(m, x0, us0, dt, terminal_grad=lambda xT: 2 * (xT - goal),
                         iterations=400, lr=0.05)
    h = res.max_score_history
    print(f"  seam ‖∂H/∂u‖ (max over steps):  start {h[0]:.4f}  →  end {h[-1]:.5f}  "
          f"({h[0] / max(h[-1], 1e-9):.0f}× smaller, {res.iterations} iters)")
    print(f"  → the safe passage: forward and backward now agree. Questions are quiet.")

    banner("2. ASK at the coherent optimum — the honest danger (coherent ≠ correct)")
    qs = qm.ask(res, top_k=3)
    if not qs or qs[0].score < 1e-3:
        print("  top question score ≈ 0 — the machine has nothing left to ask ITSELF.")
        print("  This is exactly the 42-state risk: internally coherent, possibly dead-wrong.")
    for q in qs:
        print(f"    · {q.hypothesis}")

    banner("3. GROUND IT — an external anchor says the goal was elsewhere")
    goal_real = torch.tensor([[1.5, -1.5, 1.0]])      # reality disagrees with the coherent path
    res_g = qm.consolidate(m, x0, res.us, dt, terminal_grad=lambda xT: 2 * (xT - goal_real),
                           iterations=0)
    print(f"  seam reopened:  {res.max_score:.5f}  →  {res_g.max_score:.4f}  "
          f"({res_g.max_score / max(res.max_score, 1e-9):.0f}× larger)")
    print("  grounding revived the question — the machine has something real to resolve again.")

    banner("4. CAP + NAP — ask only what you're ABLE and ALLOWED to ask")
    cap = CapabilityGate(honesty_floor=0.0)
    cap.register_claim(CapabilityClaim(agent_id="question-machine", provider_id="local",
                                       capabilities={"ask_human", "web_search", "market_probe"},
                                       boundary="local"))
    nap = AuthorityGate()
    qm_g = QuestionMachine(capability_gate=cap, authority_gate=nap, channels=channels)

    top = qm_g.ask(res_g, top_k=1)[0]
    print(f"  top admissible question → channel '{top.channel}' (score {top.score:.4f})")
    print(f"  NAP now DENIES '{top.channel}' (a hard floor — e.g. financial/PII boundary)…")
    nap.add_profile(NegativeAuthorityProfile(profile_id="floor",
                                             denied_actions={top.channel},
                                             reason="hard authority boundary"))
    top2 = qm_g.ask(res_g, top_k=1)[0]
    print(f"  …re-asked: top admissible question → channel '{top2.channel}' (score {top2.score:.4f})")
    print(f"  NAP overrode CAP: capable of '{top.channel}' "
          f"({cap.check('question-machine', {top.channel}).allowed}) but denied → routed around it.")

    print("\nThe Question Machine: it consolidates both passes, goes quiet when coherent,")
    print("reopens on grounding, and only ever asks what it is able AND allowed to ask.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
