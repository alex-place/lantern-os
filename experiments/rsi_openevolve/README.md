# Three-arm recursive-self-improvement test on OpenEvolve

Does fresh, independent verification stop a recursive improver from corrupting its own
improvement process over many generations? The question, prediction and analysis are in
[PREREGISTRATION.md](PREREGISTRATION.md). The results are in [RESULTS.md](RESULTS.md).

## What is here

| File | Role |
|---|---|
| `rsi_oe/binpack.py`, `binpack_core.py` | Instance generator, online packer, exact scorer (bins saved vs best fit) |
| `rsi_oe/sandbox.py`, `sandbox_child.py` | Static checks + capped worker process for LLM-written code; parent re-verifies every packing |
| `rsi_oe/evaluation.py` | Cached scoring shared by all arms |
| `rsi_oe/improver.py` | MetaSkill-Evolve improver genome and slow loop; AlphaEvolve-style prompt co-evolution |
| `rsi_oe/gate.py` | Arm 3: fresh-task Σ_θ gate, burned pool, improver gate, prediction-error budget rule |
| `rsi_oe/loop.py` | One arm, one seed, built on OpenEvolve v0.4.0's database, prompt sampler, diff code and LLM client |
| `rsi_oe/successor.py` | Yang §13.2 equal-budget successor test, from snapshots |
| `rsi_oe/measure.py` | Holdout scoring, after the runs |
| `rsi_oe/analyze.py`, `plots.py` | The pre-registered tests, the results table, the figure |
| `rsi_oe/multi.py` | Run every (arm, seed) as a coroutine in one process, sharing the sandbox workers |
| `results.json`, `rsi_three_arms.svg` | The main run's analysis output and figure (raw run logs are not committed) |
| `tests/test_rsi_openevolve.py` | Offline tests (fake model, no network) |

## Run it

Dependencies are pinned in `requirements.txt` (OpenEvolve 0.4.0 is Apache-2.0). Use a
separate virtual environment:

```bash
uv venv .venv --python 3.11
uv pip install --python .venv -r experiments/rsi_openevolve/requirements.txt
```

The model key is read from the environment (`OPENAI_API_KEY` for the default
gpt-4o-mini). From `experiments/rsi_openevolve`:

```bash
python -m rsi_oe.multi loop --root runs/main --arms 1,2,3 --seeds 0,1,2,3,4 --gens 30
```

```bash
python -m rsi_oe.multi successor --root runs/main --test-gens 5,10,15,20,25,30
```

```bash
python -m rsi_oe.measure runs/main --workers 5
```

```bash
python -m rsi_oe.analyze runs/main
```

```bash
python -m rsi_oe.plots runs/main
```

Runs resume from `state.pkl` if interrupted. One process holds every run (about 0.5 GB),
and each run keeps its own `random` stream (tested). `python -m rsi_oe.loop` runs a
single arm and seed on its own.

A model call that still fails after the client's four retries counts as a spent call.
Eight failures in a row stop the run, which then resumes from its last finished
generation. The successor test records nothing for a group with a failed call, so
running it again asks again. Before this fix, an empty API account wrote failed calls
as invalid proposals (RESULTS.md, D1). The offline tests need no key:

```bash
python -m pytest tests/test_rsi_openevolve.py -q
```

## Sandbox boundary

The loop writes only inside its run directory. LLM-written code runs in a separate
interpreter that has no API keys in its environment and a 1 GiB memory cap. On Windows
it also may not start child processes, and it is killed on timeout. That code may import
only numpy and math. Code that touches dunder or frame attributes, file, pickle or random
APIs, or that assigns attributes of imported modules, is rejected before it runs. The
trusted parent recomputes every score from the returned packing.

Nothing in this phase acts outside that sandbox. Moving the loop onto software tasks
(`scripts/eval_swebench_chat.py`) would give it repository access, which needs an ADR
first.
