"""
Σ₀ Coder Gate — verification contract for the Keystone coding agent.

Issue #628: the local coder (Ollama / qwen2.5-coder) inherited Dream Chat persona
tone from the single shared system-prompt builder in unified_agent_connector.py,
so its output read like RP narration ("end with one question or invitation to
record") instead of evidence-grounded code. Keystone is being updated from the
"truth integrator" persona into the system's coding agent, and it needs a
verification contract that is SEPARATE from the dream/RP surface.

This module supplies three things and nothing else (reject sprawl):

  1. KEYSTONE_CODER_PROMPT — a code-verification persona prompt with no dream tone.
  2. build_pre_generation_gate() — caps confidence when no grounding evidence is
     supplied. This mirrors LANTERN-DREAM's `max_confidence = 0.3 until verified`
     rule, inverted: the coder must EARN confidence with evidence, never assume it.
  3. check_coder_output() — a structural checker that refuses to promote coder
     output into a ConvergenceRecord unless it carries the five required fields:
     Claim, Evidence, Confidence, Source, Verification.

Reference: docs/CONVERGANCE-SIGMA0-BRIEFING.md
           [06] LANTERN-CODER  — "Coder = a task type, not a separate system."
           [07] LANTERN-VERIFY — "Every claim must have: claim, evidence, confidence, source."
           [08] LANTERN-DREAM  — "confidence = max 0.3 until verified."
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# The five fields every promotable coder output must carry. Order matters only
# for display; the checker matches them case-insensitively, anywhere.
REQUIRED_SECTIONS: Tuple[str, ...] = ("Claim", "Evidence", "Confidence", "Source", "Verification")

# When the coder is asked to produce output with NO grounding evidence (no files
# read, no tests run, no docs cited), its pre-generation confidence is capped here.
# Same ceiling LANTERN-DREAM uses for unverified exploration.
UNGROUNDED_CONFIDENCE_CAP: float = 0.3

# Verification contract injected as the coder's system identity. Deliberately free
# of dream/persona tone — no "end with a question", no symbolic lore.
KEYSTONE_CODER_PROMPT: str = (
    "You are Keystone, the coding agent of Lantern OS. You are not a chat persona and "
    "you do not perform. You produce code and code reasoning grounded in external reality.\n\n"
    "RULES (non-negotiable):\n"
    "1. Nothing is asserted without evidence. Every claim you make about the codebase, a "
    "library, or an output must point to something checkable — a file you read, a test you "
    "ran, an error message, or cited documentation.\n"
    "2. You never invent file paths, APIs, function names, or flags. If you have not seen it, "
    "say you have not seen it.\n"
    "3. Verification is mandatory. Before presenting code as working, state how it would be "
    "verified (the test, the command, the expected output).\n"
    "4. Confidence is earned, not assumed. Report a confidence in [0,1]. If you have no "
    "grounding evidence, your confidence must be 0.3 or lower.\n\n"
    "OUTPUT CONTRACT — every substantive response ends with these five labeled lines:\n"
    "Claim: <the single thing you are asserting>\n"
    "Evidence: <what makes it checkable: file:line, test name, command output, doc URL>\n"
    "Confidence: <a number in [0,1]>\n"
    "Source: <where this came from: codebase | test-run | docs | reasoning>\n"
    "Verification: <the exact step that would confirm or refute the claim>"
)


@dataclass
class CoderGate:
    """Pre-generation gate handed to the coder dispatch path before the LLM call.

    Carries the verification-contract system prompt and the confidence ceiling
    that applies given the grounding evidence available at call time.
    """
    system_prompt: str
    max_confidence: float
    grounded: bool
    evidence_ids: List[str] = field(default_factory=list)

    def build_system(self, base_prompt: Optional[str] = None) -> str:
        """Compose the system surface for the coder call.

        `base_prompt` lets a caller prepend repo/task context. The contract and the
        active confidence ceiling are always appended so the model sees the cap.
        """
        parts: List[str] = []
        if base_prompt:
            parts.append(base_prompt.strip())
        parts.append(self.system_prompt)
        if self.grounded and self.evidence_ids:
            parts.append("Grounding evidence available: " + ", ".join(self.evidence_ids))
        else:
            parts.append(
                "No grounding evidence supplied. Treat this as exploratory: your reported "
                f"Confidence must not exceed {self.max_confidence:.1f}."
            )
        return "\n\n".join(parts)


@dataclass
class GateCheck:
    """Result of the post-generation structural check on coder output."""
    passed: bool
    missing: List[str]
    sections: Dict[str, str]
    confidence: float
    reason: str

    def to_convergence_fields(self, hypothesis: str, reasoner: str = "keystone:ollama") -> Optional[Dict]:
        """Project a passing check into ConvergenceRecord-shaped fields.

        Returns None when the check did not pass — ungrounded/unstructured coder
        output is never promoted into the convergence log. Caller supplies id/timestamp.
        """
        if not self.passed:
            return None
        return {
            "hypothesis": hypothesis,
            "evidence_ids": [self.sections.get("Evidence", "")] if self.sections.get("Evidence") else [],
            "result": self.sections.get("Claim", ""),
            "confidence": self.confidence,
            "reasoner": reasoner,
            "verified": False,
            "verification_notes": self.sections.get("Verification") or None,
        }


def build_pre_generation_gate(
    grounding_evidence: Optional[List[str]] = None,
    base_prompt: Optional[str] = None,
) -> CoderGate:
    """Construct the gate that wraps a coder dispatch.

    grounding_evidence: ids/labels of memories, files, or test runs that ground the
        request. When empty/None the call is treated as ungrounded and the confidence
        ceiling drops to UNGROUNDED_CONFIDENCE_CAP.
    base_prompt: optional repo/task context prepended ahead of the contract.
    """
    evidence = [e for e in (grounding_evidence or []) if e and str(e).strip()]
    grounded = len(evidence) > 0
    gate = CoderGate(
        system_prompt=KEYSTONE_CODER_PROMPT,
        max_confidence=1.0 if grounded else UNGROUNDED_CONFIDENCE_CAP,
        grounded=grounded,
        evidence_ids=evidence,
    )
    # Fold any base_prompt + the active confidence ceiling into the system surface
    # the caller will actually send to the model.
    gate.system_prompt = gate.build_system(base_prompt)
    return gate


def _extract_section(text: str, label: str) -> Optional[str]:
    """Return the non-empty content following a `Label:` marker, else None.

    Matches at a line start, case-insensitively, and captures the remainder of that
    line. Tolerates markdown emphasis around the label (e.g. **Claim:**).
    """
    pattern = re.compile(
        r"^[ \t>*_#-]*" + re.escape(label) + r"[ \t]*:?\**[ \t]*(.+?)[ \t]*$",
        re.IGNORECASE | re.MULTILINE,
    )
    m = pattern.search(text)
    if not m:
        return None
    value = m.group(1).strip().strip("*_`").strip()
    return value or None


def _parse_confidence(raw: Optional[str]) -> Optional[float]:
    """Parse a confidence value from the Confidence line.

    Accepts `0.8`, `.8`, `80%`, `0.8 (high)`. Returns a float in [0,1] or None.
    """
    if not raw:
        return None
    pct = re.search(r"(\d+(?:\.\d+)?)\s*%", raw)
    if pct:
        return max(0.0, min(1.0, float(pct.group(1)) / 100.0))
    num = re.search(r"(\d+(?:\.\d+)?)", raw)
    if not num:
        return None
    val = float(num.group(1))
    if val > 1.0:  # e.g. "8 out of 10" style — treat >1 as a percentage-ish slip
        val = val / 100.0 if val > 10 else val / 10.0
    return max(0.0, min(1.0, val))


def check_coder_output(text: str, grounded: bool = False) -> GateCheck:
    """Structurally validate coder output before it can become a ConvergenceRecord.

    Passing requires all five REQUIRED_SECTIONS present with non-empty content.
    The reported confidence is clamped to UNGROUNDED_CONFIDENCE_CAP when `grounded`
    is False, regardless of what the model claimed — the gate, not the model, owns
    the ceiling for ungrounded work.
    """
    text = text or ""
    sections: Dict[str, str] = {}
    missing: List[str] = [] # noqa: F841
    for label in REQUIRED_SECTIONS:
        value = _extract_section(text, label)
        if value is None:
            missing.append(label)
        else:
            sections[label] = value

    claimed = _parse_confidence(sections.get("Confidence"))
    if claimed is None:
        # Missing/unparseable confidence is itself a structural failure.
        if "Confidence" not in missing:
            missing.append("Confidence")
        confidence = 0.0
    else:
        confidence = claimed
    if not grounded:
        confidence = min(confidence, UNGROUNDED_CONFIDENCE_CAP)

    passed = len(missing) == 0
    if passed:
        reason = "all required fields present" + ("" if grounded else "; ungrounded, confidence capped")
    else:
        reason = "missing required fields: " + ", ".join(missing)

    return GateCheck(
        passed=passed,
        missing=missing,
        sections=sections,
        confidence=confidence,
        reason=reason,
    )
