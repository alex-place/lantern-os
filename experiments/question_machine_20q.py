"""20 Questions: does the Question Machine ask better questions than an LLM asking freely?

BED-LLM's 20 Questions protocol (Choudhury et al., ICLR 2026, arXiv 2508.21184), on its Animals targets
(data/question_machine/bedllm_animals.txt, MIT; see BEDLLM-LICENSE.txt there), with one model as
questioner and answerer.

  answerer  a separate call that is told the secret and sees only the current question. It answers Yes
            or No. The paper's answerer prompt is not in its text, so this one is ours.
  prompt    the paper's Prompt-Only baseline: its Figure 14 prompt verbatim, sampled at T=1.
  qm        the Question Machine. Each turn:
              candidates   top the candidates up to 15 by sampling at T=1.3 with the paper's Figure 8
                           prompt, never re-proposing one already guessed
              likelihoods  P(Yes | candidate, question) from the token log-probabilities of the model's
                           own answers, renormalised over Yes and No, one call per candidate
              belief       the paper's rule: drop a candidate once an answer has probability below 0.2
                           under it, and hold a uniform belief over the survivors. `--belief bayes` is
                           Bayes' rule instead, with a 2% chance that any answer is the wrong way round,
                           dropping a candidate 9.2 nats (10⁴) behind the best. In our smoke run it kept
                           about 15 contradicted candidates alive, so the pool never refreshed, and it
                           lost both games. It is kept for comparison, not as the default.
              questions    15 candidate yes/no questions from the model, given the history and the
                           candidates. Under --belief bayes, "Is it X?" for the most probable candidate
                           is one more question in the pool.
              selection    QuestionMachine.ask_by_information: exact expected information gain (G2), over
                           the questions CAP and NAP admit. When one candidate is left, or no question
                           separates them, it asks "Is it X?" for the candidate that fits best.

A game ends after 20 questions, or as soon as a question of the form "Is it X?" names the secret (or one
of its listed alternative names) and is answered Yes. Both arms are then scored the same way: a
confirmed guess, or else a final guess from the transcript alone (one shared prompt, T=0), matched by
normalised name. The paper scores its own method by its belief's best candidate; that is reported for
the qm arm too.

Every model call is cached on disk, keyed by the full request plus the game, turn and purpose, so a run
replays exactly from its cache and a re-run costs nothing.

Where this differs from the paper: the answerer, question and final-guess prompts are ours; a candidate
once guessed is never proposed again; and a Prompt-Only reply with no <question> tag gets one reminder of
the format before it is used as asked. (Without the reminder, gpt-4o-mini declared victory after "Is it a
frog?" was answered Yes, then chatted out its remaining turns.)

Run:  python experiments/question_machine_20q.py --games 30 [--model gpt-4o-mini] [--arms prompt,qm]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import math
import os
import pathlib
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, Dict, List, Optional, Sequence, Tuple

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from cio_sde.question import Experiment, QuestionMachine  # noqa: E402

TARGETS = ROOT / "data" / "question_machine" / "bedllm_animals.txt"
CACHE = ROOT / "data" / "question_machine" / "cache" / "20q.jsonl"
MAX_QUESTIONS, N_CANDIDATES, M_QUESTIONS = 20, 15, 15
FILTER = 0.2               # --belief filter: a candidate goes once an answer has probability below this
LAPSE = 0.02               # --belief bayes: the chance that any answer is the wrong way round
PRUNE_NATS = math.log(1e4) # --belief bayes: a candidate this far behind the best is dropped
SAMPLE_ATTEMPTS = 3
T_CANDIDATES, T_QUESTIONS, T_PROMPT_ONLY = 1.3, 1.0, 1.0
CHANNEL = "ask_answerer"   # the channel CAP and NAP gate for every question the qm arm asks
PRICES = {"gpt-4o-mini": (0.15, 0.60), "gpt-4o": (2.50, 10.00)}   # USD per million tokens (in, out), list prices
BEDLLM_ANIMALS = {"gpt-4o-mini": {"prompt": 44, "bed-llm": 88}, "gpt-4o": {"prompt": 45, "bed-llm": 93}}  # Table 1, %

PROMPT_ONLY = ("Your task is to ask a series of questions to deduce the identity of the animal that I'm thinking "
               "of with as few queries as possible. Only ask questions that can be answered by 'yes', 'no' or "
               "'maybe'. Do not ask for hint. Make your question standalone with no linebreaker. Output format: "
               "<question>Your question here?</question> Now start asking a question.")
ANSWERER = ("You are the answerer in a game of 20 Questions. The secret animal is: {target}. Answer the question "
            "about the secret animal truthfully, with exactly one word: Yes or No. If the question asks whether "
            "it is the secret animal, under that name or an equivalent one, answer Yes.")
NUDGE = "Please ask your next question, in the format <question>Your question here?</question>"
CANDIDATES = ("You are playing a game of 20 Questions about a secret animal. Using all of the questions and answers "
              "so far:\n{history}\nGenerate up to {n} candidate animals that satisfy every clue. Produce a varied "
              "set by identifying features not implied by the clues and diversifying along them. Do not repeat "
              "any animal. Return only the list of animals, one per line.")
QUESTIONS = ("You are playing 20 Questions about a secret animal. The questions and answers so far:\n{history}\n"
             "These candidates are still consistent with every answer: {candidates}.\nPropose {m} different yes/no "
             "questions to ask next. A good question splits the candidates. Each must be answerable with Yes or No "
             "and stand on its own. Put each on its own line, with no numbering and nothing else.")
LIKELIHOOD = ("We are playing 20 Questions. The secret animal is: {candidate}.\nAnswer each question below the way "
              "someone who knows the secret would, with Yes or No. Reply with one line per question, in the form "
              "'<number>: Yes' or '<number>: No', and nothing else.\n\n{questions}")
FINAL = ("These are the questions asked so far in a game of 20 Questions about a secret animal, with their "
         "answers:\n{history}\nWhat is the single most likely animal? Reply with its name only.")

Chat = Callable[..., dict]


# ── the model ────────────────────────────────────────────────────────────────────────────────

class OpenAIChat:
    """OpenAI chat completions over HTTPS with the standard library. Every response is cached on disk,
    keyed by the full request plus a salt naming the game, turn and purpose, and returned with its token
    counts. A cached call costs nothing and returns exactly what the first call saw."""

    URL = "https://api.openai.com/v1/chat/completions"

    def __init__(self, model: str, cache: pathlib.Path = CACHE, offline: bool = False) -> None:
        self.model, self.cache_path, self.offline = model, cache, offline
        self.key = os.environ.get("OPENAI_API_KEY", "")
        self.lock = threading.Lock()
        self.usage = {"calls": 0, "cached": 0, "input_tokens": 0, "output_tokens": 0}
        self.cache: Dict[str, dict] = {}
        if cache.exists():
            for line in cache.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    self.cache[row["key"]] = row["response"]

    def __call__(self, messages: List[dict], *, temperature: float, max_tokens: int, logprobs: bool = False,
                 salt: str = "") -> dict:
        body = {"model": self.model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if logprobs:
            body.update(logprobs=True, top_logprobs=5)
        key = hashlib.sha256(json.dumps({"body": body, "salt": salt}, sort_keys=True).encode()).hexdigest()
        with self.lock:
            if key in self.cache:
                self.usage["cached"] += 1
                return self.cache[key]
        if self.offline:
            raise RuntimeError("offline, and this call is not in the cache")
        response = self._post(body)
        with self.lock:
            self.cache[key] = response
            self.usage["calls"] += 1
            self.usage["input_tokens"] += response["input_tokens"]
            self.usage["output_tokens"] += response["output_tokens"]
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            with self.cache_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"key": key, "response": response}) + "\n")
        return response

    def _post(self, body: dict) -> dict:
        data, delay = json.dumps(body).encode(), 2.0
        for attempt in range(8):
            req = urllib.request.Request(self.URL, data=data, headers={
                "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=90) as r:  # nosec - the OpenAI API
                    out = json.loads(r.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504) or attempt == 7:
                    raise RuntimeError(f"OpenAI HTTP {e.code}: {e.read()[:300]!r}") from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 7:
                    raise
            time.sleep(delay)
            delay = min(delay * 2, 60.0)
        choice = out["choices"][0]
        content = (choice.get("logprobs") or {}).get("content") or []
        return {"text": choice["message"].get("content") or "",
                "tokens": [[t["token"], {a["token"]: a["logprob"] for a in t.get("top_logprobs", [])}]
                           for t in content],
                "input_tokens": out["usage"]["prompt_tokens"], "output_tokens": out["usage"]["completion_tokens"]}


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> Optional[float]:
    if model not in PRICES:
        return None
    price_in, price_out = PRICES[model]
    return round((input_tokens * price_in + output_tokens * price_out) / 1e6, 4)


# ── reading the game ─────────────────────────────────────────────────────────────────────────

def norm(name: str) -> str:
    """A name reduced for matching: lower case, 'grey' as 'gray', no punctuation or articles, and no
    final plural s."""
    s = re.sub(r"[^a-z0-9 ]+", " ", name.lower().replace("grey", "gray"))
    words = [w for w in s.split() if w not in ("a", "an", "the")]
    if words and len(words[-1]) > 3 and words[-1].endswith("s") and not words[-1].endswith("ss"):
        words[-1] = words[-1][:-1]
    return " ".join(words)


# "Is it X?", and the phrasings a questioner uses for the same guess ("Is the animal you are thinking of
# a moose?"). X must then be one of the target's names, so a category question never matches.
_GUESS = re.compile(r"^\s*(?:is it|is your animal|is the (?:secret )?animal(?: (?:that )?you(?:'re| are) "
                    r"thinking of)?|are you thinking of|is this animal)\s+(?:an? |the )?(.+?)\s*\?*\s*$",
                    re.IGNORECASE)


def aliases(target: str) -> List[str]:
    """A target's names: the list writes alternatives after '|', as in "Red-eyed tree frog | Redeyed tree frog"."""
    return [name.strip() for name in target.split("|") if name.strip()]


def is_target(name: str, target: str) -> bool:
    return bool(name) and norm(name) in {norm(a) for a in aliases(target)}


def names_target(question: str, target: str) -> bool:
    """Whether the question is "Is it X?" with X one of the target's names."""
    m = _GUESS.match(question.strip())
    return bool(m) and is_target(m.group(1), target)


def yes_no(text: str) -> str:
    t = text.strip().lower()
    return "Yes" if t.startswith("yes") else "No" if t.startswith("no") else ("Yes" if "yes" in t[:24] else "No")


def yes_probabilities(response: dict, k: int) -> Optional[List[float]]:
    """P(Yes) for each of k answers in a "<n>: Yes" list, from each answer token's log-probabilities
    renormalised over Yes and No. None unless the reply has exactly k answers."""
    out = []
    for token, top in response["tokens"]:
        if token.strip().lower() in ("yes", "no"):
            ly = max((lp for t, lp in top.items() if t.strip().lower() == "yes"), default=-30.0)
            ln = max((lp for t, lp in top.items() if t.strip().lower() == "no"), default=-30.0)
            m = max(ly, ln)
            out.append(math.exp(ly - m) / (math.exp(ly - m) + math.exp(ln - m)))
    return out if len(out) == k else None


def _lines(text: str) -> List[str]:
    out = []
    for line in text.splitlines():
        line = re.sub(r"^\s*(?:[-*•]|\d+[.)]|\d+:)\s*", "", line).strip().strip('"')
        if line:
            out.append(line)
    return out


def _history(history: Sequence[Tuple[str, str]]) -> str:
    return "\n".join(f"{i + 1}. {q} {a}" for i, (q, a) in enumerate(history)) or "(no questions yet)"


def _p(p_yes: float, answer: str) -> float:
    return p_yes if answer == "Yes" else 1.0 - p_yes


class Meter:
    """Tokens a game used, cached or not: the cost of the method, not of this particular run."""

    def __init__(self, chat: Chat) -> None:
        self.chat, self.lock = chat, threading.Lock()
        self.calls = self.input_tokens = self.output_tokens = 0

    def __call__(self, *args, **kwargs) -> dict:
        r = self.chat(*args, **kwargs)
        with self.lock:
            self.calls += 1
            self.input_tokens += r["input_tokens"]
            self.output_tokens += r["output_tokens"]
        return r


def answer(chat: Chat, target: str, question: str, salt: str) -> str:
    names = aliases(target)
    secret = names[0] + (f" (also called {', '.join(names[1:])})" if len(names) > 1 else "")
    r = chat([{"role": "system", "content": ANSWERER.format(target=secret)}, {"role": "user", "content": question}],
             temperature=0.0, max_tokens=3, salt=salt)
    return yes_no(r["text"])


def final_guess(chat: Chat, history, salt: str) -> str:
    r = chat([{"role": "user", "content": FINAL.format(history=_history(history))}],
             temperature=0.0, max_tokens=24, salt=salt)
    return (_lines(r["text"]) or [""])[0]


def likelihoods(chat: Chat, candidate: str, questions: Sequence[str], salt: str) -> Optional[List[float]]:
    """P(Yes | candidate, question) for each question, from one call; None if the reply is malformed."""
    if not questions:
        return []
    listed = "\n".join(f"{i + 1}. {q}" for i, q in enumerate(questions))
    r = chat([{"role": "user", "content": LIKELIHOOD.format(candidate=candidate, questions=listed)}],
             temperature=0.0, max_tokens=8 * len(questions) + 16, logprobs=True, salt=salt)
    return yes_probabilities(r, len(questions))


# ── the two arms ─────────────────────────────────────────────────────────────────────────────

def _finish(arm: str, target: str, history, solved_at, final: str, meter: Meter, model: str, **extra) -> dict:
    return {"arm": arm, "target": target, "solved_at": solved_at, "final_guess": final,
            "success": solved_at is not None or is_target(final, target), "questions": len(history),
            "transcript": [{"question": q, "answer": a} for q, a in history],
            "calls": meter.calls, "input_tokens": meter.input_tokens, "output_tokens": meter.output_tokens,
            "cost_usd": cost_usd(model, meter.input_tokens, meter.output_tokens), **extra}


def play_prompt_only(chat: Chat, target: str, game: str, model: str = "") -> dict:
    """The paper's Prompt-Only baseline: the model asks whatever it likes, one question per turn."""
    meter = Meter(chat)
    messages = [{"role": "user", "content": PROMPT_ONLY}]
    history: List[Tuple[str, str]] = []
    solved_at = None
    for turn in range(MAX_QUESTIONS):
        r = meter(messages, temperature=T_PROMPT_ONLY, max_tokens=80, salt=f"{game}/ask/{turn}")
        m = re.search(r"<question>(.*?)</question>", r["text"], re.S)
        if m is None:      # it stopped asking (e.g. it declared victory): remind it of the format, once
            retry = messages + [{"role": "assistant", "content": r["text"]}, {"role": "user", "content": NUDGE}]
            r2 = meter(retry, temperature=T_PROMPT_ONLY, max_tokens=80, salt=f"{game}/nudge/{turn}")
            m2 = re.search(r"<question>(.*?)</question>", r2["text"], re.S)
            if m2 is not None:
                messages, r, m = retry, r2, m2
        question = ((m.group(1) if m else r["text"]).strip().splitlines() or [""])[0].strip()
        reply = answer(meter, target, question, f"{game}/answer/{turn}")
        history.append((question, reply))
        messages += [{"role": "assistant", "content": r["text"]}, {"role": "user", "content": reply}]
        if reply == "Yes" and names_target(question, target):
            solved_at = turn + 1
            break
    return _finish("prompt", target, history, solved_at, final_guess(meter, history, f"{game}/final"), meter, model)


def _noisy(p_yes: float, belief: str) -> float:
    """The probability of a Yes that the belief uses: the model's own, or under --belief bayes, the model's
    with a LAPSE chance that the answer comes back the wrong way round."""
    return p_yes if belief == "filter" else LAPSE + (1.0 - 2.0 * LAPSE) * p_yes


def play_question_machine(chat: Chat, target: str, game: str, qm: QuestionMachine, model: str = "",
                          workers: int = 8, belief: str = "filter") -> dict:
    """The Question Machine: candidates weighed by the evidence, questions chosen by exact information gain."""
    meter = Meter(chat)
    history: List[Tuple[str, str]] = []
    alive: Dict[str, List[float]] = {}        # candidate -> the model's P(Yes) under it, for each past question
    guessed: set = set()                      # names already asked about with "Is it X?"
    turns: List[dict] = []
    solved_at, stop = None, None

    def loglik(c: str) -> float:
        return sum(math.log(max(_p(_noisy(p, belief), a), 1e-300)) for p, (_, a) in zip(alive[c], history))

    def weigh() -> Dict[str, float]:
        """Drop the candidates the evidence rules out, and return the belief over the rest."""
        nonlocal alive
        if belief == "filter":
            alive = {c: r for c, r in alive.items() if all(_p(p, a) >= FILTER for p, (_, a) in zip(r, history))}
            return {c: 1.0 / len(alive) for c in alive}
        if not alive:
            return {}
        ll = {c: loglik(c) for c in alive}
        best = max(ll.values())
        keep = sorted((c for c in alive if ll[c] >= best - PRUNE_NATS), key=lambda c: (-ll[c], c))[:N_CANDIDATES]
        alive = {c: alive[c] for c in keep}
        z = math.fsum(math.exp(ll[c] - best) for c in keep)
        return {c: math.exp(ll[c] - best) / z for c in keep}

    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        for turn in range(MAX_QUESTIONS):
            for attempt in range(SAMPLE_ATTEMPTS):      # top the candidates up to N
                if len(alive) >= N_CANDIDATES:
                    break
                r = meter([{"role": "user", "content": CANDIDATES.format(history=_history(history), n=N_CANDIDATES)}],
                          temperature=T_CANDIDATES, max_tokens=400, salt=f"{game}/candidates/{turn}/{attempt}")
                seen = {norm(c) for c in alive} | guessed
                new = []
                for c in _lines(r["text"]):
                    if norm(c) and norm(c) not in seen:
                        seen.add(norm(c))
                        new.append(c)
                new = new[:N_CANDIDATES - len(alive)]
                past = [q for q, _ in history]
                rows = list(pool.map(lambda c: likelihoods(meter, c, past, f"{game}/past/{turn}/{c}"), new))
                alive.update({c: row for c, row in zip(new, rows) if row is not None})
                weigh()
            weights = weigh()
            record = {"turn": turn + 1, "candidates": len(alive)}
            question, p_yes, top = None, {}, None
            if len(alive) >= 2:
                lines = _lines(meter([{"role": "user", "content": QUESTIONS.format(
                    history=_history(history), candidates=", ".join(alive), m=M_QUESTIONS)}],
                    temperature=T_QUESTIONS, max_tokens=600, salt=f"{game}/questions/{turn}")["text"])
                asked = {norm(q) for q, _ in history}
                proposed = []
                for q in lines:
                    if norm(q) and norm(q) not in asked and norm(q) not in {norm(x) for x in proposed}:
                        proposed.append(q if q.endswith("?") else q + "?")
                proposed = proposed[:M_QUESTIONS]
                names = list(alive)
                rows = list(pool.map(lambda c: likelihoods(meter, c, proposed, f"{game}/rows/{turn}/{c}"), names))
                scored = {c: row for c, row in zip(names, rows) if row is not None}
                record["unscored"] = len(names) - len(scored)       # malformed likelihood replies, dropped
                alive = {c: alive[c] for c in scored}
                weights = weigh()
                tables = {f"q{i}": {c: scored[c][i] for c in alive} for i in range(len(proposed))}
            else:
                proposed, tables = [], {}
            if alive:
                top = max(alive, key=lambda c: (loglik(c), c))     # the filter's belief is flat: rank by fit
                record.update(top=top, top_p=round(weights[top], 4))
                if norm(top) not in guessed and (belief == "bayes" or len(alive) == 1):
                    tables["g"] = {c: 1.0 if c == top else 0.0 for c in alive}     # a guess is a question too
                experiments = [Experiment(eid, 1.0, {c: {"yes": _noisy(p, belief), "no": 1.0 - _noisy(p, belief)}
                                                     for c, p in t.items()}, channel=CHANNEL)
                               for eid, t in tables.items()]
                if experiments:
                    sel = qm.ask_by_information(weights, experiments, budget=float(MAX_QUESTIONS - turn))
                    record.update(proposed=len(proposed), stop_reason=sel.stop_reason,
                                  blocked=[b[0] for b in sel.blocked])
                    if sel.selected is not None:
                        eid = sel.selected.experiment.experiment_id
                        question = f"Is it {top}?" if eid == "g" else proposed[int(eid[1:])]
                        p_yes = tables[eid]
                        record["bits"] = round(sel.selected.information_gain_bits, 4)
                    elif sel.stop_reason == "denied":
                        stop = "denied"
                        turns.append(record)
                        break
                if question is None and norm(top) not in guessed:      # resolved, or nothing informs: guess
                    question, p_yes = f"Is it {top}?", {c: 1.0 if c == top else 0.0 for c in alive}
            if question is not None and top is not None and question == f"Is it {top}?":
                record["guess"] = top
            if not qm.admits(CHANNEL)[0]:
                stop = "denied"
                turns.append(record)
                break
            if question is None:                # nothing left to weigh: ask what the model would ask unaided
                lines = _lines(meter([{"role": "user", "content": QUESTIONS.format(
                    history=_history(history), candidates="(none)", m=1)}],
                    temperature=T_QUESTIONS, max_tokens=80, salt=f"{game}/unaided/{turn}")["text"])
                question = lines[0] if lines else "Is it a mammal?"
                record["unaided"] = True
            reply = answer(meter, target, question, f"{game}/answer/{turn}")
            history.append((question, reply))
            alive = {c: alive[c] + [p_yes[c]] for c in alive if c in p_yes}
            if record.get("guess"):
                guessed.add(norm(record["guess"]))
                if not names_target(question, target) or reply != "Yes":
                    alive.pop(record["guess"], None)     # a guess that did not end the game is not asked again
            weigh()
            record.update(question=question, answer=reply, survivors=len(alive))
            turns.append(record)
            if reply == "Yes" and names_target(question, target):
                solved_at = turn + 1
                break
    belief_best = max(alive, key=lambda c: (loglik(c), c)) if alive else None
    return _finish("qm", target, history, solved_at, final_guess(meter, history, f"{game}/final"), meter, model,
                   turns=turns, stop=stop, belief=belief, belief_guess=belief_best,
                   belief_success=belief_best is not None and is_target(belief_best, target))


# ── the benchmark ────────────────────────────────────────────────────────────────────────────

def rescore(game: dict) -> dict:
    """A recorded game scored again under the current matching rules. A game ends at the first Yes to a
    question that names the target, so re-scoring a transcript is exact: the turns after it are moot."""
    target = game["target"]
    solved_at = next((i + 1 for i, t in enumerate(game["transcript"])
                      if t["answer"] == "Yes" and names_target(t["question"], target)), None)
    return {**game, "solved_at": solved_at, "questions": solved_at or len(game["transcript"]),
            "success": solved_at is not None or is_target(game["final_guess"], target)}


def paired(results: Dict[str, List[dict]], a: str = "qm", b: str = "prompt") -> Optional[dict]:
    """Per-target wins and losses of arm a over arm b, with an exact two-sided sign test on the
    discordant targets."""
    if a not in results or b not in results:
        return None
    by_b = {g["target"]: g["success"] for g in results[b]}
    wins = sum(1 for g in results[a] if g["success"] and not by_b.get(g["target"], True))
    losses = sum(1 for g in results[a] if not g["success"] and by_b.get(g["target"], False))
    n = wins + losses
    tail = sum(math.comb(n, k) for k in range(0, min(wins, losses) + 1)) / 2 ** n if n else 1.0
    return {"wins": wins, "losses": losses, "ties": len(results[a]) - n, "sign_test_p": round(min(1.0, 2 * tail), 4)}


def load_targets(path: pathlib.Path = TARGETS) -> List[str]:
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def summarize(results: Dict[str, List[dict]], model: str) -> Dict[str, dict]:
    out = {}
    for arm, games in results.items():
        n = len(games)
        if not n:
            continue
        p = sum(g["success"] for g in games) / n
        row = {"games": n, "success": round(p, 4), "se": round(math.sqrt(p * (1 - p) / n), 4),
               "solved_by_guess": round(sum(g["solved_at"] is not None for g in games) / n, 4),
               "mean_questions": round(sum(g["questions"] for g in games) / n, 2),
               "mean_calls": round(sum(g["calls"] for g in games) / n, 1),
               "cost_usd_per_game": cost_usd(model, sum(g["input_tokens"] for g in games) // n,
                                             sum(g["output_tokens"] for g in games) // n)}
        if arm == "qm":
            row["belief_success"] = round(sum(g["belief_success"] for g in games) / n, 4)
        out[arm] = row
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--games", type=int, default=30, help="targets drawn from the 100, without replacement")
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--arms", default="prompt,qm")
    ap.add_argument("--belief", choices=("filter", "bayes"), default="filter", help="the qm arm's belief update")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--parallel", type=int, default=3, help="games at once")
    ap.add_argument("--cache", type=pathlib.Path, default=CACHE)
    ap.add_argument("--offline", action="store_true", help="replay from the cache only; never call the API")
    ap.add_argument("--out", type=pathlib.Path, default=None, help="write every game and the summary here")
    ap.add_argument("--rescore", type=pathlib.Path, default=None,
                    help="score a written report again under the current matching rules, in place; no API calls")
    args = ap.parse_args()

    if args.rescore is not None:
        report = json.loads(args.rescore.read_text(encoding="utf-8"))
        report["results"] = {arm: [rescore(g) for g in games] for arm, games in report["results"].items()}
        report["summary"] = summarize(report["results"], report["model"])
        report["paired"] = paired(report["results"])
        args.rescore.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({k: report[k] for k in ("model", "summary", "paired", "bedllm_table1_animals")}, indent=2))
        return 0

    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    targets = random.Random(args.seed).sample(load_targets(), args.games)
    chat = OpenAIChat(args.model, args.cache, offline=args.offline)
    if not chat.key and not args.offline:
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        return 2
    qm = QuestionMachine()
    results: Dict[str, List[dict]] = {arm: [] for arm in arms}
    with cf.ThreadPoolExecutor(max_workers=args.parallel) as ex:
        jobs = {}
        for arm in arms:
            for target in targets:
                game = f"{args.seed}:{arm}:{target}" + (f":{args.belief}" if arm == "qm" else "")
                fn = (play_prompt_only, (chat, target, game, args.model)) if arm == "prompt" else \
                     (play_question_machine, (chat, target, game, qm, args.model, 8, args.belief))
                jobs[ex.submit(fn[0], *fn[1])] = arm
        for done, job in enumerate(cf.as_completed(jobs), 1):
            g = job.result()
            results[jobs[job]].append(g)
            print(f"[{done}/{len(jobs)}] {g['arm']:6s} {g['target']:<28s} {'solved' if g['success'] else 'missed':6s} "
                  f"in {g['questions']:2d}  final guess: {g['final_guess']}", flush=True)
    for games in results.values():
        games.sort(key=lambda g: targets.index(g["target"]))
    summary = summarize(results, args.model)
    spend = cost_usd(args.model, chat.usage["input_tokens"], chat.usage["output_tokens"])
    report = {"model": args.model, "games": args.games, "seed": args.seed, "belief": args.belief, "targets": targets,
              "summary": summary, "paired": paired(results), "bedllm_table1_animals": BEDLLM_ANIMALS.get(args.model),
              "this_run": {**chat.usage, "cost_usd": spend}, "results": results}
    print(json.dumps({k: report[k] for k in ("model", "summary", "bedllm_table1_animals", "this_run")}, indent=2))
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
