"""
Validate that the Σ₀ Ouro Coder can actually perform coding tasks.

Loads Ouro-1.4B + the Σ₀ LoRA adapter, generates code for real tasks, then
EXECUTES the generated code against assertions. Empirical, not asserted.

    .venv-train/Scripts/python scripts/validate_ouro_coding.py
"""
import os, re, sys, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

ADAPTER = os.environ.get("OURO_ADAPTER", "D:/lantern-train/ouro-sigma0-adapters/final")

TASKS = [
    {"name": "is_prime", "fn": "is_prime",
     "prompt": "Write a Python function is_prime(n) that returns True if n is prime, else False. Output only the function code.",
     "checks": [("is_prime(2)", True), ("is_prime(17)", True), ("is_prime(1)", False), ("is_prime(15)", False)]},
    {"name": "reverse_string", "fn": "reverse_string",
     "prompt": "Write a Python function reverse_string(s) that returns the string reversed. Output only the function code.",
     "checks": [("reverse_string('abc')", "cba"), ("reverse_string('')", "")]},
    {"name": "fizz", "fn": "fizz",
     "prompt": "Write a Python function fizz(n) returning 'Fizz' if n divisible by 3, else str(n). Output only the function code.",
     "checks": [("fizz(3)", "Fizz"), ("fizz(4)", "4")]},
]

def extract_code(text, fn):
    """Fence-agnostic, compile-validated. The model rambles prose/markdown after the
    code (often without closing the fence), so we isolate the `def fn` block by
    indentation and accept the first candidate that actually compiles."""
    blocks = re.findall(r"```(?:python)?\s*(.*?)```", text, re.S)
    for c in blocks + [text]:           # fenced blocks first, then raw text
        i = c.find(f"def {fn}")
        if i < 0:
            continue
        lines = c[i:].splitlines()
        body = [lines[0]]               # the def line
        for ln in lines[1:]:            # + blank or indented lines = the body
            if ln.strip() == "" or ln[:1] in (" ", "\t"):
                body.append(ln)
            else:
                break                   # first column-0 prose line ends the function
        code = "\n".join(body).rstrip()
        try:
            compile(code, "<extracted>", "exec")
            return code                 # this candidate is syntactically valid Python
        except SyntaxError:
            continue
    return text                         # give up; exec will report the failure honestly

def run_task(model, t):
    out = model.generate(t["prompt"], q=0.5, max_new_tokens=256, mode="qexit")
    code = extract_code(out["text"], t["fn"])
    res = {"name": t["name"], "mean_depth": out["mean_depth"], "raw": out["text"][:300]}
    ns = {}
    try:
        exec(code, ns)
    except Exception as e:
        res.update(parsed=False, error=f"exec: {e}", passed=0, total=len(t["checks"]))
        return res
    passed = 0
    for expr, want in t["checks"]:
        try:
            got = eval(expr, ns)
            passed += int(got == want)
        except Exception as e:
            res.setdefault("errs", []).append(f"{expr}: {e}")
    res.update(parsed=True, passed=passed, total=len(t["checks"]))
    return res

def _preflight_ram(min_free_gb=3.0):
    """Turn the cryptic 'OSError 1455: paging file too small' (fp16 load of a 1.4B model
    on a RAM-starved box) into an actionable message BEFORE the load (#781 item 5).
    psutil-optional; override with OURO_FORCE_LOAD=1."""
    if os.environ.get("OURO_FORCE_LOAD") == "1":
        return
    try:
        import psutil
    except Exception:
        return  # guard is best-effort; don't add a hard dependency
    min_free_gb = float(os.environ.get("OURO_MIN_FREE_GB", min_free_gb))
    avail = psutil.virtual_memory().available / 1e9
    if avail < min_free_gb:
        print(f"ERROR: only {avail:.1f} GB RAM free; loading Ouro-1.4B (fp16) needs "
              f"~{min_free_gb:.0f} GB and will otherwise fail with 'OSError 1455: paging "
              f"file too small'.\nRemedies: free RAM, raise the Windows paging file, or "
              f"run on the GPU training box (.venv-train). Override: OURO_FORCE_LOAD=1.",
              file=sys.stderr, flush=True)
        sys.exit(2)


def main():
    _preflight_ram()
    from sigma0.loop_lm import Sigma0LoopLM
    print(f"Loading Ouro-1.4B + adapter={ADAPTER} ...", flush=True)
    m = Sigma0LoopLM.load("ByteDance/Ouro-1.4B", adapter=ADAPTER)
    print("Loaded. Running coding tasks...\n", flush=True)
    results, tot_p, tot_t = [], 0, 0
    for t in TASKS:
        r = run_task(m, t)
        results.append(r)
        tot_p += r["passed"]; tot_t += r["total"]
        flag = "OK " if r["passed"] == r["total"] else "x  "
        print(f"{flag} {r['name']:<16} {r['passed']}/{r['total']} pass  depth={r['mean_depth']}", flush=True)
        if not r.get("parsed"):
            print(f"      {r.get('error')}", flush=True)
    print(f"\nVERDICT: {tot_p}/{tot_t} assertions pass across {len(TASKS)} coding tasks", flush=True)
    print(json.dumps({"assertions_passed": tot_p, "assertions_total": tot_t,
                      "tasks": [{k: r[k] for k in ('name','passed','total','mean_depth','parsed')} for r in results]}))

if __name__ == "__main__":
    main()
