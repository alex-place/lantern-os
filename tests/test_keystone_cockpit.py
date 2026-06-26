"""Tests for the Keystone personal cockpit — the human-in-the-loop spine.

Uses the design's own examples: a CareSource job application and a dentist booking.
See src/keystone/cockpit.py.
"""
from src.keystone import Cockpit, Profile, TaskSpec


JOB = TaskSpec(
    name="CareSource job application",
    needs=["caresource_role", "insurance_plan", "resume_summary"],
    prompts={
        "caresource_role": "Which CareSource role are you applying for?",
        "insurance_plan": "What insurance plan should I reference?",
        "resume_summary": "Which resume should I use?",
    },
)

DENTIST = TaskSpec(
    name="Book dentist appointment",
    needs=["dentist_patient", "preferred_dentist"],
    prompts={"dentist_patient": "Who needs the dentist appointment?"},
)


# ── 1. the smallest useful question, one at a time, in priority order ─────────

def test_surfaces_the_smallest_useful_question():
    c = Cockpit(Profile())
    q = c.next_question(JOB)
    assert q.key == "caresource_role"
    assert q.prompt == "Which CareSource role are you applying for?"   # the design's example

    c.answer("caresource_role", "Care Coordinator", approve=True)
    assert c.next_question(JOB).key == "insurance_plan"               # advanced to the next gap

    # a task with no prompt template still produces a sensible question
    assert c.next_question(DENTIST).prompt == "Who needs the dentist appointment?"


def test_task_ready_when_all_facts_known():
    c = Cockpit(Profile())
    for k, v in [("caresource_role", "Care Coordinator"),
                 ("insurance_plan", "Anthem PPO"), ("resume_summary", "2026 resume")]:
        c.answer(k, v, approve=True)
    assert c.next_question(JOB) is None
    assert c.ready(JOB) is True


# ── 2. save ONLY on approval (proposals are held, not trusted) ────────────────

def test_saves_only_on_approval():
    c = Cockpit(Profile())
    # Keystone gathered a value from a file but you haven't approved it → held, not durable
    c.answer("insurance_plan", "Anthem PPO", source="resume.pdf", approve=False)
    assert c.profile.known("insurance_plan") is None                 # not trusted as truth
    assert c.profile.get("insurance_plan").approved is False
    assert c.profile.get("insurance_plan").confidence <= 0.7         # proposals are capped
    # …so it is STILL surfaced as an open question until you approve it
    c.answer("caresource_role", "Care Coordinator", approve=True)
    c.answer("resume_summary", "2026 resume", approve=True)
    assert c.next_question(JOB).key == "insurance_plan"
    # approve → now durable, task ready
    c.profile.approve("insurance_plan")
    assert c.profile.known("insurance_plan").value == "Anthem PPO"
    assert c.next_question(JOB) is None


def test_facts_are_editable():
    c = Cockpit(Profile())
    c.answer("caresource_role", "Care Coordinator", approve=True)
    c.profile.edit("caresource_role", "Senior Care Coordinator")
    assert c.profile.known("caresource_role").value == "Senior Care Coordinator"


# ── 3. the action gate: nothing mutating runs without approval ────────────────

def test_action_gate_holds_mutations_until_approved():
    c = Cockpit(Profile())
    submit = c.propose_action("submit", "Submit CareSource application for Care Coordinator",
                              {"role": "Care Coordinator"})
    assert submit.needs_approval and not submit.approved and not submit.executable
    assert c.pending_actions() == [submit]                            # held for you

    # read/lookup actions are shown but need no approval
    read = c.propose_action("read", "Search local files for your latest resume")
    assert not read.needs_approval and read.executable
    assert read not in c.pending_actions()

    # approving the mutating action makes it executable
    c.approve_action(submit.id)
    assert submit.executable and submit.approved
    assert c.pending_actions() == []


def test_all_mutating_kinds_need_approval():
    c = Cockpit(Profile())
    for kind in ["send", "schedule", "submit", "spend", "change_records"]:
        a = c.propose_action(kind, f"{kind} something")
        assert a.needs_approval and not a.executable, kind
    for kind in ["read", "draft", "plan", "lookup"]:
        a = c.propose_action(kind, f"{kind} something")
        assert not a.needs_approval and a.executable, kind


# ── 4. the transparency surface: shows what it found + what it plans ──────────

def test_plan_shows_evidence_question_and_pending_actions():
    c = Cockpit(Profile())
    c.answer("caresource_role", "Care Coordinator", approve=True)
    c.propose_action("submit", "Submit CareSource application")
    pl = c.plan(JOB)
    assert pl["evidence"]["caresource_role"] == "Care Coordinator"    # what it found
    assert pl["open_question"]["key"] == "insurance_plan"             # smallest useful question
    assert pl["ready"] is False
    assert any(a["kind"] == "submit" for a in pl["pending_actions"])  # what it plans (held)


# ── 5. durable but editable across restarts ──────────────────────────────────

def test_profile_persists_and_keeps_approval_state(tmp_path):
    path = str(tmp_path / "profile.jsonl")
    c = Cockpit(Profile(path=path))
    c.answer("caresource_role", "Care Coordinator", approve=True)     # durable
    c.answer("insurance_plan", "Anthem PPO", source="x", approve=False)  # proposal
    c.profile.edit("caresource_role", "Senior Care Coordinator")      # edit

    reloaded = Profile(path=path)
    assert reloaded.known("caresource_role").value == "Senior Care Coordinator"  # durable + edited
    assert reloaded.known("insurance_plan") is None                  # proposal did NOT become durable
    assert reloaded.get("insurance_plan").approved is False
