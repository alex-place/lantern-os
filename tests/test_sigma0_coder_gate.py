"""Tests for the Σ₀ coder gate (issue #628).

The gate gives unisona.ai-the-coder a verification contract separate from the dream
personas, caps confidence when ungrounded, and refuses to promote unstructured
output into a ConvergenceRecord. These tests need no running Ollama.
"""

from src.sigma0_coder_gate import (
    KEYSTONE_CODER_PROMPT,
    REQUIRED_SECTIONS,
    UNGROUNDED_CONFIDENCE_CAP,
    build_pre_generation_gate,
    check_coder_output,
)


# A well-formed coder response carrying all five required fields.
GOOD_OUTPUT = """\
Here's the fix for the timeout bug.

```python
socket.setdefaulttimeout(10)
```

Claim: setting a default socket timeout prevents the connector hanging on dead providers
Evidence: src/unified_agent_connector.py:22 already does this; reproduced the hang without it
Confidence: 0.85
Source: codebase
Verification: run check_health() against an unreachable host and confirm it returns within 10s
"""

UNGROUNDED_BUT_STRUCTURED = """\
Claim: the rate limiter should use a token bucket
Evidence: none — general reasoning only
Confidence: 0.9
Source: reasoning
Verification: add a unit test asserting burst behavior
"""

DREAM_TONE_OUTPUT = (
    "The flame holds steady. Your code wants to come home safe. "
    "What light did you bring back? Shall we open that door together?"
)


# --- pre-generation gate ------------------------------------------------------

def test_gate_caps_confidence_when_ungrounded():
    gate = build_pre_generation_gate(grounding_evidence=None)
    assert gate.grounded is False
    assert gate.max_confidence == UNGROUNDED_CONFIDENCE_CAP
    assert "0.3" in gate.system_prompt  # the cap is shown to the model


def test_gate_unlocks_confidence_when_grounded():
    gate = build_pre_generation_gate(grounding_evidence=["src/foo.py:10", "test_foo passes"])
    assert gate.grounded is True
    assert gate.max_confidence == 1.0
    assert "src/foo.py:10" in gate.system_prompt


def test_gate_ignores_blank_evidence():
    gate = build_pre_generation_gate(grounding_evidence=["", "   ", None])
    assert gate.grounded is False
    assert gate.max_confidence == UNGROUNDED_CONFIDENCE_CAP


def test_gate_prompt_has_no_dream_tone():
    gate = build_pre_generation_gate()
    lowered = gate.system_prompt.lower()
    for banned in ("dream", "lantern flame", "come home safe", "invitation to record"):
        assert banned not in lowered
    assert "Claim:" in gate.system_prompt and "Verification:" in gate.system_prompt


# --- post-generation structural check -----------------------------------------

def test_check_passes_on_complete_output():
    result = check_coder_output(GOOD_OUTPUT, grounded=True)
    assert result.passed is True
    assert result.missing == []
    assert result.confidence == 0.85
    assert "socket timeout" in result.sections["Claim"]


def test_check_fails_on_dream_tone():
    result = check_coder_output(DREAM_TONE_OUTPUT, grounded=False)
    assert result.passed is False
    # all five fields absent
    assert set(result.missing) == set(REQUIRED_SECTIONS)


def test_ungrounded_confidence_is_clamped_even_if_model_claims_high():
    result = check_coder_output(UNGROUNDED_BUT_STRUCTURED, grounded=False)
    assert result.passed is True  # structurally complete
    assert result.confidence == UNGROUNDED_CONFIDENCE_CAP  # 0.9 claimed -> capped to 0.3


def test_percentage_confidence_is_parsed():
    text = GOOD_OUTPUT.replace("Confidence: 0.85", "Confidence: 85%")
    result = check_coder_output(text, grounded=True)
    assert result.confidence == 0.85


def test_markdown_emphasis_labels_are_tolerated():
    text = GOOD_OUTPUT.replace("Claim:", "**Claim:**").replace("Evidence:", "**Evidence:**")
    result = check_coder_output(text, grounded=True)
    assert result.passed is True


def test_missing_confidence_is_a_failure():
    text = "\n".join(
        line for line in GOOD_OUTPUT.splitlines() if not line.startswith("Confidence:")
    )
    result = check_coder_output(text, grounded=True)
    assert result.passed is False
    assert "Confidence" in result.missing


# --- promotion to convergence record ------------------------------------------

def test_passing_check_projects_to_convergence_fields():
    result = check_coder_output(GOOD_OUTPUT, grounded=True)
    fields = result.to_convergence_fields(hypothesis="fix connector timeout", reasoner="keystone:ollama")
    assert fields is not None
    assert fields["result"].startswith("setting a default socket timeout")
    assert fields["confidence"] == 0.85
    assert fields["verified"] is False
    assert fields["verification_notes"]
    assert len(fields["evidence_ids"]) == 1


def test_failing_check_is_never_promoted():
    result = check_coder_output(DREAM_TONE_OUTPUT, grounded=False)
    assert result.to_convergence_fields(hypothesis="anything") is None


# --- identity contract --------------------------------------------------------

def test_keystone_coder_prompt_declares_the_five_fields():
    for field_name in REQUIRED_SECTIONS:
        assert field_name in KEYSTONE_CODER_PROMPT
