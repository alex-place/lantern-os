"""Offline tests for the 20 Questions harness (experiments/question_machine_20q.py).

A fake model plays every role over a world of eight animals and six yes/no features, so the game logic,
the information-gain choice, NAP gating, the cache and the scoring are tested without any API call.

Run:  python -m pytest tests/test_question_machine_20q.py -q
"""
import importlib.util
import math
import pathlib
import re

import pytest

pytest.importorskip("torch")

_PATH = pathlib.Path(__file__).resolve().parents[1] / "experiments" / "question_machine_20q.py"
_spec = importlib.util.spec_from_file_location("question_machine_20q", _PATH)
bench = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bench)

from cio_sde.question import QuestionMachine  # noqa: E402

FEATURES = {"mammal": "Is it a mammal?", "flies": "Can it fly?", "water": "Does it live in water?",
            "big": "Is it bigger than a human?", "stripes": "Does it have stripes?", "meat": "Does it eat meat?"}
WORLD = {   # mammal, flies, water, big, stripes, meat: four mammals and four not, so "mammal" is a 1-bit split
    "Gray wolf": (1, 0, 0, 0, 0, 1), "Bengal tiger": (1, 0, 0, 1, 1, 1), "Blue whale": (1, 0, 1, 1, 0, 1),
    "Zebra": (1, 0, 0, 1, 1, 0), "Bald eagle": (0, 1, 0, 0, 0, 1), "Great white shark": (0, 0, 1, 1, 0, 1),
    "Clownfish": (0, 0, 1, 0, 1, 0), "Garter snake": (0, 0, 0, 0, 1, 1),
}


def truth(animal, question):
    for i, q in enumerate(FEATURES.values()):
        if question == q:
            return bool(WORLD[animal][i])
    m = re.match(r"^is it (?:an? )?(.+?)\?$", question.strip(), re.I)
    return bool(m) and bench.norm(m.group(1)) == bench.norm(animal)


def _parse_history(text):
    return [(m.group(1), m.group(2)) for m in re.finditer(r"^\d+\. (.+\?) (Yes|No)$", text, re.M)]


def _consistent(history):
    return [a for a in WORLD if all(truth(a, q) == (ans == "Yes") for q, ans in history)]


class FakeChat:
    """Plays every role from WORLD, answering the likelihood prompt with Yes/No log-probabilities of 0.97."""

    def __init__(self):
        self.calls = 0

    def __call__(self, messages, *, temperature, max_tokens, logprobs=False, salt=""):
        self.calls += 1
        first = messages[0]["content"]
        text, tokens = "", []
        if messages[0]["role"] == "system":                                   # the answerer
            target = re.search(r"The secret animal is: (.+?)\. Answer", first).group(1)
            text = "Yes" if truth(target, messages[1]["content"]) else "No"
        elif first == bench.PROMPT_ONLY:                                       # the free questioner
            history = [(re.search(r"<question>(.*)</question>", a["content"]).group(1), u["content"])
                       for a, u in zip(messages[1::2], messages[2::2])]
            left = _consistent(history)
            unasked = [q for q in FEATURES.values() if q not in {h for h, _ in history}]
            q = unasked[0] if len(left) > 1 and unasked else f"Is it {left[0]}?"
            text = f"<question>{q}</question>"
        elif first.startswith("You are playing a game of 20 Questions about a secret animal. Using"):
            text = "\n".join(_consistent(_parse_history(first)))
        elif first.startswith("You are playing 20 Questions about a secret animal. The questions"):
            asked = {q for q, _ in _parse_history(first)}
            text = "\n".join(q for q in FEATURES.values() if q not in asked)
        elif first.startswith("We are playing 20 Questions. The secret animal is:"):
            candidate = re.search(r"The secret animal is: (.+?)\.\n", first).group(1)
            questions = re.findall(r"^\d+\. (.+)$", first.split("\n\n", 1)[1], re.M)
            lines = []
            for i, q in enumerate(questions, 1):
                yes = truth(candidate, q)
                lines.append(f"{i}: {'Yes' if yes else 'No'}")
                top = {" Yes": math.log(0.97 if yes else 0.03), " No": math.log(0.03 if yes else 0.97)}
                tokens += [[str(i), {}], [":", {}], [" Yes" if yes else " No", top], ["\n", {}]]
            text = "\n".join(lines)
        elif first.startswith("These are the questions asked so far"):
            left = _consistent(_parse_history(first))
            text = left[0] if left else "Unknown"
        else:
            raise AssertionError(f"unexpected prompt: {first[:80]}")
        return {"text": text, "tokens": tokens, "input_tokens": len(first) // 4, "output_tokens": len(text) // 4}


class _Deny:
    def __init__(self, channel):
        self.channel = channel

    def check(self, action_type, tier=None):
        return type("R", (), {"denied": action_type == self.channel, "reason": "off limits"})()


@pytest.mark.parametrize("belief", ["bayes", "filter"])
@pytest.mark.parametrize("target", list(WORLD))
def test_the_question_machine_finds_every_animal_with_splitting_questions(target, belief):
    game = bench.play_question_machine(FakeChat(), target, f"t:{target}", QuestionMachine(), workers=2, belief=belief)
    assert game["success"] and game["solved_at"] is not None and game["solved_at"] <= 6
    first = game["turns"][0]
    assert first["question"] == "Is it a mammal?"            # the first of three even 4/4 splits
    # a 4/4 split is worth 1 - H(answer error): 0.81 bits for the fake's 3%, 0.72 with the 2% lapse on top
    assert first["bits"] == pytest.approx(0.8056 if belief == "filter" else 0.7186, abs=1e-3)
    assert game["belief_success"] and game["final_guess"] == target
    assert all(t.get("unscored", 0) == 0 for t in game["turns"])


def test_a_guess_that_fails_is_never_asked_again():
    game = bench.play_question_machine(FakeChat(), "Garter snake", "t:once", QuestionMachine(), workers=2)
    guesses = [t["guess"] for t in game["turns"] if "guess" in t]
    assert len(guesses) == len(set(guesses)) and guesses[-1] == "Garter snake"


def test_the_prompt_only_baseline_is_played_and_scored_the_same_way():
    game = bench.play_prompt_only(FakeChat(), "Zebra", "t:zebra")
    assert game["success"] and game["transcript"][-1] == {"question": "Is it Zebra?", "answer": "Yes"}
    assert game["calls"] > 0 and game["cost_usd"] is None             # no model name, no price


def test_a_denied_channel_stops_the_machine_before_it_asks():
    qm = QuestionMachine(authority_gate=_Deny(bench.CHANNEL))
    game = bench.play_question_machine(FakeChat(), "Zebra", "t:denied", qm, workers=2)
    assert game["stop"] == "denied" and game["questions"] == 0
    assert game["turns"][0]["stop_reason"] == "denied" and len(game["turns"][0]["blocked"]) > 0


def test_answer_probabilities_come_from_the_answer_tokens():
    top_yes = {" Yes": math.log(0.8), " No": math.log(0.2)}
    r = {"tokens": [["1", {}], [":", {}], [" Yes", top_yes], ["\n", {}], ["2", {}], [":", {}], [" No", {" No": 0.0}]]}
    assert bench.yes_probabilities(r, 2) == pytest.approx([0.8, math.exp(-30.0)], abs=1e-9)
    assert bench.yes_probabilities(r, 3) is None                       # a malformed reply is not guessed at


def test_names_are_matched_after_normalising_including_listed_aliases():
    assert bench.names_target("Is it a grey wolf?", "Gray wolf")
    assert bench.names_target("is it the Bengal Tigers", "Bengal tiger")
    assert not bench.names_target("Is it a mammal?", "Gray wolf")
    assert not bench.names_target("Is it a wolf?", "Gray wolf")         # a category is not the animal
    assert bench.names_target("Is the animal you are thinking of a moose?", "Moose")   # the baseline's phrasing
    assert bench.names_target("Are you thinking of an Arctic fox?", "Arctic fox")
    assert not bench.names_target("Is the animal you are thinking of a mammal?", "Moose")
    frog = "Red-eyed tree frog | Redeyed tree frog"                     # how the list writes alternatives
    assert bench.aliases(frog) == ["Red-eyed tree frog", "Redeyed tree frog"]
    assert bench.names_target("Is it Red-eyed Tree Frog?", frog) and bench.is_target("redeyed tree frogs", frog)


def test_the_answerer_is_told_the_name_and_its_aliases():
    seen = []

    def chat(messages, **kw):
        seen.append(messages[0]["content"])
        return {"text": "Yes", "tokens": [], "input_tokens": 1, "output_tokens": 1}

    assert bench.answer(chat, "Red-eyed tree frog | Redeyed tree frog", "Is it a frog?", "s") == "Yes"
    assert "The secret animal is: Red-eyed tree frog (also called Redeyed tree frog)." in seen[0]


def test_a_baseline_that_stops_asking_is_reminded_of_the_format_once():
    replies = iter(["Great! It is a zebra.", "<question>Is it Zebra?</question>"])

    def chat(messages, **kw):
        if messages[0]["role"] == "system":
            return {"text": "Yes", "tokens": [], "input_tokens": 1, "output_tokens": 1}
        if messages[0]["content"].startswith("These are the questions"):
            return {"text": "Zebra", "tokens": [], "input_tokens": 1, "output_tokens": 1}
        return {"text": next(replies), "tokens": [], "input_tokens": 1, "output_tokens": 1}

    game = bench.play_prompt_only(chat, "Zebra", "t:nudge")
    assert game["solved_at"] == 1 and game["transcript"] == [{"question": "Is it Zebra?", "answer": "Yes"}]


def test_the_cache_replays_a_call_and_offline_refuses_new_ones(tmp_path, monkeypatch):
    posts = []

    def fake_post(self, body):
        posts.append(body)
        return {"text": "Yes", "tokens": [], "input_tokens": 10, "output_tokens": 1}

    monkeypatch.setattr(bench.OpenAIChat, "_post", fake_post)
    cache = tmp_path / "c.jsonl"
    chat = bench.OpenAIChat("gpt-4o-mini", cache)
    msg = [{"role": "user", "content": "hi"}]
    assert chat(msg, temperature=0.0, max_tokens=3, salt="a") == chat(msg, temperature=0.0, max_tokens=3, salt="a")
    chat(msg, temperature=0.0, max_tokens=3, salt="b")                 # another game: a fresh call
    assert len(posts) == 2 and chat.usage["cached"] == 1 and chat.usage["calls"] == 2
    replay = bench.OpenAIChat("gpt-4o-mini", cache, offline=True)
    assert replay(msg, temperature=0.0, max_tokens=3, salt="b")["text"] == "Yes"
    with pytest.raises(RuntimeError, match="offline"):
        replay(msg, temperature=0.0, max_tokens=3, salt="c")


def test_rescoring_ends_a_recorded_game_at_its_first_confirmed_guess():
    game = {"target": "Moose", "final_guess": "North American moose", "transcript": [
        {"question": "Is it a mammal?", "answer": "Yes"},
        {"question": "Is the animal you are thinking of a moose?", "answer": "Yes"},
        {"question": "Is it native to Alaska?", "answer": "Yes"}]}
    again = bench.rescore(game)
    assert again["solved_at"] == 2 and again["questions"] == 2 and again["success"]
    missed = bench.rescore({**game, "transcript": game["transcript"][:1]})
    assert missed["solved_at"] is None and not missed["success"]    # "North American moose" is not "Moose"


def test_the_paired_sign_test_counts_only_discordant_targets():
    qm = [{"target": t, "success": s} for t, s in [("a", True), ("b", True), ("c", False), ("d", True)]]
    prompt = [{"target": t, "success": s} for t, s in [("a", False), ("b", True), ("c", True), ("d", False)]]
    out = bench.paired({"qm": qm, "prompt": prompt})
    assert (out["wins"], out["losses"], out["ties"]) == (2, 1, 1) and out["sign_test_p"] == 1.0


def test_the_summary_reports_success_with_its_standard_error():
    games = [bench.play_question_machine(FakeChat(), t, f"s:{t}", QuestionMachine(), workers=2)
             for t in ("Zebra", "Clownfish")]
    out = bench.summarize({"qm": games}, "gpt-4o-mini")["qm"]
    assert out["games"] == 2 and out["success"] == 1.0 and out["se"] == 0.0 and out["belief_success"] == 1.0
    assert out["cost_usd_per_game"] is not None
    assert bench.load_targets()[:2] == ["African elephant", "Bengal tiger"] and len(bench.load_targets()) == 100
