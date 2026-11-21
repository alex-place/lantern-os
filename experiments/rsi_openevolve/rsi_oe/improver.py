"""The improver: what the slow loop edits, and the two ways it gets edited.

Arms 2 and 3 use MetaSkill-Evolve's improver genome m = (psi, sigma, alpha, pi, epsilon)
(arXiv:2607.05297 §3.2): five text components, one per pipeline agent, plus the few
numbers those agents control (sigma: how many context programs; alpha: children per
parent step, temperature, exploration/exploitation ratios). `meta_update` is the slow
loop: Analyzer -> Retriever -> Allocator -> Proposer -> Evolver, each agent instructed by
the improver's own component, so the improver edits itself (four LLM calls; retrieval is
a lookup). MetaSkill-Evolve rewrites all five files per round with K_m meta-children; here
one target component per round, K_m = 1, to keep compute equal to arm 1.

Arm 1 uses AlphaEvolve's meta-prompt evolution (arXiv:2506.13131 §2): instruction texts
co-evolve in their own database, each scored by the improvement its children earned on
the arm's evaluator, and one LLM call per generation writes a new variant. OpenEvolve
v0.4.0 declares `use_meta_prompting` but does not implement it (config.py), so it is
built here.

Every component is bounded (length, numeric ranges). None of them can reach the
evaluator, the gate, its thresholds, or the logs: they are prompt text and a few clipped
numbers, nothing else.
"""
from __future__ import annotations

import json
import math
import re
import uuid
from dataclasses import asdict, dataclass, field, replace
from typing import Dict, List, Optional, Tuple

TEXT_LIMIT = 1500
COMPONENTS = ("analysis", "retrieval", "allocation", "proposer", "editor")
BOUNDS = {
    "num_top": (1, 5), "num_diverse": (0, 4), "k_base": (1, 3), "k_widen": (0, 2),
    "temperature": (0.2, 1.2), "exploration": (0.0, 0.5), "exploitation": (0.3, 0.9),
}
K_MAX = 3

PREDICTION_REQUEST = (
    "After your SEARCH/REPLACE blocks, end your reply with exactly one line of the form\n"
    "PREDICTED_DELTA: <number>\n"
    "giving your best estimate of how much this change will change the fitness score "
    "(same units as the fitness score; negative if you expect it to get worse)."
)

SEED_TEXT = {
    "proposer": (
        "You are an expert in combinatorial optimization and Python. You improve a heuristic "
        "for online bin packing: items arrive one at a time and each must be placed at once "
        "into a bin of capacity 150. The FITNESS SCORE is the percentage of bins saved "
        "compared with the best-fit heuristic (0 means the same as best fit; higher is "
        "better). Propose a change that you expect to use fewer bins on unseen instances."
    ),
    "analysis": (
        "Before proposing a change, look at the per-family scores (small, medium, large instances) "
        "of the current program and of the other programs shown. Find the family where the "
        "current program does worst and form a hypothesis about why it wastes space there."
    ),
    "retrieval": (
        "Use the top and diverse programs as inspiration. Combine ideas that scored well "
        "rather than copying a program verbatim."
    ),
    "allocation": (
        "Widen the search (more children per parent, higher temperature) when recent "
        "generations stagnate; narrow it after a productive generation."
    ),
    "editor": (
        "Make one focused change in the SEARCH/REPLACE format. Keep the signature "
        "priority(item, bins) and return a numpy array with the same shape as bins. Use only "
        "numpy and math. Keep the function fast (it runs once per item) and under 80 lines."
    ),
}


def _clip(name: str, value) -> float:
    lo, hi = BOUNDS[name]
    try:
        v = float(value)
    except (TypeError, ValueError):
        return lo
    if not math.isfinite(v):
        return lo
    return min(hi, max(lo, v))


@dataclass
class Improver:
    vid: str
    parent: Optional[str]
    gen: int
    analysis: str
    retrieval: str
    allocation: str
    proposer: str
    editor: str
    num_top: int = 3
    num_diverse: int = 2
    k_base: int = 2
    k_widen: int = 1
    temperature: float = 0.7
    exploration: float = 0.2
    exploitation: float = 0.7
    origin: str = "seed"
    tags: List[str] = field(default_factory=list)

    def clipped(self) -> "Improver":
        d = asdict(self)
        for c in COMPONENTS:
            d[c] = (d[c] or "").strip()[:TEXT_LIMIT] or SEED_TEXT[c]
        for k in ("num_top", "num_diverse", "k_base", "k_widen"):
            d[k] = int(round(_clip(k, d[k])))
        for k in ("temperature", "exploration", "exploitation"):
            d[k] = round(_clip(k, d[k]), 3)
        if d["exploration"] + d["exploitation"] > 1.0:
            d["exploitation"] = round(1.0 - d["exploration"], 3)
        return Improver(**d)

    def system_message(self) -> str:
        return assemble_system(self.proposer, self.analysis, self.retrieval, self.editor)

    def k_for_step(self, stagnating: bool) -> int:
        return int(min(K_MAX, self.k_base + (self.k_widen if stagnating else 0)))

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Improver":
        return cls(**d)


def assemble_system(proposer: str, analysis: str, retrieval: str, editor: str) -> str:
    return (f"{proposer}\n\n## Analysis\n{analysis}\n\n## Using the example programs\n"
            f"{retrieval}\n\n## Editing rules\n{editor}")


def seed_improver() -> Improver:
    return Improver(vid="v0", parent=None, gen=0, **SEED_TEXT)


_PRED = re.compile(r"PREDICTED_DELTA\s*[:=]\s*\**\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)")


def parse_prediction(text: Optional[str]) -> Optional[float]:
    if not text:
        return None
    m = _PRED.findall(text)
    if not m:
        return None
    try:
        v = float(m[-1])
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _json_block(text: Optional[str]) -> Optional[dict]:
    if not text:
        return None
    for m in re.finditer(r"\{.*?\}", text, re.DOTALL):
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    return None


def _tagged(text: Optional[str], tag: str) -> Optional[str]:
    if not text:
        return None
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else None


def describe(imp: Improver) -> str:
    return (
        f"[analysis]\n{imp.analysis}\n\n"
        f"[retrieval] num_top={imp.num_top} num_diverse={imp.num_diverse}\n{imp.retrieval}\n\n"
        f"[allocation] k_base={imp.k_base} k_widen={imp.k_widen} temperature={imp.temperature} "
        f"exploration={imp.exploration} exploitation={imp.exploitation}\n{imp.allocation}\n\n"
        f"[proposer]\n{imp.proposer}\n\n[editor]\n{imp.editor}"
    )


def format_trace(rows: List[dict]) -> str:
    """The meta-failure trace f_m: what the last generation's children did."""
    lines = ["i | predicted | measured | kept | outcome | change"]
    for r in rows:
        pred = "-" if r.get("predicted") is None else f"{r['predicted']:+.3f}"
        meas = "-" if r.get("measured") is None else f"{r['measured']:+.3f}"
        kept = "yes" if r.get("accepted") else "no"
        outcome = "ok" if r.get("valid") else (r.get("error") or "invalid")[:60]
        lines.append(f"{r['iter']} | {pred} | {meas} | {kept} | {outcome} | "
                     f"{(r.get('summary') or '')[:90]}")
    valid = [r["measured"] for r in rows if r.get("valid") and r.get("measured") is not None]
    p_hat = sum(valid) / len(valid) if valid else 0.0
    lines.append(f"P_hat (mean measured change of valid children) = {p_hat:+.4f}; "
                 f"valid {len(valid)}/{len(rows)}; kept {sum(bool(r.get('accepted')) for r in rows)}")
    return "\n".join(lines)


async def meta_update(llm, imp: Improver, trace_rows: List[dict], lineage: List[dict],
                      gen: int) -> Tuple[Improver, dict]:
    """One slow-loop round: the improver's own agents edit the improver.

    `lineage` rows: {"vid", "target", "tags", "p_hat", "text"} for earlier versions.
    Returns the edited improver (a new version) and an info dict for the log. Failures
    fall back to the round-robin target and leave unparseable parts unchanged.
    """
    trace = format_trace(trace_rows)
    info: dict = {"gen": gen, "calls": 0}

    # 1. Analyzer (psi): which component is most implicated?
    a_sys = ("You are the Analyzer in a system that evolves a bin-packing heuristic and also "
             "improves its own improvement process. Your analysis instructions are:\n"
             f"{imp.analysis}")
    a_user = (f"Current improvement process (five components):\n{describe(imp)}\n\n"
              f"Results of the last generation of children:\n{trace}\n\n"
              "Name the single component most responsible for these results and say why. "
              'Reply with JSON only: {"target": "analysis|retrieval|allocation|proposer|editor", '
              '"diagnosis": "...", "tags": ["short", "tags"]}')
    text, _ = await llm.chat(a_sys, a_user, "meta_analyzer", temperature=0.7)
    info["calls"] += 1
    j = _json_block(text) or {}
    target = j.get("target") if j.get("target") in COMPONENTS else COMPONENTS[gen % len(COMPONENTS)]
    diagnosis = str(j.get("diagnosis") or "")[:800]
    tags = [str(t)[:30] for t in (j.get("tags") or [])][:6] if isinstance(j.get("tags"), list) else []
    info.update(target=target, diagnosis=diagnosis, tags=tags, analyzer_parsed=bool(j))

    # 2. Retriever (sigma): earlier versions of the target with matching tags, best P_hat first.
    past = [r for r in lineage if r.get("target") == target and r.get("text")]
    past.sort(key=lambda r: (len(set(r.get("tags") or []) & set(tags)), r.get("p_hat") or 0.0),
              reverse=True)
    retrieved = past[: max(1, min(3, imp.num_top - 1))]
    info["retrieved"] = [r["vid"] for r in retrieved]
    retrieved_txt = "\n\n".join(
        f"version {r['vid']} (P_hat {r.get('p_hat', 0.0):+.4f}):\n{r['text'][:600]}" for r in retrieved
    ) or "(no earlier versions of this component)"

    # 3. Allocator (alpha): set the budget numbers for the next generation.
    al_sys = ("You are the Allocator in a self-improving program-evolution system. Your policy:\n"
              f"{imp.allocation}")
    al_user = (f"Results of the last generation:\n{trace}\n\n"
               f"Current budget: k_base={imp.k_base} (children per parent, 1-3), "
               f"k_widen={imp.k_widen} (extra children when stagnating, 0-2), "
               f"temperature={imp.temperature} (0.2-1.2), exploration={imp.exploration} (0-0.5), "
               f"exploitation={imp.exploitation} (0.3-0.9).\n"
               "Reply with JSON only, the budget for the next generation: "
               '{"k_base": 2, "k_widen": 1, "temperature": 0.7, "exploration": 0.2, '
               '"exploitation": 0.7}')
    text, _ = await llm.chat(al_sys, al_user, "meta_allocator", temperature=0.7)
    info["calls"] += 1
    budget = _json_block(text) or {}
    info["budget"] = budget

    # 4. Proposer (pi): propose an edit to the target component.
    p_sys = (f"{imp.proposer}\n\nRight now you are not editing the heuristic: you are "
             "improving one component of the process that edits it.")
    p_user = (f"Component to improve: {target}\nDiagnosis: {diagnosis}\n\n"
              f"Current text of the component:\n{getattr(imp, target)}\n\n"
              f"Earlier versions of this component:\n{retrieved_txt}\n\n"
              f"Results of the last generation:\n{trace}\n\n"
              "Propose one specific change to this component, in at most five sentences.")
    plan, _ = await llm.chat(p_sys, p_user, "meta_proposer", temperature=imp.temperature)
    info["calls"] += 1
    info["plan"] = (plan or "")[:1200]

    # 5. Evolver (epsilon): write the new component.
    e_sys = (f"{imp.editor}\n\nRight now you are not editing code: you are rewriting one "
             "instruction text used by the process that edits the code.")
    extra = ""
    if target == "retrieval":
        extra = ('\nAlso give the numbers on one line inside the tags as JSON, e.g. '
                 '{"num_top": 3, "num_diverse": 2}, before the text.')
    e_user = (f"Component: {target}\nCurrent text:\n{getattr(imp, target)}\n\n"
              f"Change to make:\n{plan or '(no plan; make a small improvement)'}\n\n"
              f"Write the complete new text (at most {TEXT_LIMIT} characters) between "
              f"<component> and </component> tags.{extra}")
    text, _ = await llm.chat(e_sys, e_user, "meta_evolver", temperature=0.5)
    info["calls"] += 1
    new_text = _tagged(text, "component")
    info["evolver_parsed"] = new_text is not None

    d = imp.to_dict()
    if new_text:
        if target == "retrieval":
            nums = _json_block(new_text) or {}
            if "num_top" in nums:
                d["num_top"] = nums["num_top"]
            if "num_diverse" in nums:
                d["num_diverse"] = nums["num_diverse"]
            new_text = re.sub(r"\{[^{}]*\}", "", new_text, count=1).strip()
        d[target] = new_text
    for k in ("k_base", "k_widen", "temperature", "exploration", "exploitation"):
        if k in budget:
            d[k] = budget[k]
    d.update(vid=f"v{gen}", parent=imp.vid, gen=gen,
             origin=f"meta:{target}", tags=tags)
    new = Improver.from_dict(d).clipped()
    info["new_vid"] = new.vid
    return new, info


# --------------------------------------------------------------------------- arm 1

@dataclass
class PromptEntry:
    pid: str
    text: str
    parent: Optional[str]
    gen: int
    uses: int = 0
    total_delta: float = 0.0

    @property
    def mean_delta(self) -> float:
        return self.total_delta / self.uses if self.uses else 0.0


class PromptDB:
    """AlphaEvolve-style co-evolved instruction texts, scored on the arm's own evaluator."""

    UCB_C = 0.3   # exploration bonus, in fitness-score units
    CAPACITY = 8
    DELTA_CLIP = 2.0

    def __init__(self, seed_text: str):
        self.entries: Dict[str, PromptEntry] = {"p0": PromptEntry("p0", seed_text, None, 0)}

    def select(self) -> PromptEntry:
        total = sum(e.uses for e in self.entries.values()) + 1
        def ucb(e: PromptEntry) -> float:
            return e.mean_delta + self.UCB_C * math.sqrt(math.log(total + 1) / (e.uses + 1))
        return max(self.entries.values(), key=lambda e: (ucb(e), -e.gen))

    def credit(self, pid: str, delta: Optional[float]) -> None:
        e = self.entries.get(pid)
        if e is None:
            return
        d = 0.0 if delta is None else max(-self.DELTA_CLIP, min(self.DELTA_CLIP, delta))
        e.uses += 1
        e.total_delta += d

    def ranked(self) -> List[PromptEntry]:
        return sorted(self.entries.values(), key=lambda e: (e.uses >= 3, e.mean_delta), reverse=True)

    async def mutate(self, llm, gen: int) -> Tuple[Optional[PromptEntry], dict]:
        top = self.ranked()[:3]
        shown = "\n\n".join(
            f"<variant id={e.pid} uses={e.uses} mean_change={e.mean_delta:+.4f}>\n{e.text}\n</variant>"
            for e in top)
        sys_msg = ("You improve the instructions given to an LLM that evolves a Python heuristic "
                   "for online bin packing. Better instructions lead to children with a higher "
                   "fitness score than their parents.")
        user = (f"Instruction variants so far, with how much their children improved on their "
                f"parents on average:\n\n{shown}\n\nWrite one new variant that should work better. "
                f"Keep everything a code-evolution model needs (task, scoring, editing rules). "
                f"Put the complete text, at most {4 * TEXT_LIMIT} characters, between "
                "<instructions> and </instructions> tags.")
        text, _ = await llm.chat(sys_msg, user, "prompt_mutation", temperature=0.9)
        new_text = _tagged(text, "instructions")
        info = {"gen": gen, "parsed": new_text is not None, "parents": [e.pid for e in top]}
        if not new_text:
            return None, info
        entry = PromptEntry(f"p{gen}", new_text[: 4 * TEXT_LIMIT],
                            top[0].pid if top else None, gen)
        self.entries[entry.pid] = entry
        if len(self.entries) > self.CAPACITY:
            best = self.ranked()[0].pid
            scored = [e for e in self.entries.values() if e.uses >= 3 and e.pid != best]
            if scored:
                worst = min(scored, key=lambda e: e.mean_delta)
                del self.entries[worst.pid]
        info["new_pid"] = entry.pid
        return entry, info

    def to_dict(self) -> dict:
        return {pid: asdict(e) for pid, e in self.entries.items()}

    @classmethod
    def from_dict(cls, d: dict) -> "PromptDB":
        db = cls.__new__(cls)
        db.entries = {pid: PromptEntry(**e) for pid, e in d.items()}
        return db
