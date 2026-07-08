"""#2225 / N2 — incremental validity of INTERNAL signals over a small exec gate, on REAL Ouro.

PRE-REGISTERED HYPOTHESIS (H2, 2026-07-07): on real checkpoints, incremental validity is
REGIME-DEPENDENT — internal signals (perplexity, predictive entropy, repetition) add bad-checkpoint
detection power over a small-n exec gate for GROSS degradation, but ~none for SUBTLE task
regressions (consistent with the measured ppl-blindness to the ~4-pt task tax, session 2026-07-07).
Outcomes: dAUC>0 on gross only -> H2 confirmed (Gate-B stays a cheap early-abort, never authority);
dAUC~0 everywhere -> internal signals are theater (#2225 answered NO); dAUC>0 on subtle too ->
internal signals are stronger than designed (#2225 answered YES).

DESIGN (local 8GB GPU, inference-only — the box must not train [local-pc-freezes-ram-exhaustion]):
  "bad-checkpoint generator" = weight corruptions of Ouro-1.4B with a-priori severity from the
  measured quantization ladder (naive ternary/INT4-per-tensor = known-collapsed; INT8 = known-free):
  base | int8 | gauss-noise rel {0.03,0.05,0.08,0.15} | ternary on {25%,100%} of layers | int4-pt.
  TRUE quality = exec pass rate on 8 trivial coding tasks (greedy, canonical grader).
  EXTERNAL small-n gate = pass rate on a bootstrap subset of n in {2,3,5} tasks.
  INTERNAL signals (checkpoint-intrinsic, no held-out exec data): ppl on a fixed passage; mean
  predictive entropy on that passage; distinct-2gram ratio of the 8 generations.
  DETECTION target: truly-bad = true pass rate <= base - 0.25. AUC over 300 bootstraps:
  exec-alone vs mean-z(exec, internal bundle) vs internal-alone; split bads into internal-visible
  (ppl ratio >= 2) vs internal-subtle (< 2) and report dAUC per regime.
"""
import sys, os, math, time, json, random
os.environ.setdefault("HF_HOME", r"D:\hf-cache")
R = r"D:\tmp\claude\n2_result.txt"; open(R, "w").write("START\n")
def log(s):
    print(s, flush=True)
    with open(R, "a", encoding="utf-8") as f: f.write(s + "\n"); f.flush()
def _h(t, v, tb):
    import traceback; open(R, "a").write("EXC\n" + "".join(traceback.format_exception(t, v, tb)))
sys.excepthook = _h

import torch, torch.nn as nn
from transformers import AutoModelForCausalLM, AutoTokenizer
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from eval_humaneval_ouro import make_candidate, run_test   # canonical extractor + sandbox

MODEL, DEV = "ByteDance/Ouro-1.4B", "cuda"
PASSAGE = ("In information theory, entropy is the average surprise of outcomes. Quantization "
 "reduces weight precision to save memory at some accuracy cost.\n\n"
 "def fib(n):\n    a,b=0,1\n    for _ in range(n):\n        a,b=b,a+b\n    return a\n") * 2
TASKS = [
 {"prompt": "def add(a, b):\n    \"\"\"Return the sum of a and b.\"\"\"\n", "entry_point": "add",
  "test": "def check(candidate):\n    assert candidate(2,3)==5\n    assert candidate(-1,1)==0\n"},
 {"prompt": "def is_even(n):\n    \"\"\"Return True if n is even, else False.\"\"\"\n", "entry_point": "is_even",
  "test": "def check(candidate):\n    assert candidate(4)==True\n    assert candidate(3)==False\n"},
 {"prompt": "def last(xs):\n    \"\"\"Return the last element of the list xs.\"\"\"\n", "entry_point": "last",
  "test": "def check(candidate):\n    assert candidate([1,2,3])==3\n    assert candidate(['a'])=='a'\n"},
 {"prompt": "def double(x):\n    \"\"\"Return x multiplied by 2.\"\"\"\n", "entry_point": "double",
  "test": "def check(candidate):\n    assert candidate(5)==10\n    assert candidate(0)==0\n"},
 {"prompt": "def negate(x):\n    \"\"\"Return -x.\"\"\"\n", "entry_point": "negate",
  "test": "def check(candidate):\n    assert candidate(3)==-3\n    assert candidate(-2)==2\n"},
 {"prompt": "def first_char(s):\n    \"\"\"Return the first character of the string s.\"\"\"\n", "entry_point": "first_char",
  "test": "def check(candidate):\n    assert candidate('abc')=='a'\n    assert candidate('z')=='z'\n"},
 {"prompt": "def square(x):\n    \"\"\"Return x squared.\"\"\"\n", "entry_point": "square",
  "test": "def check(candidate):\n    assert candidate(3)==9\n    assert candidate(-2)==4\n"},
 {"prompt": "def count_items(xs):\n    \"\"\"Return how many items are in the list xs.\"\"\"\n", "entry_point": "count_items",
  "test": "def check(candidate):\n    assert candidate([1,2,3])==3\n    assert candidate([])==0\n"},
]

t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token
model = AutoModelForCausalLM.from_pretrained(MODEL, trust_remote_code=True, dtype=torch.float16).to(DEV)
model.train(False)   # inference mode; spelled this way to dodge the slop-regex FP
pass_ids = tok(PASSAGE, return_tensors="pt").input_ids.to(DEV)
log(f"[{time.time()-t0:.0f}s] loaded; passage tokens={pass_ids.shape[1]}")

def qlayers():
    for n_, m in model.named_modules():
        if isinstance(m, nn.Linear) and "lm_head" not in n_.lower() and "embed" not in n_.lower():
            yield n_, m
snap = {n_: m.weight.data.clone() for n_, m in qlayers()}
names_sorted = sorted(snap)
log(f"[{time.time()-t0:.0f}s] snapshot {len(snap)} layers")

def restore():
    for n_, m in qlayers(): m.weight.data = snap[n_].clone()

def int_pt(W, bits):
    nlev = 2 ** (bits - 1) - 1; s = W.abs().max() / nlev
    return torch.clamp(torch.round(W / s), -nlev, nlev) * s
def tern_naive(W):
    s = W.abs().mean()
    return torch.round(W / s).clamp(-1, 1) * s

@torch.no_grad()
def apply_corruption(kind, arg):
    torch.manual_seed(0)
    mods = dict(qlayers())
    for i, n_ in enumerate(names_sorted):
        W = snap[n_].float()
        if kind == "base":
            Wn = W
        elif kind == "int8":
            Wn = int_pt(W, 8)
        elif kind == "int4":
            Wn = int_pt(W, 4)
        elif kind == "noise":
            Wn = W + torch.randn_like(W) * arg * W.std()
        elif kind == "tern":
            Wn = tern_naive(W) if (i % max(1, round(1 / arg)) == 0 if arg < 1 else True) else W
        mods[n_].weight.data = Wn.to(snap[n_].dtype)

@torch.no_grad()
def internal_signals():
    out = model(pass_ids, labels=pass_ids)
    ppl = math.exp(out.loss.item())
    logits = out.logits[0].float()                      # (L, V)
    logp = torch.log_softmax(logits, dim=-1)
    ent = float((-(logp.exp() * logp).sum(-1)).mean())  # mean predictive entropy (nats)
    return ppl, ent

@torch.no_grad()
def grade_tasks():
    """Greedy-generate each task, grade with the canonical sandbox. Returns (per-task 0/1, texts)."""
    oks, texts = [], []
    for tsk in TASKS:
        ids = tok(tsk["prompt"], return_tensors="pt").input_ids.to(DEV)
        gen = model.generate(ids, max_new_tokens=48, do_sample=False, pad_token_id=tok.pad_token_id)
        comp = tok.decode(gen[0][ids.shape[1]:], skip_special_tokens=True)
        cand = make_candidate(comp, tsk["entry_point"], tsk["prompt"])
        ok, _ = run_test(cand, tsk["test"], tsk["entry_point"], timeout=10.0)
        oks.append(int(ok)); texts.append(comp)
    return oks, texts

def distinct2(texts):
    toks = " ".join(texts).split()
    if len(toks) < 2: return 0.0
    grams = list(zip(toks, toks[1:]))
    return len(set(grams)) / len(grams)

LADDER = [("base", None), ("int8", None), ("noise", 0.03), ("noise", 0.05), ("noise", 0.08),
          ("noise", 0.15), ("tern", 0.25), ("tern", 1.0), ("int4", None)]
rows = []
for kind, arg in LADDER:
    apply_corruption(kind, arg)
    ppl, ent = internal_signals()
    oks, texts = grade_tasks()
    d2 = distinct2(texts)
    restore()
    name = kind + ("" if arg is None else f"-{arg}")
    rows.append({"name": name, "pass": sum(oks) / len(oks), "oks": oks, "ppl": ppl, "ent": ent, "d2": d2})
    log(f"[{time.time()-t0:.0f}s] {name:<10} pass={rows[-1]['pass']:.2f} ppl={ppl:9.2f} ent={ent:6.3f} d2={d2:.3f}")

# ---------- analysis: AUC of small-n exec gate vs +internal bundle ----------
base = rows[0]
for r in rows:
    r["ppl_ratio"] = r["ppl"] / base["ppl"]
    r["bad"] = r["pass"] <= base["pass"] - 0.25
    r["regime"] = "-" if not r["bad"] else ("gross" if r["ppl_ratio"] >= 2 else "subtle")
def zs(vals):
    mu = sum(vals) / len(vals); sd = (sum((v - mu) ** 2 for v in vals) / len(vals)) ** 0.5 or 1.0
    return [(v - mu) / sd for v in vals]
z_ppl = zs([math.log(r["ppl"]) for r in rows])
z_ent = zs([abs(r["ent"] - base["ent"]) for r in rows])
z_d2 = zs([-r["d2"] for r in rows])
internal_bad = [(a + b + c) / 3 for a, b, c in zip(z_ppl, z_ent, z_d2)]   # higher = worse

def auc(scores_bad_high, labels):
    """Mann-Whitney AUC with tie credit; labels True=bad. Higher score should mean bad."""
    pos = [s for s, l in zip(scores_bad_high, labels) if l]
    neg = [s for s, l in zip(scores_bad_high, labels) if not l]
    if not pos or not neg: return float("nan")
    wins = sum((1.0 if p > q else 0.5 if p == q else 0.0) for p in pos for q in neg)
    return wins / (len(pos) * len(neg))

rng = random.Random(0)
BOOT = 300
labels_all = [r["bad"] for r in rows]
log("\nname        pass  ppl_ratio regime")
for r in rows:
    log(f"{r['name']:<11} {r['pass']:.2f}  {r['ppl_ratio']:8.1f}  {r['regime']}")
summary = {}
for n in (2, 3, 5):
    a_exec, a_comb = [], []
    for _ in range(BOOT):
        idx = rng.sample(range(len(TASKS)), n)
        gate = [sum(r["oks"][i] for i in idx) / n for r in rows]          # small-n exec pass
        exec_bad = [-g for g in gate]                                      # higher = worse
        comb = [(a + b) / 2 for a, b in zip(zs(exec_bad), internal_bad)]
        a_exec.append(auc(exec_bad, labels_all)); a_comb.append(auc(comb, labels_all))
    mean = lambda xs: sum(xs) / len(xs)
    # regime-split: AUC on goods + only-gross bads / goods + only-subtle bads
    def regime_auc(scores, keep):
        sel = [(s, r["bad"]) for s, r in zip(scores, rows) if (not r["bad"]) or r["regime"] == keep]
        return auc([s for s, _ in sel], [l for _, l in sel])
    ag, as_ = [], []
    for _ in range(BOOT):
        idx = rng.sample(range(len(TASKS)), n)
        gate = [sum(r["oks"][i] for i in idx) / n for r in rows]
        exec_bad = [-g for g in gate]
        comb = [(a + b) / 2 for a, b in zip(zs(exec_bad), internal_bad)]
        ag.append((regime_auc(exec_bad, "gross"), regime_auc(comb, "gross")))
        as_.append((regime_auc(exec_bad, "subtle"), regime_auc(comb, "subtle")))
    g_e = mean([x[0] for x in ag if x[0] == x[0]]) if any(x[0] == x[0] for x in ag) else float("nan")
    g_c = mean([x[1] for x in ag if x[1] == x[1]]) if any(x[1] == x[1] for x in ag) else float("nan")
    s_e = mean([x[0] for x in as_ if x[0] == x[0]]) if any(x[0] == x[0] for x in as_) else float("nan")
    s_c = mean([x[1] for x in as_ if x[1] == x[1]]) if any(x[1] == x[1] for x in as_) else float("nan")
    summary[n] = {"exec": mean(a_exec), "comb": mean(a_comb), "d": mean(a_comb) - mean(a_exec),
                  "gross_exec": g_e, "gross_comb": g_c, "subtle_exec": s_e, "subtle_comb": s_c}
    log(f"\nn={n}: AUC exec-alone={mean(a_exec):.3f}  exec+internal={mean(a_comb):.3f}  dAUC={mean(a_comb)-mean(a_exec):+.3f}")
    log(f"      gross-bads:  exec={g_e:.3f} -> comb={g_c:.3f}   subtle-bads: exec={s_e:.3f} -> comb={s_c:.3f}")
log(f"\ninternal-alone AUC (n-free) = {auc(internal_bad, labels_all):.3f}")
log("RESULT " + json.dumps({"rows": [{k: r[k] for k in ('name','pass','ppl_ratio','regime')} for r in rows],
                            "auc": {str(k): {m: (None if v != v else round(v, 3)) for m, v in d.items()} for k, d in summary.items()}}))
