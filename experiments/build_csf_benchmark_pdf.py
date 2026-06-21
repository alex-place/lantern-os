"""
Build the CSF Compression Benchmark PDF report (v3 — CSF-Omni vs the shipped zstd-19).

Honest baseline: CSF already ships zstd-19 (PR #835). This report measures the new
CSF-Omni best-fit codec against that current state, not the long-retired zlib. Every
number is from experiments/csf_compression_benchmark.py (round-trip verified lossless),
run on a worktree off origin/master. Claims are held to the Σ₀ External Reality Rule.

    PYTHONPATH=src python experiments/build_csf_benchmark_pdf.py
"""
from __future__ import annotations

import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, HRFlowable,
    PageBreak, KeepTogether,
)

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "experiments" / "results"
OUT_DIR.mkdir(parents=True, exist_ok=True)
PDF_PATH = OUT_DIR / "csf_compression_benchmark.pdf"

META = {"date": "2026-06-20", "python": "3.11.15", "zstd": "0.25.0", "brotli": "present",
        "cap": "4 MB / corpus", "base": "worktree off origin/master (v1.5.6)"}

# Verified, master-based data. rows: (codec, size, ratio).
CORPUS_A = {"title": "A. text + code (solid stream)", "raw": 3_071_098, "rows": [
    ("store",                       3_071_098, 1.00),
    ("zlib-9  [pre-#835, retired]",   938_803, 3.27),
    ("zstd-19  [CSF ships now]",      746_701, 4.11),
    ("brotli-11",                     726_462, 4.23),
    ("CSF-Omni  [NEW]",               726_469, 4.23),
]}
CORPUS_B = {"title": "B. JSONL append-only memory log  (the North-Star “Memory” object)",
            "raw": 4_194_304, "rows": [
    ("store",                       4_194_304,   1.00),
    ("zlib-9  [pre-#835, retired]",   296_200,  14.16),
    ("zstd-19  [CSF ships now]",       11_566, 362.64),
    ("brotli-11",                       9_937, 422.09),
    ("CSF-Omni  [NEW]",                 9_944, 421.79),
]}
CORPUS_C = {"title": "C. cube delta stream (3^12 lattice storage face)", "raw": 25_420, "rows": [
    ("store",                        25_420,  1.00),
    ("zlib-9  [pre-#835, retired]",   1_928, 13.18),
    ("zstd-19  [CSF ships now]",      1_586, 16.03),
    ("brotli-11",                     1_482, 17.15),
    ("CSF-Omni  [NEW]",               1_489, 17.07),
]}
# CSF-Pack archiver (340 files): master zstd default vs omni codec.
CSF_PACK = {"files": 340, "zstd_ratio": 2.69, "zstd_dict_ratio": 3.00, "omni_ratio": 3.06,
            "zstd_enc_ms": 1_163, "zstd_dict_enc_ms": 4_236, "omni_enc_ms": 31_468,
            "omni_vs_dict_pct": 2.0}

INK = colors.HexColor("#1f2430"); SLATE = colors.HexColor("#3a4254")
MUTED = colors.HexColor("#6b7280"); RED = colors.HexColor("#c0392b")
AMBER = colors.HexColor("#9a6a00"); AMBER_BG = colors.HexColor("#fdf3e0")
GREEN = colors.HexColor("#1e8449"); GREEN_BG = colors.HexColor("#e8f5e9")
HEAD_BG = colors.HexColor("#2c3340"); GRID = colors.HexColor("#d7dbe0"); ZEBRA = colors.HexColor("#f5f6f8")


def register_fonts():
    fdir = Path(matplotlib.__file__).parent / "mpl-data" / "fonts" / "ttf"
    pdfmetrics.registerFont(TTFont("DejaVu", str(fdir / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(fdir / "DejaVuSans-Bold.ttf")))
    pdfmetrics.registerFont(TTFont("DejaVu-Obl", str(fdir / "DejaVuSans-Oblique.ttf")))
    pdfmetrics.registerFont(TTFont("DejaVuMono", str(fdir / "DejaVuSansMono.ttf")))
    pdfmetrics.registerFontFamily("DejaVu", normal="DejaVu", bold="DejaVu-Bold",
                                  italic="DejaVu-Obl", boldItalic="DejaVu-Bold")


def _color_for(codec):
    if codec.startswith("CSF-Omni"):
        return "#1e8449"
    if codec.startswith("zstd-19"):
        return "#9a6a00"
    if codec.startswith("zlib-9"):
        return "#b0b6bf"
    return "#8a93a3"


def make_headline_chart():
    plt.rcParams["font.family"] = "DejaVu Sans"
    rows = [r for r in CORPUS_B["rows"] if r[0] != "store"]
    rows = sorted(rows, key=lambda r: r[2])
    labels = [r[0] for r in rows]
    ratios = [r[2] for r in rows]
    bcolors = [_color_for(r[0]) for r in rows]
    fig, ax = plt.subplots(figsize=(7.4, 2.9), dpi=200)
    y = range(len(labels))
    ax.barh(list(y), ratios, color=bcolors, height=0.62)
    ax.set_yticks(list(y)); ax.set_yticklabels(labels, fontsize=8.5)
    ax.set_xlabel("compression ratio vs raw  (higher = better)", fontsize=8.5)
    ax.set_title("Memory log (4 MB JSONL): zlib → zstd-19 (#835) → CSF-Omni",
                 fontsize=10.5, fontweight="bold", color="#1f2430", pad=10)
    for i, v in enumerate(ratios):
        ax.text(v + 6, i, f"{v:.0f}x", va="center", fontsize=8, fontweight="bold", color=bcolors[i])
    ax.set_xlim(0, max(ratios) * 1.16)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.tick_params(length=0); ax.grid(axis="x", color="#e3e6ea", linewidth=0.7); ax.set_axisbelow(True)
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(color="#1e8449", label="CSF-Omni (new, this work)"),
                       Patch(color="#9a6a00", label="zstd-19 (CSF ships now, #835)"),
                       Patch(color="#b0b6bf", label="zlib (retired)")],
              fontsize=7.5, loc="lower right", frameon=False)
    fig.tight_layout()
    p = OUT_DIR / "_chart_headline.png"; fig.savefig(p, bbox_inches="tight"); plt.close(fig)
    return p


def make_grouped_chart():
    plt.rcParams["font.family"] = "DejaVu Sans"

    def ratio(corpus, prefix):
        return next((r[2] for r in corpus["rows"] if r[0].startswith(prefix)), 0.0)

    corpora = [("A. text+code", CORPUS_A), ("B. JSONL memory", CORPUS_B), ("C. cube delta", CORPUS_C)]
    series = [("zstd-19  (CSF ships now)", "zstd-19", "#9a6a00"),
              ("CSF-Omni  (new)", "CSF-Omni", "#1e8449")]
    import numpy as np
    x = np.arange(len(corpora)); w = 0.34
    fig, ax = plt.subplots(figsize=(7.4, 2.9), dpi=200)
    for i, (label, prefix, col) in enumerate(series):
        vals = [ratio(c[1], prefix) for c in corpora]
        bars = ax.bar(x + (i - 0.5) * w, vals, w, label=label, color=col)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v * 1.05, f"{v:.0f}x",
                    ha="center", va="bottom", fontsize=8, fontweight="bold", color=col)
    ax.set_yscale("log"); ax.set_ylim(1, 900)
    ax.set_xticks(x); ax.set_xticklabels([c[0] for c in corpora], fontsize=9)
    ax.set_ylabel("ratio vs raw (log scale)", fontsize=8.5)
    ax.set_title("CSF-Omni vs the shipped zstd-19, per corpus (+2.8% / +16.3% / +6.5%)",
                 fontsize=10, fontweight="bold", color="#1f2430", pad=8)
    ax.legend(fontsize=8, loc="upper left", frameon=False)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.tick_params(length=0); ax.grid(axis="y", color="#e3e6ea", linewidth=0.7); ax.set_axisbelow(True)
    fig.tight_layout()
    p = OUT_DIR / "_chart_grouped.png"; fig.savefig(p, bbox_inches="tight"); plt.close(fig)
    return p


def styles():
    ss = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=ss["Title"], fontName="DejaVu-Bold", fontSize=18.5,
                                leading=22, textColor=INK, spaceAfter=2),
        "subtitle": ParagraphStyle("st", fontName="DejaVu", fontSize=10.3, leading=14, textColor=MUTED, spaceAfter=2),
        "h2": ParagraphStyle("h2", fontName="DejaVu-Bold", fontSize=12.5, leading=16, textColor=INK,
                             spaceBefore=12, spaceAfter=5),
        "body": ParagraphStyle("b", fontName="DejaVu", fontSize=9.6, leading=13.6, textColor=SLATE,
                               spaceAfter=5, alignment=TA_LEFT),
        "small": ParagraphStyle("sm", fontName="DejaVu", fontSize=8.2, leading=11, textColor=MUTED),
        "callout": ParagraphStyle("co", fontName="DejaVu", fontSize=10.2, leading=14.5, textColor=INK,
                                 leftIndent=8, spaceAfter=4),
        "cap": ParagraphStyle("cap", fontName="DejaVu-Obl", fontSize=8, leading=10.5, textColor=MUTED,
                             spaceBefore=2, spaceAfter=8),
    }


def result_table(corpus):
    data = [["codec", "size (B)", "ratio"]]
    for codec, size, ratio in corpus["rows"]:
        data.append([codec, f"{size:,}", f"{ratio:.2f}x"])
    t = Table(data, colWidths=[3.1 * inch, 1.5 * inch, 1.0 * inch], repeatRows=1)
    ts = [
        ("FONT", (0, 0), (-1, 0), "DejaVu-Bold", 8.2),
        ("FONT", (0, 1), (-1, -1), "DejaVuMono", 8),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.4), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 1), (-1, -2), 0.4, GRID), ("TEXTCOLOR", (0, 1), (-1, -1), SLATE),
    ]
    for i, (codec, _s, _r) in enumerate(corpus["rows"], start=1):
        ts.append(("FONT", (2, i), (2, i), "DejaVu-Bold", 8))
        if codec.startswith("CSF-Omni"):
            ts += [("BACKGROUND", (0, i), (-1, i), GREEN_BG), ("TEXTCOLOR", (0, i), (0, i), GREEN),
                   ("TEXTCOLOR", (2, i), (2, i), GREEN), ("FONT", (0, i), (0, i), "DejaVu-Bold", 8)]
        elif codec.startswith("zstd-19"):
            ts += [("BACKGROUND", (0, i), (-1, i), AMBER_BG), ("TEXTCOLOR", (0, i), (0, i), AMBER),
                   ("TEXTCOLOR", (2, i), (2, i), AMBER)]
        elif i % 2 == 0:
            ts.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    t.setStyle(TableStyle(ts))
    return t


def build():
    register_fonts()
    S = styles()
    headline = make_headline_chart()
    grouped = make_grouped_chart()
    doc = SimpleDocTemplate(str(PDF_PATH), pagesize=letter, leftMargin=0.7 * inch, rightMargin=0.7 * inch,
                            topMargin=0.62 * inch, bottomMargin=0.6 * inch,
                            title="CSF Compression Benchmark — Review v3", author="Lantern OS / Keystone")
    E = []

    def rule(space=6):
        return HRFlowable(width="100%", thickness=0.8, color=GRID, spaceBefore=space, spaceAfter=space)

    E.append(Paragraph("CSF Compression Benchmark — Review v3", S["title"]))
    E.append(Paragraph("CSF-Omni: a deterministic best-fit codec, measured against the shipped zstd-19 "
                       "(not the retired zlib)", S["subtitle"]))
    E.append(Paragraph(f"Run {META['date']} · python {META['python']} · zstd {META['zstd']} · "
                       f"brotli {META['brotli']} · cap {META['cap']} · base: {META['base']}", S["small"]))
    E.append(rule(8))

    E.append(Paragraph("Bottom line", S["h2"]))
    E.append(Paragraph(
        "<b>Honest baseline first:</b> CSF already swapped zlib → <font color='#9a6a00'><b>zstd-19 + "
        "long-distance matching</b></font> in PR #835, which is what lifted the memory log from "
        "<b>14×</b> to <b>363×</b>. That win is already shipped — not this work. "
        "This work adds <font color='#1e8449'><b>CSF-Omni</b></font>, an opt-in best-fit codec that runs the "
        "whole panel per blob, verifies each, and keeps the smallest behind a 7-byte CRC-checked header. "
        "It <b>beats the shipped zstd-19 on every corpus</b> — <b>+2.8% / +16.3% / +6.5%</b> per stream — by "
        "selecting the per-input best coder (brotli here), and adds corruption detection zstd's default frame "
        "lacks. (On the multi-file <i>archive</i> its edge shrinks to <b>+2%</b> vs zstd's shared-dictionary "
        "mode, at ~7× the encode — so the single-stream win is the durable one.) It is the <i>upper envelope</i>: it ties the "
        "frontier coder (brotli) and strictly beats every other codec; it does not beat brotli's raw bytes.",
        S["callout"]))
    E.append(Image(str(headline), width=6.9 * inch, height=2.7 * inch))
    E.append(Paragraph("Figure 1 — Memory-log ratio across CSF's three eras. The big jump (zlib→zstd) already "
                       "shipped in #835; CSF-Omni adds the green sliver on top by picking brotli. Lossless-verified.",
                       S["cap"]))

    E.append(Paragraph("What CSF-Omni adds over the shipped zstd-19", S["h2"]))
    for head, body in [
        ("Best-fit selection beats a fixed codec on every corpus.",
         "CSF-Omni runs store / zlib / bz2 / lzma / zstd / brotli (+ a byte transform), round-trip-verifies "
         "each, and keeps the smallest — deterministically (stable sort, identical bytes every run). Because "
         "the panel <i>includes</i> zstd, CSF-Omni is never worse than today's default and strictly beats it "
         "wherever another coder wins (brotli on all three corpora here)."),
        ("New codec option in CSF-Pack — <font face='DejaVuMono' size=8>codec=\"omni\"</font>.",
         "Slots alongside master's <font face='DejaVuMono' size=8>zstd / zlib / store</font>. On the 340-file "
         f"archive: <font color='#9a6a00'>zstd {CSF_PACK['zstd_ratio']:.2f}×</font>, "
         f"<font color='#9a6a00'>zstd+dict {CSF_PACK['zstd_dict_ratio']:.2f}×</font>, "
         f"<font color='#1e8449'><b>omni {CSF_PACK['omni_ratio']:.2f}×</b></font> — omni only "
         f"+{CSF_PACK['omni_vs_dict_pct']:.0f}% over zstd's dictionary mode (which already recovers most "
         "cross-file redundancy). zstd stays the default; omni is the opt-in max-ratio tier."),
        ("Integrity + portability the zstd default doesn't give.",
         "Omni's 7-byte header carries a CRC-32 of the original, so a corrupt payload <b>raises</b> instead of "
         "returning silently-wrong bytes. A <font face='DejaVuMono' size=8>portable=True</font> mode restricts "
         "to stdlib codecs so the blob decodes anywhere."),
    ]:
        E.append(Paragraph("▸ " + head, ParagraphStyle("fh", parent=S["body"], fontName="DejaVu-Bold",
                                                       textColor=INK, spaceAfter=1)))
        E.append(Paragraph(body, ParagraphStyle("fb", parent=S["body"], leftIndent=12, spaceAfter=7)))

    E.append(Paragraph("Results (all codecs lossless-verified; ratios vs raw)", S["h2"]))
    for corpus in (CORPUS_A, CORPUS_B, CORPUS_C):
        E.append(KeepTogether([
            Paragraph(f"{corpus['title']} — raw {corpus['raw']:,} B",
                      ParagraphStyle("ct", parent=S["body"], fontName="DejaVu-Bold", fontSize=9.6,
                                     textColor=INK, spaceBefore=8, spaceAfter=3)),
            result_table(corpus), Spacer(1, 3),
        ]))
    E.append(Paragraph(
        f"<b>Archiver (340 files), all lossless-verified:</b> "
        f"<font color='#9a6a00'>zstd {CSF_PACK['zstd_ratio']:.2f}× ({CSF_PACK['zstd_enc_ms']/1000:.1f}s)</font> · "
        f"<font color='#9a6a00'>zstd+dict {CSF_PACK['zstd_dict_ratio']:.2f}× ({CSF_PACK['zstd_dict_enc_ms']/1000:.1f}s)</font> · "
        f"<font color='#1e8449'><b>omni {CSF_PACK['omni_ratio']:.2f}× ({CSF_PACK['omni_enc_ms']/1000:.0f}s)</b></font> "
        f"— omni is only +{CSF_PACK['omni_vs_dict_pct']:.0f}% over zstd+dict at ~7× the encode. "
        f"&nbsp;<b>Per-stream dominance:</b> on each corpus CSF-Omni beats <b>8 of 9</b> codecs outright and "
        f"ties the champion brotli within its 7-byte header.", S["small"]))
    E.append(Spacer(1, 8))
    E.append(KeepTogether([
        Image(str(grouped), width=6.9 * inch, height=2.7 * inch),
        Paragraph("Figure 2 — CSF-Omni vs the shipped zstd-19 (log scale). A real but modest per-stream gain; "
                  "the headline 30× jump was the earlier zlib→zstd swap, not this.", S["cap"]),
    ]))

    E.append(Paragraph("Adversarially verified (6-agent fleet)", S["h2"]))
    E.append(Paragraph("Six independent agents each stress-tested one facet by running real code. Four passed; "
                       "two found real defects, fixed and re-verified:", S["body"]))
    for label, txt in [
        ("✓ Losslessness &amp; determinism", "3,817 checks over 318 adversarial inputs — 0 failures."),
        ("✓ Envelope / dominance", "Independently recomputed the panel: omni's payload equals the panel minimum on all three corpora."),
        ("✓ Backward-compat &amp; integrity", "v0.8 zstd/zlib/store archives still read; footer-digest tamper raises."),
        ("✓ Code review", "Delta transform proven exact-inverse; deterministic selection; no data-loss path."),
        ("⚠ → fixed: decode safety", "A corrupt brotli payload could decode to silently-wrong bytes → added the CRC-32 + a ValueError decode contract."),
        ("⚠ → fixed: honesty audit", "Flagged an over-claim ('strictly dominates any fixed codec') → reworded to the envelope framing this report uses."),
    ]:
        E.append(Paragraph(f"<b>{label}</b> — {txt}", ParagraphStyle("v", parent=S["body"], leftIndent=8,
                                                                     spaceAfter=4.5, fontSize=9.2, leading=12.6)))

    E.append(rule(8))
    E.append(Paragraph("Honest verdict &amp; trade-offs", S["h2"]))
    E.append(Paragraph(
        "&#8226; <b>Real but narrow gain:</b> CSF-Omni beats the shipped zstd-19 on every single stream "
        "(+2.8% / +16.3% / +6.5%); on the multi-file archive it is only +2% over zstd's shared-dictionary "
        "mode. The big numbers (14×→363× on the memory log) were the earlier zlib→zstd swap (#835), not this.<br/>"
        "&#8226; <b>It does not beat brotli:</b> on these corpora brotli is the frontier; omni <i>matches</i> it "
        "(payload-identical, +7-byte header). No available library (PPMd, paq) beats brotli — not fabricated.<br/>"
        "&#8226; <b>Encode cost is the catch:</b> the panel sweep makes the omni archiver ~31 s for 340 files vs "
        "~1 s (zstd) / ~4 s (zstd+dict). So it ships as an <b>opt-in max-ratio codec</b> for cold/archival packs; "
        "zstd stays the default for hot write paths. Decode is fast.<br/>"
        "&#8226; <b>Clean integration:</b> CSF-Omni is a new codec value in master's existing codec-field "
        "csf_pack (no second format). Built on a worktree off origin/master; CSF tests pass.", S["small"]))
    E.append(Spacer(1, 6))
    E.append(Paragraph("Reproduce: <font face='DejaVuMono' size=8>PYTHONPATH=src python "
                       "experiments/csf_compression_benchmark.py</font> — every codec round-trip verified "
                       "lossless before its number is kept.", S["small"]))

    doc.build(E)
    for p in (headline, grouped):
        try:
            os.remove(p)
        except OSError:
            pass
    return PDF_PATH


if __name__ == "__main__":
    out = build()
    print(f"WROTE {out}  ({out.stat().st_size:,} bytes)")
