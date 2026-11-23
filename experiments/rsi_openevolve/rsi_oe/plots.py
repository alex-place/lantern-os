"""One figure for the write-up, from <root>/results.json (SVG by default, which git tracks).

Panels share the generation axis: (a) the champion's true score on the never-used
holdout, (b) the gap between the score it was accepted on and that holdout score,
(c) the successor test on shared reference parents. Colors are the dataviz reference
palette's first three categorical slots, validated all-pairs for colour-vision
deficiency; aqua is below 3:1 contrast on the surface, so each line also carries its
own marker and a direct label, and every number is in the results table.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
matplotlib.rcParams.update({"svg.fonttype": "none", "svg.hashsalt": "rsi-oe"})  # text stays text; stable ids
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402

SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
ARMS = {1: ("Arm 1 AlphaEvolve-style", "#2a78d6", "o"),
        2: ("Arm 2 MetaSkill-style", "#eb6834", "s"),
        3: ("Arm 3 fresh-gated", "#1baf7a", "^")}


def _style(ax, title, ylabel):
    ax.set_facecolor(SURFACE)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(INK2)
        ax.spines[s].set_linewidth(0.8)
    ax.tick_params(colors=INK2, labelsize=8)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.set_title(title, color=INK, fontsize=10, loc="left", pad=6)
    ax.set_ylabel(ylabel, color=INK2, fontsize=8)
    ax.axhline(0, color=INK2, linewidth=0.8, linestyle=(0, (2, 2)))


def _end_labels(ax, ends):
    """Direct labels at line ends, nudged apart vertically so overlapping lines stay legible."""
    if not ends:
        return
    fig = ax.figure
    fig.canvas.draw()
    px = [(arm, x, y, ax.transData.transform((x, y))[1]) for arm, x, y in ends]
    px.sort(key=lambda t: t[3])
    gap = 1.4 * 8 * fig.dpi / 72.0  # pixels between label centres: 1.4 lines of 8 pt text
    placed = []
    for arm, x, y, py in px:
        target = py if not placed else max(py, placed[-1] + gap)
        placed.append(target)
        dy_pt = (target - py) * 72.0 / fig.dpi
        ax.annotate(f"Arm {arm}", (x, y), xytext=(6, dy_pt), textcoords="offset points",
                    va="center", fontsize=8, color=INK,
                    bbox=dict(boxstyle="square,pad=0.1", fc=SURFACE, ec="none"))


def _curve(ax, summary, key):
    ends = []
    for arm, (name, color, marker) in ARMS.items():
        s = summary.get(str(arm))
        if not s:
            continue
        pts = [(c["gen"], c[key]["mean"], c[key]["lo"], c[key]["hi"]) for c in s["curve"]
               if c[key]["mean"] is not None]
        if not pts:
            continue
        g, m = [p[0] for p in pts], [p[1] for p in pts]
        ax.plot(g, m, color=color, linewidth=2, marker=marker, markersize=4, markevery=5,
                label=name, solid_capstyle="round")
        lo = [p[2] if p[2] is not None else p[1] for p in pts]
        hi = [p[3] if p[3] is not None else p[1] for p in pts]
        ax.fill_between(g, lo, hi, color=color, alpha=0.12, linewidth=0)
        ends.append((arm, g[-1], m[-1]))
    _end_labels(ax, ends)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("root")
    ap.add_argument("--out", default=None, help="output path, .svg or .png (default <root>/rsi_three_arms.svg)")
    a = ap.parse_args(argv)
    root = Path(a.root)
    res = json.loads((root / "results.json").read_text(encoding="utf-8"))
    summary = res["summary"]
    has_succ = any(s["variant"] == "ref_v_g" and s["q_per_1k_tokens"] is not None
                   for r in res["runs"] for s in r["successor"].values())
    n = 3 if has_succ else 2
    fig, axes = plt.subplots(n, 1, figsize=(7.2, 3.2 * n), dpi=150, sharex=True)
    fig.patch.set_facecolor(SURFACE)

    _style(axes[0], "a. Champion's true score on the never-used holdout",
           "Bins saved vs best fit (pp)\nmean, 95% CI over seeds")
    _curve(axes[0], summary, "holdout")
    axes[0].legend(frameon=False, fontsize=8, labelcolor=INK, loc="upper left")

    _style(axes[1], "b. Score the champion was accepted on, minus its holdout score",
           "Gap (pp)\nmean, 95% CI over seeds")
    _curve(axes[1], summary, "gap")

    if not has_succ:   # the successor test was not run to completion: two panels
        axes[1].xaxis.set_major_locator(MaxNLocator(integer=True))
        axes[1].set_xlabel("Generation (24 LLM calls each, every arm)", color=INK2, fontsize=8)
        return _save(fig, root, a.out)
    _style(axes[2], "c. Successor test on 8 shared reference parents (Yang §13.2)",
           "Kept improvement\nper 1k tokens")
    ends = []
    for arm, (name, color, marker) in ARMS.items():
        pts = {}
        for r in res["runs"]:
            if r["arm"] != arm:
                continue
            for s in r["successor"].values():
                if s["variant"] == "ref_v_g" and s["q_per_1k_tokens"] is not None:
                    pts.setdefault(s["gen"], []).append(s["q_per_1k_tokens"])
        if pts:
            g = sorted(pts)
            m = [sum(pts[x]) / len(pts[x]) for x in g]
            axes[2].plot(g, m, color=color, linewidth=2, marker=marker, markersize=6, label=name)
            ends.append((arm, g[-1], m[-1]))
    _end_labels(axes[2], ends)
    axes[2].xaxis.set_major_locator(MaxNLocator(integer=True))
    axes[2].set_xlabel("Generation (24 LLM calls each, every arm)", color=INK2, fontsize=8)
    return _save(fig, root, a.out)


def _save(fig, root: Path, out_arg) -> int:
    fig.tight_layout()
    out = Path(out_arg) if out_arg else root / "rsi_three_arms.svg"
    fig.savefig(out, facecolor=SURFACE, metadata={"Date": None} if out.suffix == ".svg" else None)
    print(f"figure -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
