#!/usr/bin/env python3
"""
Render the Convergence Certificate's formula registry as SVG cards (docs/assets/cert/).

White card + dark text so each formula is readable on BOTH GitHub themes (transparent
backgrounds go invisible in dark mode). matplotlib mathtext only — no TeX install.
Re-run after editing FORMULAS; deterministic output, safe to commit.

    .venv-train python scripts/render_cert_formulas.py
"""
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = "docs/assets/cert"
INK = "#1a2332"

# (file-id, mathtext)  — titles/status live in the doc, not the image (theme + editability)
FORMULAS = [
    ("rho-gate",
     r"$\rho\,(J_F) < 1 \;\;\Rightarrow\;\; \exists!\,x^{*}:\ \lim_{t\to\infty} F^{\,t}(x) = x^{*}$"),
    ("kreiss",
     r"$\sup_{t \geq 0}\, \Vert A^{t} \Vert \;\leq\; e\,n\,\mathcal{K}(A)\,,"
     r"\qquad \theta_{canary} \;\mapsto\; \mathcal{K}(A)\cdot\theta_{canary}$"),
    ("m1-nofreeconf",
     r"$\Delta J_t \;\leq\; \eta\,\Delta E^{ext}_{t} \;-\; \lambda\,U_t\,,"
     r"\qquad \mathbb{E}\left[\,J_{t+1} \mid \mathcal{F}_t\,\right] \;\leq\; J_t$"),
    ("m2-eoq",
     r"$T^{*} \;=\; \sqrt{\;\frac{2\,\left(p_{verify}/p_{error}\right)}{\rho}\;}$"),
    ("m3-indist",
     r"$\exists\, P_{u}:\ \mathrm{TV}\!\left(M(P_{u}),\, M(P_{g})\right) < \epsilon"
     r"\quad \forall\, M \in \{M_{deg},\, M_{surp}\}$"),
    ("m5-waterfill",
     r"$b_i^{*} \;=\; \max\!\left(0,\ \frac{1}{\gamma_i}\,"
     r"\ln\frac{\gamma_i\, u_i}{\mu}\right),\qquad \sum_i b_i^{*} \;=\; B$"),
    ("m6-lasing",
     r"$\frac{G_m}{L_m} > 1 \;\wedge\; \kappa_m = 0 \;\;\Rightarrow\;\;"
     r" a_m(t) \,\sim\, e^{\,(G_m - L_m)\,t}$"),
    ("anytime-evalue",
     r"$\mathbb{E}\left[\,e_{\tau}\,\right] \leq 1\ \ \forall\,\tau"
     r"\;\;\Rightarrow\;\; P\!\left(\exists\, t:\ e_t \geq 1/\alpha \;\middle|\; H_0\right) \leq \alpha$"),
    ("basin-determinism",
     r"$q_1 \sim q_2\ \Rightarrow\ \Vert \Phi(h_{q_1}) - \Phi(h_{q_2}) \Vert"
     r" \;\leq\; c\,\Vert h_{q_1} - h_{q_2} \Vert,\ \ c<1\ \Rightarrow\ h^{*}_{q_1} = h^{*}_{q_2}$"),
    ("oracle-objective",
     r"$\max_{\pi}\ \mathbb{E}[\,\mathrm{coverage}\,]\quad \mathrm{s.t.}\ \ "
     r"P(\mathrm{assert} \mid \mathrm{false}) \leq \delta\,,\ \ \mathbb{E}[\mathrm{cost}] \leq B$"),
    ("fix-rate",
     r"$\mathrm{FR} \;=\; \frac{\left|\,fail{\rightarrow}pass\,\right| \;-\;"
     r" \beta\,\left|\,pass{\rightarrow}fail\,\right|}{n_{tests}}$"),
]


def render(fid, tex):
    fig = plt.figure(figsize=(9.2, 1.5))
    fig.patch.set_facecolor("white")
    fig.text(0.5, 0.5, tex, ha="center", va="center", fontsize=21, color=INK)
    path = os.path.join(OUT, f"{fid}.svg")
    fig.savefig(path, format="svg", bbox_inches="tight", pad_inches=0.30,
                facecolor="white", edgecolor="#d5dbe4")
    plt.close(fig)
    return path


def main():
    os.makedirs(OUT, exist_ok=True)
    for fid, tex in FORMULAS:
        try:
            p = render(fid, tex)
            print(f"ok  {p}")
        except Exception as e:  # a bad mathtext string should name itself, not kill the batch
            print(f"FAIL {fid}: {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
