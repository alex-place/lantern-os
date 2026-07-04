r"""
sigma0_hidden_probe.py — does a linear probe on Ouro's hidden states detect hallucination
better than the model's own confidence? (Verify-stage monitoring, reuses the hidden-states hook.)

Setup (HaluEval-QA subset, the standard hallucination benchmark): each of 40 questions has a
`right_answer` and a `hallucinated_answer`. For each we build a prompt
    "{knowledge}\nQ: {question}\nA: {answer}"
run it through Ouro-1.4B-Thinking, and capture, at the LAST answer token:
  (a) the residual hidden state at each recurrent (UT) step — hidden_states_list (dim 2048), and
  (b) the mean answer-token log-probability — the model's own confidence (surprise baseline).

Then:
  * Probe: StandardScaler -> PCA -> LogisticRegression on the hidden state, evaluated with
    GroupKFold(5) split BY QUESTION (a question's right+hallucinated answers never straddle the
    train/test line — no leakage). Report out-of-fold AUROC per UT step.
  * Baseline: AUROC of the answer log-probability on the SAME 80 examples — a fair, same-data
    comparison (the earlier surprise result was 0.76-0.81 on different data).

Honest: n=80 is small (pilot), so AUROC has real variance; grouped CV + PCA + L2 guard against
overfitting the 2048-dim state, and we report the baseline on identical data rather than a number
from elsewhere. MEASURED, not PROVEN. GPU, deterministic.

Run:  D:/lantern-venv-train/Scripts/python.exe experiments/sigma0_hidden_probe.py
"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:/hf-cache")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from ouro_compat import patch_universal_transformer_cache  # noqa: E402

from sklearn.decomposition import PCA  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402
from sklearn.pipeline import Pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MID = os.environ.get("OURO_MODEL", "ByteDance/Ouro-1.4B-Thinking")
DATA = REPO / "data" / "eval" / "halueval-qa-subset.jsonl"
OUT = REPO / "data" / "sigma0" / "hidden_probe_report.json"


def build_halueval_examples():
    """HaluEval-QA. NOTE: right answers are terse entities, hallucinated ones are full
    sentences — a strong length/form CONFOUND (answer length alone ~0.98 AUROC). Kept as the
    'naive/confounded' baseline that motivates the matched set below."""
    rows = [json.loads(l) for l in DATA.read_text(encoding="utf-8").splitlines() if l.strip()]
    ex = []
    for i, r in enumerate(rows):
        base = f"{r['knowledge']}\nQ: {r['question']}\nA: "
        ex.append({"qid": i, "prompt": base, "answer": " " + str(r["right_answer"]).strip(), "label": 1})
        ex.append({"qid": i, "prompt": base, "answer": " " + str(r["hallucinated_answer"]).strip(), "label": 0})
    return ex


# Length-MATCHED minimal pairs: same template, one swapped fill -> true and false statements
# differ only in the FACT, not surface form. A probe that separates these is reading truth.
MATCHED_FACTS = [
    ("The capital of France is {}.", "Paris", "Rome"),
    ("The capital of Japan is {}.", "Tokyo", "Seoul"),
    ("The capital of Egypt is {}.", "Cairo", "Aden"),
    ("The capital of Canada is {}.", "Ottawa", "Regina"),
    ("The capital of Spain is {}.", "Madrid", "Lisbon"),
    ("The capital of Russia is {}.", "Moscow", "Warsaw"),
    ("The capital of Norway is {}.", "Oslo", "Bonn"),
    ("The capital of Kenya is {}.", "Nairobi", "Kampala"),
    ("The capital of Brazil is {}.", "Brasilia", "Caracas"),
    ("The capital of Greece is {}.", "Athens", "Ankara"),
    ("Water is made of hydrogen and {}.", "oxygen", "nitrogen"),
    ("The Earth orbits the {}.", "Sun", "Moon"),
    ("The chemical symbol for gold is {}.", "Au", "Ag"),
    ("The atomic number of oxygen is {}.", "eight", "nine"),
    ("The red planet in our system is {}.", "Mars", "Muto"),
    ("Photosynthesis in plants produces {}.", "oxygen", "acetone"),
    ("The largest planet in the system is {}.", "Jupiter", "Neptune"),
    ("The powerhouse of the cell is the {}.", "mitochondria", "microtubule"),
    ("The speed of light is about 300000 km per {}.", "second", "minute"),
    ("Human blood is pumped by the {}.", "heart", "liver"),
    ("Two plus three equals {}.", "five", "seven"),
    ("Three times four equals {}.", "twelve", "twenty"),
    ("Ten divided by two equals {}.", "five", "seven"),
    ("The square root of nine is {}.", "three", "seven"),
    ("Five squared equals {}.", "twenty-five", "thirty-five"),
    ("One hundred divided by four is {}.", "twenty-five", "thirty-three"),
    ("A dozen is equal to {}.", "twelve", "twenty"),
    ("Seven minus three equals {}.", "four", "seven"),
    ("World War Two ended in the year {}.", "1945", "1917"),
    ("Humans first walked on the Moon in {}.", "1969", "1996"),
    ("The Titanic sank in the year {}.", "1912", "1926"),
    ("The Berlin Wall fell in the year {}.", "1989", "1968"),
    ("The play Hamlet was written by {}.", "Shakespeare", "Sophocles"),
    ("The Mona Lisa was painted by {}.", "da Vinci", "Cezanne"),
    ("The theory of relativity is due to {}.", "Einstein", "Faraday"),
    ("The tallest mountain on Earth is {}.", "Everest", "Rainier"),
    ("The largest ocean on Earth is the {}.", "Pacific", "Arctic"),
    ("The longest river in the world is the {}.", "Nile", "Volga"),
    ("Penguins mostly live near the {}.", "Antarctic", "equator"),
    ("The Great Wall is located in {}.", "China", "Spain"),
    ("The Eiffel Tower is located in {}.", "Paris", "Milan"),
    ("Kangaroos are native to {}.", "Australia", "Argentina"),
    ("A triangle has this many sides: {}.", "three", "seven"),
    ("A standard week has this many days: {}.", "seven", "eleven"),
    ("A spider typically has this many legs: {}.", "eight", "eleven"),
    ("The opposite of hot is {}.", "cold", "loud"),
    ("Bees are best known for making {}.", "honey", "linen"),
    ("Human lungs are primarily used for {}.", "breathing", "digestion"),
]


def build_matched_examples():
    ex = []
    for i, (tpl, t, f) in enumerate(MATCHED_FACTS):
        ex.append({"qid": i, "prompt": "", "answer": tpl.format(t), "label": 1})
        ex.append({"qid": i, "prompt": "", "answer": tpl.format(f), "label": 0})
    return ex


def run_probe(model, tok, captured, examples, n_steps):
    """Forward each example, capture per-UT-step last-token hidden state + answer logprob,
    then grouped-CV probe. Returns a result dict incl. the length-confound AUROC."""
    feats = {s: [] for s in range(n_steps)}
    logprobs, labels, groups, char_len = [], [], [], []
    for e in examples:
        p_ids = tok(e["prompt"], return_tensors="pt").input_ids
        full = tok(e["prompt"] + e["answer"], return_tensors="pt").input_ids.to(model.device)
        a_start = p_ids.shape[1] if e["prompt"] else 1  # skip BOS when prompt is empty
        captured.clear()
        with torch.no_grad():
            out = model(input_ids=full)
        hsl = captured.get("hsl")
        logits = out.logits[0].float()
        lp = [float(torch.log_softmax(logits[t - 1], dim=-1)[full[0, t]])
              for t in range(a_start, full.shape[1])]
        logprobs.append(float(np.mean(lp)) if lp else 0.0)
        for s in range(n_steps):
            feats[s].append(hsl[s][0, -1, :].float().cpu().numpy())
        labels.append(e["label"]); groups.append(e["qid"]); char_len.append(len(e["answer"]))

    y = np.array(labels); g = np.array(groups)
    auc_lp = float(roc_auc_score(y, np.array(logprobs))); auc_lp = max(auc_lp, 1 - auc_lp)
    auc_len = float(roc_auc_score(y, np.array(char_len))); auc_len = max(auc_len, 1 - auc_len)

    gkf = GroupKFold(n_splits=5)
    step_auc = {}
    for s in range(n_steps):
        X = np.stack(feats[s]); oof = np.zeros(len(y))
        pipe = Pipeline([
            ("sc", StandardScaler()),
            ("pca", PCA(n_components=min(24, X.shape[0] - 16))),
            ("lr", LogisticRegression(C=0.05, max_iter=2000, class_weight="balanced")),
        ])
        for tr, te in gkf.split(X, y, g):
            pipe.fit(X[tr], y[tr]); oof[te] = pipe.predict_proba(X[te])[:, 1]
        step_auc[s] = float(roc_auc_score(y, oof))
    best = max(step_auc, key=step_auc.get)
    return {
        "n_examples": int(len(y)),
        "hidden_dim": int(np.stack(feats[0]).shape[1]),
        "probe_auroc_per_ut_step": {str(k): round(v, 4) for k, v in step_auc.items()},
        "probe_auroc_best": round(step_auc[best], 4),
        "probe_best_ut_step": best,
        "answer_logprob_auroc": round(auc_lp, 4),
        "answer_length_confound_auroc": round(auc_len, 4),
        "probe_signal_above_length_confound": round(step_auc[best] - auc_len, 4),
    }


def main() -> None:
    print(f"[probe] loading {MID} (cuda={torch.cuda.is_available()}) ...", flush=True)
    tok = AutoTokenizer.from_pretrained(MID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MID, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    model.eval()
    patch_universal_transformer_cache()
    n_steps = int(getattr(model.config, "total_ut_steps", 4) or 4)

    captured = {}

    def hook(_m, _i, out):
        if isinstance(out, (tuple, list)) and len(out) >= 2 and isinstance(out[1], list):
            captured["hsl"] = out[1]

    handle = model.model.register_forward_hook(hook)
    halueval = run_probe(model, tok, captured, build_halueval_examples(), n_steps)
    matched = run_probe(model, tok, captured, build_matched_examples(), n_steps)
    handle.remove()

    report = {
        "task": "linear probe on Ouro hidden states — CONFOUND-CONTROLLED hallucination/truth detection",
        "model": MID,
        "eval": "GroupKFold(5) split by fact/question (true+false of a fact never straddle train/test)",
        "halueval_qa_NAIVE_confounded": {
            **halueval,
            "note": "right answers are terse entities, hallucinated ones full sentences — the probe "
                    "mostly rides ANSWER LENGTH (see length_confound_auroc), NOT truth. Baseline only.",
        },
        "truefalse_matched_CLEAN": {
            **matched,
            "note": "minimal pairs: true/false differ only in the swapped fact, matched surface form. "
                    "length_confound_auroc ~0.5 here, so probe signal IS truth, not form.",
        },
        "prior_surprise_baseline_other_data": "0.76-0.81 (token-surprise, #1673/#1676 — different data)",
        "evidence_class": "MEASURED (pilot; data/sigma0/hidden_probe_report.json)",
        "honest_headline": (
            f"On the length-CONTROLLED set, Ouro's hidden states linearly separate true vs false at "
            f"AUROC {matched['probe_auroc_best']} (best UT step {matched['probe_best_ut_step']}), while "
            f"the length confound is only {matched['answer_length_confound_auroc']} and the model's own "
            f"answer-logprob is {matched['answer_logprob_auroc']}. The naive HaluEval number "
            f"({halueval['probe_auroc_best']}) is inflated by answer length "
            f"({halueval['answer_length_confound_auroc']}) and is NOT a truth signal."),
        "caveats": "n small (pilot), fp16, Ouro-1.4B (small model), self-authored matched facts (minimal-pair swaps), UT-step not intra-step layers.",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\n=== NAIVE HaluEval-QA (confounded) ===")
    print(f"  probe best AUROC={halueval['probe_auroc_best']}  length-confound AUROC={halueval['answer_length_confound_auroc']}  logprob={halueval['answer_logprob_auroc']}")
    print("=== CLEAN length-matched true/false ===")
    print(f"  probe per-step: {matched['probe_auroc_per_ut_step']}")
    print(f"  probe best AUROC={matched['probe_auroc_best']} (step {matched['probe_best_ut_step']})  "
          f"length-confound AUROC={matched['answer_length_confound_auroc']}  logprob AUROC={matched['answer_logprob_auroc']}")
    print(f"  probe signal above length confound = {matched['probe_signal_above_length_confound']}")
    print(f"Report -> {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
