"""
Keystone personal cockpit — the human-in-the-loop spine.

    You ask Keystone
    → it identifies the task and the evidence it needs
    → it gathers from local files / web / email / calendar / MCP / an approved model
    → it shows what it found and what it plans to do
    → you approve anything that SENDS, SCHEDULES, SUBMITS, SPENDS, or CHANGES records.

Two gates, both human-in-the-loop:

  • **Profile** — a durable but EDITABLE store of personal facts (resume facts, family
    scheduling preferences, insurance details, preferred doctors/dentists, active
    applications). A fact is **approved** (durable, trusted) or **proposed** (held until you
    approve). The Question Machine surfaces the **smallest useful question** for a task —
    one missing fact at a time, highest-priority first — and the answer is saved as durable
    **only when you approve** it.

  • **ActionGate** — nothing that sends/schedules/submits/spends/changes records executes
    without showing you the final action first. Read/lookup/draft actions are shown but need
    no approval; mutating actions are *held* until you approve.

This is the [Question Machine](../../docs/research/question-machine.md) principle —
*ask the highest-leverage admissible question* — applied to personal facts, with the
*denial overrides capability* discipline applied to actions (an action is held unless
explicitly approved).
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

# The action kinds that must be approved before they execute (your list).
ACTIONS_NEEDING_APPROVAL = frozenset({"send", "schedule", "submit", "spend", "change_records"})


# ── facts ─────────────────────────────────────────────────────────────────────

@dataclass
class Fact:
    """One personal fact. Durable iff `approved`; otherwise it's a held proposal."""
    key: str
    value: Optional[str] = None
    confidence: float = 0.0
    source: str = "unknown"
    approved: bool = False
    updated: str = ""

    def is_known(self, min_confidence: float) -> bool:
        return self.approved and self.value not in (None, "") and self.confidence >= min_confidence


@dataclass
class Question:
    """The smallest useful question — one missing fact, with why it's needed."""
    key: str
    prompt: str
    why: str

    def to_dict(self) -> Dict[str, str]:
        return {"key": self.key, "prompt": self.prompt, "why": self.why}


@dataclass
class TaskSpec:
    """A task and the facts it needs to proceed (in priority order)."""
    name: str
    needs: List[str]
    prompts: Dict[str, str] = field(default_factory=dict)
    reasons: Dict[str, str] = field(default_factory=dict)


@dataclass
class PendingAction:
    """An action Keystone wants to take. Mutating kinds are held until approved."""
    id: int
    kind: str
    summary: str                 # the FINAL action, shown to the user before it runs
    payload: dict = field(default_factory=dict)
    needs_approval: bool = True
    approved: bool = False

    @property
    def executable(self) -> bool:
        return self.approved or not self.needs_approval


# ── the profile (durable but editable) ──────────────────────────────────────────

class Profile:
    """Durable-but-editable personal facts. Proposals are held until approved; edits are an
    append (last value wins on load) so history is never destroyed — the convergence rule."""

    def __init__(self, path: Optional[str] = None, min_confidence: float = 0.5) -> None:
        self.path = path
        self.min_confidence = min_confidence
        self._facts: Dict[str, Fact] = {}
        if path and os.path.exists(path):
            self._load()

    # -- reads --
    def known(self, key: str) -> Optional[Fact]:
        """An approved, confident fact — the only kind the cockpit treats as durable truth."""
        f = self._facts.get(key)
        return f if (f and f.is_known(self.min_confidence)) else None

    def get(self, key: str) -> Optional[Fact]:
        """Any fact, including a held proposal."""
        return self._facts.get(key)

    def facts(self) -> List[Fact]:
        return list(self._facts.values())

    # -- writes (the human-in-the-loop) --
    def propose(self, key: str, value: str, source: str = "keystone",
                confidence: float = 0.6) -> Fact:
        """Hold a fact Keystone gathered/inferred. NOT durable until you approve it."""
        f = Fact(key=key, value=value, confidence=min(confidence, 0.7), source=source,
                 approved=False, updated=_now())
        self._facts[key] = f
        self._append(f)
        return f

    def approve(self, key: str, value: Optional[str] = None,
                confidence: float = 0.95) -> Fact:
        """Promote a proposal to durable truth — the save only happens on approval. You may
        correct the value at approval time (editable)."""
        f = self._facts.get(key) or Fact(key=key)
        if value is not None:
            f.value = value
        f.approved = True
        f.confidence = max(f.confidence, confidence)
        f.source = f.source if f.source != "unknown" else "user"
        f.updated = _now()
        self._facts[key] = f
        self._append(f)
        return f

    def edit(self, key: str, value: str) -> Fact:
        """Edit a durable fact (stays approved). Append-only under the hood."""
        return self.approve(key, value=value)

    def forget(self, key: str) -> None:
        self._facts.pop(key, None)
        self._append(Fact(key=key, value=None, approved=False, source="forgotten", updated=_now()))

    # -- persistence (append-only JSONL; last value per key wins on load) --
    def _append(self, f: Fact) -> None:
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(f), ensure_ascii=False) + "\n")

    def _load(self) -> None:
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                    if d.get("value") is None and d.get("source") == "forgotten":
                        self._facts.pop(d["key"], None)
                    else:
                        self._facts[d["key"]] = Fact(**d)
                except Exception:
                    continue


# ── the cockpit (questions + action gate) ───────────────────────────────────────

class Cockpit:
    """Surfaces the smallest useful question for a task and gates mutating actions."""

    def __init__(self, profile: Profile) -> None:
        self.profile = profile
        self._actions: List[PendingAction] = []
        self._action_seq = 0

    # -- the Question Machine, applied to personal facts --
    def missing(self, task: TaskSpec) -> List[str]:
        """Required facts the task needs that aren't yet known (approved + confident)."""
        return [k for k in task.needs if self.profile.known(k) is None]

    def next_question(self, task: TaskSpec) -> Optional[Question]:
        """The SMALLEST useful question — the single highest-priority missing fact. One at a
        time, in the task's declared priority order. None when the task has what it needs."""
        for key in task.needs:                                   # declared order = priority
            if self.profile.known(key) is None:
                return Question(
                    key=key,
                    prompt=task.prompts.get(key, f"What is your {key.replace('_', ' ')}?"),
                    why=task.reasons.get(key, f"needed for: {task.name}"),
                )
        return None

    def answer(self, key: str, value: str, source: str = "user", approve: bool = True) -> Fact:
        """Record an answer. Saved as durable ONLY when approve=True (your approval); otherwise
        held as a proposal."""
        if approve:
            return self.profile.approve(key, value=value)
        return self.profile.propose(key, value, source=source)

    def ready(self, task: TaskSpec) -> bool:
        return not self.missing(task)

    # -- the action gate --
    def propose_action(self, kind: str, summary: str, payload: Optional[dict] = None) -> PendingAction:
        """Stage an action. Mutating kinds (send/schedule/submit/spend/change_records) are
        HELD until approved; everything else is shown but executable."""
        self._action_seq += 1
        a = PendingAction(id=self._action_seq, kind=kind, summary=summary,
                          payload=payload or {}, needs_approval=kind in ACTIONS_NEEDING_APPROVAL,
                          approved=False)
        self._actions.append(a)
        return a

    def approve_action(self, action_id: int) -> PendingAction:
        a = next(x for x in self._actions if x.id == action_id)
        a.approved = True
        return a

    def pending_actions(self) -> List[PendingAction]:
        """Actions still awaiting your approval before they can run."""
        return [a for a in self._actions if a.needs_approval and not a.approved]

    # -- the transparency surface: "shows what it found and what it plans to do" --
    def plan(self, task: TaskSpec) -> Dict[str, object]:
        evidence = {f.key: f.value for f in self.profile.facts()
                    if self.profile.known(f.key) is not None}
        q = self.next_question(task)
        return {
            "task": task.name,
            "evidence": evidence,                                # what it found (durable facts)
            "open_question": q.to_dict() if q else None,         # the smallest useful question
            "ready": self.ready(task),
            "pending_actions": [                                 # what it plans — held for approval
                {"id": a.id, "kind": a.kind, "summary": a.summary, "needs_approval": a.needs_approval}
                for a in self._actions if not a.approved
            ],
        }


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
