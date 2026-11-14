"""One arm, one seed: the fast loop (program evolution) and the slow loop (improver edits).

The fast loop is OpenEvolve v0.4.0's iteration (process_parallel._run_iteration_worker),
driven in-process so the three arms share one code path: sample a parent and inspirations
from OpenEvolve's island/MAP-Elites `ProgramDatabase`, build the prompt with OpenEvolve's
`PromptSampler`, call the model through OpenEvolve's `OpenAILLM`, apply the SEARCH/REPLACE
diff with OpenEvolve's `apply_diff_blocks`. What differs per arm is only:

arm 1  AlphaEvolve-style. Every valid child enters the database (OpenEvolve's semantics),
       scored on a reused 16-instance validation set. Instruction texts co-evolve in a
       PromptDB scored on the same set; one mutation call per generation.
arm 2  MetaSkill-Evolve-style recursive baseline. K children per parent step (the
       allocator's budget); a child is kept only if it beats its parent on the reused
       validation set (ΔU > 0). Every generation the improver edits itself through the
       five-agent pipeline, and the edit is applied unconditionally.
arm 3  Arm 2 plus governance: every promotion passes the fresh-task gate, every improver
       edit must win an equal-budget descendant test on fresh instances, and the
       proposer's prediction error caps its children per parent. Gate, thresholds,
       issuer and logs are harness objects the loop cannot write.

Compute is equal per generation: arm 1 makes 23 proposals + 1 prompt mutation, arms 2
and 3 make 20 proposals + 4 meta calls. The final holdout is never generated in this
process (binpack.FORBIDDEN_STREAMS).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import pickle
import random
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from openevolve.config import Config, DatabaseConfig, PromptConfig
from openevolve.database import Program, ProgramDatabase
from openevolve.prompt.sampler import PromptSampler
from openevolve.utils.code_utils import apply_diff_blocks, extract_diffs, format_diff_summary

from . import binpack, sandbox
from .evaluation import Evaluator, family_metrics
from .gate import Calibration, GateConfig, SigmaGate, TaskIssuer
from .improver import (PREDICTION_REQUEST, Improver, PromptDB, meta_update, parse_prediction,
                       seed_improver)
from .llm import LLM, Ledger

DIFF_PATTERN = Config().diff_pattern


@dataclass
class RunConfig:
    arm: int
    seed: int
    out: str
    gens: int = 30
    h: int = 20            # proposals per generation, arms 2 and 3
    h_arm1: int = 23       # proposals per generation, arm 1 (equal calls per generation)
    n_val: int = 16        # reused validation set, arms 1 and 2
    model: str = "gpt-4o-mini"
    provider: str = "openai"
    max_tokens: int = 2048
    num_islands: int = 3
    population_size: int = 300
    archive_size: int = 60
    gate: dict = field(default_factory=lambda: asdict(GateConfig()))


class Prompter:
    """OpenEvolve's PromptSampler with the diff template plus the prediction request."""

    def __init__(self):
        base = PromptSampler(PromptConfig()).template_manager.get_template("diff_user")
        self.user_template = base + "\n\n" + PREDICTION_REQUEST
        self._cache: Dict[tuple, PromptSampler] = {}

    def _sampler(self, system_text: str, num_top: int, num_diverse: int) -> PromptSampler:
        key = (system_text, num_top, num_diverse)
        if key not in self._cache:
            if len(self._cache) > 64:
                self._cache.clear()
            s = PromptSampler(PromptConfig(
                system_message=system_text, num_top_programs=num_top,
                num_diverse_programs=num_diverse, include_artifacts=False,
                use_template_stochasticity=False, suggest_simplification_after_chars=2500))
            s.template_manager.add_template("diff_user", self.user_template)
            self._cache[key] = s
        return self._cache[key]

    def build(self, db: ProgramDatabase, parent: Program, inspirations: List[Program], island: int,
              iteration: int, system_text: str, num_top: int, num_diverse: int) -> dict:
        s = self._sampler(system_text, num_top, num_diverse)
        progs = [db.programs[p] for p in db.islands[island % len(db.islands)] if p in db.programs]
        if not progs:
            progs = list(db.programs.values())
        progs.sort(key=lambda p: p.metrics.get("combined_score", 0.0), reverse=True)
        return s.build_prompt(
            current_program=parent.code, parent_program=parent.code,
            program_metrics=parent.metrics,
            previous_programs=[p.to_dict() for p in progs[:num_top]],
            top_programs=[p.to_dict() for p in progs[:num_top + num_diverse]],
            inspirations=[p.to_dict() for p in inspirations], language="python",
            evolution_round=iteration, diff_based_evolution=True, program_artifacts=None,
            feature_dimensions=db.config.feature_dimensions)


def make_child(parent_code: str, response: Optional[str]) -> Tuple[Optional[str], str, str]:
    """OpenEvolve's diff path: (child_code or None, error, short change summary)."""
    if not response:
        return None, "empty response", ""
    try:
        blocks = extract_diffs(response, DIFF_PATTERN)
    except ValueError as exc:
        return None, f"diff: {exc}", ""
    if not blocks:
        return None, "no SEARCH/REPLACE block", ""
    code, applied = apply_diff_blocks(parent_code, blocks)
    if applied == 0:
        return None, "no SEARCH block matched the parent", ""
    if code == parent_code:
        return None, "diff did not change the program", ""
    try:
        sandbox.check_code(code)
    except sandbox.CodeRejected as exc:
        return None, f"rejected: {exc}", ""
    summary = format_diff_summary(blocks, max_line_len=80, max_lines=3).replace("\n", " ")
    return code, "", summary[:160]


class ArmRun:
    def __init__(self, cfg: RunConfig, llm=None, pool: Optional[sandbox.SandboxPool] = None):
        self.cfg = cfg
        self.arm = cfg.arm
        self.out = Path(cfg.out)
        (self.out / "programs").mkdir(parents=True, exist_ok=True)
        (self.out / "snapshots").mkdir(exist_ok=True)
        binpack.FORBIDDEN_STREAMS.add("holdout")
        self.ledger = Ledger()
        if llm is None:
            llm = LLM(cfg.model, cfg.provider, temperature=0.7, max_tokens=cfg.max_tokens,
                      ledger=self.ledger)
        llm.ledger = self.ledger
        self.llm = llm
        self._own_pool = pool is None
        self.pool = pool or sandbox.SandboxPool(1)
        self.ev = Evaluator(self.pool)
        self.prompter = Prompter()
        self.rng = np.random.default_rng([cfg.seed, cfg.arm, 7])
        self.gen = 0
        self.iteration = 0
        self.t_start = time.time()
        self.elapsed_before = 0.0
        self.improver = seed_improver()
        self.candidate: Optional[Improver] = None
        self.improvers: Dict[str, dict] = {"v0": self.improver.to_dict()}
        self.lineage: List[dict] = []
        self.prompt_db = PromptDB(self.improver.system_message()) if self.arm == 1 else None
        self.history: List[dict] = []
        dbcfg = DatabaseConfig(
            in_memory=True, log_prompts=False, population_size=cfg.population_size,
            archive_size=cfg.archive_size, num_islands=cfg.num_islands,
            feature_dimensions=["complexity", "diversity"], feature_bins=6,
            migration_interval=20, migration_rate=0.1, random_seed=cfg.seed)
        self.db = ProgramDatabase(dbcfg)
        if self.arm in (1, 2):
            self.val = binpack.make_instances(f"val{cfg.seed}", range(cfg.n_val))
        if self.arm == 3:
            self.gcfg = GateConfig(**cfg.gate)
            self.issuer = TaskIssuer(f"fresh{cfg.seed}", self.out / "ledger.jsonl")
            self.gate = SigmaGate(self.gcfg, self.issuer, self.ev, self.out / "gate.jsonl", self.rng)
            self.calib = Calibration(self.gcfg.calib_window, self.gcfg.calib_min)
            self.est: Dict[str, dict] = {}

    # ------------------------------------------------------------------ bookkeeping
    def _store(self, code: str) -> str:
        h = sandbox.code_hash(code)
        p = self.out / "programs" / f"{h}.py"
        if not p.exists():
            p.write_text(code, encoding="utf-8")
        return h

    def _log(self, name: str, row: dict) -> None:
        with (self.out / name).open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, default=float) + "\n")

    def _estimate_update(self, pid: str, insts, scores: np.ndarray) -> None:
        e = self.est.setdefault(pid, {"sum": 0.0, "n": 0, "fam": {}})
        for inst, s in zip(insts, scores):
            e["sum"] += float(s)
            e["n"] += 1
            fs = e["fam"].setdefault(inst.family, [0.0, 0])
            fs[0] += float(s)
            fs[1] += 1
        prog = self.db.programs.get(pid)
        if prog is not None:
            m = {"combined_score": e["sum"] / e["n"] if e["n"] else 0.0}
            for fam, (s, n) in e["fam"].items():
                m[f"{fam}_score"] = s / n
            prog.metrics.clear()
            prog.metrics.update(m)

    def _add_seed(self) -> None:
        code = binpack.SEED_PROGRAM
        if self.arm in (1, 2):
            ok, metrics, err = self.ev.metrics(code, self.val)
        else:
            fresh = self.issuer.draw(self.gcfg.n_fresh, "seed", 0)
            ok, sc, err = self.ev.scores(code, fresh)
            metrics = family_metrics(fresh, sc) if ok else {}
        if not ok:
            raise RuntimeError(f"seed program failed: {err}")
        seed = Program(id="seed", code=code, generation=0, metrics=dict(metrics),
                       iteration_found=0, metadata={"island": 0})
        self.db.add(seed, iteration=0, target_island=0)
        if self.arm == 3:
            self._estimate_update("seed", fresh, sc)
            self.issuer.burn(fresh, 0)
        self._store(code)

    def champion(self) -> Tuple[Program, float]:
        progs = list(self.db.programs.values())
        best = max(progs, key=lambda p: (p.metrics.get("combined_score", -1e9), -p.iteration_found))
        return best, float(best.metrics.get("combined_score", 0.0))

    async def _aw(self, awaitable):
        """Await, then restore this run's `random` state.

        OpenEvolve's database and prompt sampler use Python's global `random`. When several
        runs share a process (rsi_oe.multi), another run may draw from it while this one
        waits; restoring the saved state keeps each run on its own stream. Code between
        awaits runs uninterrupted, so this is the only place the streams could mix.
        """
        state = random.getstate()
        try:
            return await awaitable
        finally:
            random.setstate(state)

    async def _in_thread(self, fn, *args):
        return await self._aw(asyncio.to_thread(fn, *args))

    # ------------------------------------------------------------------ one proposal
    async def _propose(self, parent: Program, inspirations: List[Program], island: int,
                       system_text: str, num_top: int, num_diverse: int, temperature: float):
        prompt = self.prompter.build(self.db, parent, inspirations, island, self.iteration,
                                     system_text, num_top, num_diverse)
        t0 = time.time()
        text, usage = await self._aw(self.llm.chat(prompt["system"], prompt["user"], "proposal",
                                                   temperature=temperature))
        code, err, summary = make_child(parent.code, text)
        return {"code": code, "error": err if code is None else "", "summary": summary,
                "predicted": parse_prediction(text), "usage": usage or {},
                "llm_seconds": round(time.time() - t0, 2)}

    def _new_program(self, code: str, parent: Program, metrics: dict, island: int) -> Program:
        # deterministic ids: OpenEvolve samples from sets of ids, so random ids would make
        # parent choice depend on the ids themselves
        return Program(id=f"a{self.arm}s{self.cfg.seed}i{self.iteration}", code=code, parent_id=parent.id,
                       generation=parent.generation + 1, metrics=dict(metrics),
                       iteration_found=self.iteration, metadata={"island": island})

    def _admit(self, child: Program, island: int) -> None:
        self.db.add(child, iteration=self.iteration, target_island=island)
        self.db.increment_island_generation(island_idx=island)
        if self.db.should_migrate():
            self.db.migrate_programs()

    def _row(self, prop: dict, parent: Program, island: int, improver_id: str, k: int,
             k_cap: Optional[int] = None) -> dict:
        return {"gen": self.gen, "iter": self.iteration, "arm": self.arm, "improver": improver_id,
                "island": island, "parent_id": parent.id,
                "parent_hash": sandbox.code_hash(parent.code),
                "parent_score": float(parent.metrics.get("combined_score", 0.0)),
                "child_id": None, "child_hash": None, "valid": False, "error": prop["error"],
                "summary": prop["summary"], "predicted": prop["predicted"], "measured": None,
                "accepted": False, "k": k, "k_cap": k_cap,
                "prompt_tokens": prop["usage"].get("prompt_tokens", 0),
                "completion_tokens": prop["usage"].get("completion_tokens", 0),
                "llm_seconds": prop["llm_seconds"]}

    # ------------------------------------------------------------------ arm 1
    async def _generation_arm1(self) -> List[dict]:
        rows = []
        for _ in range(self.cfg.h_arm1):
            self.iteration += 1
            island = self.iteration % self.cfg.num_islands
            parent, insp = self.db.sample_from_island(island, num_inspirations=2)
            entry = self.prompt_db.select()
            prop = await self._propose(parent, insp, island, entry.text, 3, 2, 0.7)
            row = self._row(prop, parent, island, entry.pid, 1)
            delta = None
            if prop["code"] is not None:
                t0 = time.time()
                ok, metrics, err = await self._in_thread(self.ev.metrics, prop["code"], self.val)
                row["eval_seconds"] = round(time.time() - t0, 2)
                if ok:
                    child = self._new_program(prop["code"], parent, metrics, island)
                    delta = metrics["combined_score"] - row["parent_score"]
                    self._admit(child, island)
                    row.update(child_id=child.id, child_hash=self._store(child.code), valid=True,
                               measured=delta, accepted=delta > 0, child_score=metrics["combined_score"])
                else:
                    row["error"] = err[:300]
            self.prompt_db.credit(entry.pid, delta)
            rows.append(row)
            self._log("children.jsonl", row)
        entry, info = await self._aw(self.prompt_db.mutate(self.llm, self.gen))
        info["kind"] = "prompt_mutation"
        self._log("meta.jsonl", info)
        return rows

    # ------------------------------------------------------------------ arms 2 and 3
    async def _step(self, imp: Improver, island: int, k_budget: int, stagnating: bool,
                    rows: List[dict], window: Optional[list]) -> Tuple[bool, int]:
        db = self.db
        db.config.exploration_ratio = imp.exploration
        db.config.exploitation_ratio = imp.exploitation
        parent, insp = db.sample_from_island(island, num_inspirations=imp.num_diverse)
        k = imp.k_for_step(stagnating)
        k_cap = None
        if self.arm == 3:
            k_cap = self.calib.k_cap()
            k = min(k, k_cap)
        k = max(1, min(k, k_budget))
        system_text = imp.system_message()
        any_accepted = False
        for _ in range(k):
            self.iteration += 1
            prop = await self._propose(parent, insp, island, system_text, imp.num_top,
                                       imp.num_diverse, imp.temperature)
            row = self._row(prop, parent, island, imp.vid, k, k_cap)
            if prop["code"] is not None:
                t0 = time.time()
                if self.arm == 2:
                    ok, metrics, err = await self._in_thread(self.ev.metrics, prop["code"], self.val)
                    if ok:
                        delta = metrics["combined_score"] - row["parent_score"]
                        row.update(valid=True, measured=delta, accepted=delta > 0,
                                   child_hash=self._store(prop["code"]),
                                   child_score=metrics["combined_score"])
                        if delta > 0:
                            child = self._new_program(prop["code"], parent, metrics, island)
                            self._admit(child, island)
                            row["child_id"] = child.id
                    else:
                        row["error"] = err[:300]
                else:
                    accept, rec, fresh, sc, sp = await self._in_thread(
                        self.gate.promote, prop["code"], parent.code, self.gen, f"iter{self.iteration}")
                    row["gate"] = {k2: rec.get(k2) for k2 in ("reason", "gain", "t", "retention")}
                    if len(sc) and len(sp):
                        delta = float(np.mean(sc - sp))
                        row.update(valid=True, measured=delta, accepted=accept,
                                   child_hash=self._store(prop["code"]),
                                   child_score=float(np.mean(sc)))
                        self.calib.add(prop["predicted"], delta)
                        self._estimate_update(parent.id, fresh, sp)
                        if accept:
                            child = self._new_program(prop["code"], parent,
                                                      family_metrics(fresh, sc), island)
                            self._admit(child, island)
                            self._estimate_update(child.id, fresh, sc)
                            row["child_id"] = child.id
                    else:
                        row["error"] = (rec.get("error") or "evaluation failed")[:300]
                row["eval_seconds"] = round(time.time() - t0, 2)
            if window is not None:
                window.append((prop["code"] if row["valid"] else None, parent.code))
            any_accepted = any_accepted or bool(row["accepted"])
            rows.append(row)
            self._log("children.jsonl", row)
        return any_accepted, k

    async def _generation_arm23(self) -> List[dict]:
        rows: List[dict] = []
        budget = self.cfg.h
        step = 0
        stagnating = False
        win_inc: List[tuple] = []
        win_cand: List[tuple] = []
        testing = self.arm == 3 and self.candidate is not None
        while budget > 0:
            use_candidate = testing and step % 2 == 1
            imp = self.candidate if use_candidate else self.improver
            window = (win_cand if use_candidate else win_inc) if testing else None
            island = (self.iteration + 1) % self.cfg.num_islands
            accepted, used = await self._step(imp, island, budget, stagnating, rows, window)
            budget -= used
            stagnating = not accepted
            step += 1
        if self.arm == 3 and testing:
            adopt, rec = await self._in_thread(self.gate.improver, win_inc, win_cand, self.gen)
            rec.update(kind="improver_gate", incumbent=self.improver.vid, candidate=self.candidate.vid)
            self._log("meta.jsonl", rec)
            if adopt:
                self.improver = self.candidate
            self.candidate = None
        # slow loop: the improver edits itself (arm 2 applies it; arm 3 tests it next generation)
        own = [r["measured"] for r in rows if r["valid"] and r["measured"] is not None
               and r["improver"] == self.improver.vid]
        valid = own or [r["measured"] for r in rows if r["valid"] and r["measured"] is not None]
        p_hat = float(np.mean(valid)) if valid else 0.0
        self.lineage.append({"vid": self.improver.vid, "target": self.improver.origin.replace("meta:", ""),
                             "tags": self.improver.tags, "p_hat": p_hat,
                             "text": getattr(self.improver, self.improver.origin.replace("meta:", ""), "")
                             if self.improver.origin.startswith("meta:") else ""})
        new, info = await self._aw(meta_update(self.llm, self.improver, rows, self.lineage, self.gen))
        self.improvers[new.vid] = new.to_dict()
        self._log("improvers.jsonl", new.to_dict())
        info.update(kind="meta_update", p_hat=p_hat, applied=self.arm == 2)
        self._log("meta.jsonl", info)
        if self.arm == 2:
            self.improver = new
        else:
            self.candidate = new
        return rows

    # ------------------------------------------------------------------ the run
    def _snapshot(self, rows: List[dict]) -> dict:
        champ, believed = self.champion()
        progs = []
        for p in self.db.programs.values():
            progs.append({"id": p.id, "hash": self._store(p.code), "parent": p.parent_id,
                          "score": float(p.metrics.get("combined_score", 0.0)),
                          "metrics": p.metrics, "island": p.metadata.get("island"),
                          "n_est": self.est.get(p.id, {}).get("n") if self.arm == 3 else None})
        snap = {
            "gen": self.gen, "arm": self.arm, "seed": self.cfg.seed,
            "champion": {"id": champ.id, "hash": sandbox.code_hash(champ.code), "believed": believed,
                         "n_est": self.est.get(champ.id, {}).get("n") if self.arm == 3 else self.cfg.n_val},
            "improver": self.improver.vid,
            "candidate": self.candidate.vid if self.candidate else None,
            "prompt_db": self.prompt_db.to_dict() if self.prompt_db else None,
            "prompt_choice": self.prompt_db.select().pid if self.prompt_db else None,
            "k_cap": self.calib.k_cap() if self.arm == 3 else None,
            "calib_skill": self.calib.skill() if self.arm == 3 else None,
            "programs": progs,
            "usage": self.ledger.totals(getattr(self.llm, "model", "?")),
            "evaluator": self.ev.stats(),
            "fresh_issued": self.issuer.next_idx if self.arm == 3 else 0,
            "elapsed_seconds": round(self.elapsed_before + time.time() - self.t_start, 1),
        }
        (self.out / "snapshots" / f"gen_{self.gen:03d}.json").write_text(
            json.dumps(snap, default=float), encoding="utf-8")
        return snap

    def _save_state(self) -> None:
        st = {
            "cfg": asdict(self.cfg), "gen": self.gen, "iteration": self.iteration,
            "db": self.db, "py_random": random.getstate(), "np_rng": self.rng.bit_generator.state,
            "improver": self.improver.to_dict(),
            "candidate": self.candidate.to_dict() if self.candidate else None,
            "improvers": self.improvers, "lineage": self.lineage,
            "prompt_db": self.prompt_db.to_dict() if self.prompt_db else None,
            "ledger": self.ledger.to_dict(), "history": self.history,
            "elapsed": self.elapsed_before + time.time() - self.t_start,
            "ev_stats": (self.ev.instance_evals, self.ev.program_runs, self.ev.cpu_seconds),
        }
        if self.arm == 3:
            st.update(issuer=self.issuer.state(), calib=self.calib.state(), est=self.est)
        tmp = self.out / "state.pkl.tmp"
        with tmp.open("wb") as f:
            pickle.dump(st, f)
        os.replace(tmp, self.out / "state.pkl")

    def _load_state(self) -> bool:
        p = self.out / "state.pkl"
        if not p.exists():
            return False
        with p.open("rb") as f:
            st = pickle.load(f)
        self.gen, self.iteration = st["gen"], st["iteration"]
        self.db = st["db"]
        random.setstate(st["py_random"])
        self.rng.bit_generator.state = st["np_rng"]
        self.improver = Improver.from_dict(st["improver"])
        self.candidate = Improver.from_dict(st["candidate"]) if st["candidate"] else None
        self.improvers, self.lineage, self.history = st["improvers"], st["lineage"], st["history"]
        if st["prompt_db"] is not None:
            self.prompt_db = PromptDB.from_dict(st["prompt_db"])
        self.ledger = Ledger.from_dict(st["ledger"])
        self.llm.ledger = self.ledger
        self.elapsed_before = st["elapsed"]
        self.ev.instance_evals, self.ev.program_runs, self.ev.cpu_seconds = st["ev_stats"]
        if self.arm == 3:
            self.issuer.restore(st["issuer"])
            self.calib = Calibration.from_state(st["calib"])
            self.est = st["est"]
            self.gate.rng = self.rng
        # drop log rows from a generation that did not finish
        for name in ("children.jsonl", "meta.jsonl", "improvers.jsonl", "ledger.jsonl", "gate.jsonl"):
            f = self.out / name
            if f.exists():
                keep = [ln for ln in f.read_text(encoding="utf-8").splitlines()
                        if ln.strip() and json.loads(ln).get("gen", 0) <= self.gen]
                f.write_text("\n".join(keep) + ("\n" if keep else ""), encoding="utf-8")
        return True

    async def run(self) -> dict:
        if not self._load_state():
            # Deterministic per-run stream; the database constructor's reseed of the global
            # generator is not enough once several runs share a process.
            random.seed(f"rsi-oe/{self.cfg.arm}/{self.cfg.seed}")
            self._add_seed()
            (self.out / "config.json").write_text(json.dumps(asdict(self.cfg), indent=2),
                                                  encoding="utf-8")
            self._log("improvers.jsonl", self.improver.to_dict())
            self.gen = 0
            self._snapshot([])
            self._save_state()
        while self.gen < self.cfg.gens:
            self.gen += 1
            rows = await (self._generation_arm1() if self.arm == 1 else self._generation_arm23())
            snap = self._snapshot(rows)
            h = {"gen": self.gen, "champion": snap["champion"], "n_children": len(rows),
                 "n_valid": sum(r["valid"] for r in rows),
                 "n_accepted": sum(bool(r["accepted"]) for r in rows),
                 "usage": snap["usage"]["prompt_tokens"] + snap["usage"]["completion_tokens"],
                 "usd": snap["usage"]["usd"], "elapsed": snap["elapsed_seconds"]}
            self.history.append(h)
            self._save_state()
            print(json.dumps({"arm": self.arm, "seed": self.cfg.seed, **{k: h[k] for k in (
                "gen", "n_valid", "n_accepted", "usd", "elapsed")},
                "champ_believed": round(snap["champion"]["believed"], 3)}), flush=True)
        summary = {"cfg": asdict(self.cfg), "history": self.history,
                   "usage": self.ledger.totals(getattr(self.llm, "model", "?")),
                   "evaluator": self.ev.stats()}
        (self.out / "summary.json").write_text(json.dumps(summary, indent=2, default=float),
                                               encoding="utf-8")
        if self._own_pool:
            self.pool.close()
        return summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--arm", type=int, required=True, choices=(1, 2, 3))
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gens", type=int, default=30)
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--provider", default="openai")
    a = ap.parse_args(argv)
    cfg = RunConfig(arm=a.arm, seed=a.seed, out=a.out, gens=a.gens, model=a.model,
                    provider=a.provider)
    asyncio.run(ArmRun(cfg).run())
    return 0


if __name__ == "__main__":
    sys.exit(main())
