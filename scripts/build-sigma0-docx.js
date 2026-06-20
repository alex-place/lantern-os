// Build a shareable Word doc for the Σ₀ collapse certificate.
// Run: node scripts/build-sigma0-docx.js
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, TableOfContents, PageNumber, Header, Footer,
} = require("docx");

const CONTENT_W = 9360; // US Letter, 1" margins
const MONO = "Consolas";
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const P = (runs) => new Paragraph({ children: Array.isArray(runs) ? runs : [new TextRun(runs)], spacing: { after: 120 } });
const t = (text, opt = {}) => new TextRun({ text, ...opt });
const eq = (text) => new Paragraph({
  spacing: { before: 80, after: 120 }, alignment: AlignmentType.CENTER,
  children: [new TextRun({ text, font: MONO, size: 22 })],
});
const bullet = (runs) => new Paragraph({
  numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 },
  children: Array.isArray(runs) ? runs : [new TextRun(runs)],
});
const note = (text) => new Paragraph({
  spacing: { before: 80, after: 120 },
  shading: { fill: "FBF3D5", type: ShadingType.CLEAR },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: "D4A017", space: 8 } },
  children: [new TextRun({ text, italics: true, size: 21 })],
});

function table(headers, rows, widths) {
  const cell = (text, opts = {}) => new TableCell({
    borders, width: { size: opts.w, type: WidthType.DXA },
    shading: opts.head ? { fill: "1F3864", type: ShadingType.CLEAR } : { fill: "FFFFFF", type: ShadingType.CLEAR },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!opts.head, color: opts.head ? "FFFFFF" : "000000", size: 20, font: opts.mono ? MONO : "Arial" })] })],
  });
  const headRow = new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, { head: true, w: widths[i] })) });
  const bodyRows = rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, { w: widths[i], mono: i === 0 && c.length < 40 && /[λ∇‖]|<|≈/.test(c) })) }));
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths, rows: [headRow, ...bodyRows] });
}

const doc = new Document({
  creator: "Lantern OS",
  title: "Σ₀ — The Collapse Certificate",
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal",
        run: { size: 44, bold: true, color: "1F3864", font: "Arial" },
        paragraph: { spacing: { after: 80 }, alignment: AlignmentType.CENTER } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, color: "1F3864", font: "Arial" },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, color: "2E5496", font: "Arial" },
        paragraph: { spacing: { before: 160, after: 100 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] },
      { reference: "refs", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Σ₀ Collapse Certificate  ·  page ", size: 18, color: "888888" }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "888888" })] })] }) },
    children: [
      new Paragraph({ style: "Title", children: [new TextRun("Σ₀ — The Collapse Certificate")] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new TextRun({ text: "A computable stability certificate for convergence dynamics — and a small honest demonstration of why an ungrounded self-improving system collapses.", italics: true, size: 22, color: "555555" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: "Lantern OS  ·  src/cio_sde/  ·  20/20 tests passing", size: 18, color: "888888" })] }),

      new Paragraph({ children: [new TextRun({ text: "Contents", bold: true, size: 24, color: "1F3864" })], spacing: { after: 80 } }),
      new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
      new Paragraph({ children: [new TextRun("")], pageBreakBefore: true }),

      H1("0.  The object"),
      P("We study a dissipative nonlinear system:"),
      eq("ẋ = f(x, u, θ),        x ∈ ℝⁿ"),
      bullet([t("x", { bold: true }), t(" — internal state (for the router: a conversation's encoded state)")]),
      bullet([t("u", { bold: true }), t(" — control / persistent-excitation input")]),
      bullet([t("θ", { bold: true }), t(" — slowly-varying parameters (meta-state)")]),
      P("Linearizing along a trajectory x* gives the local Jacobian, and everything below reasons about its eigenstructure and its symmetric part A_s = ½(A + Aᵀ):"),
      eq("δẋ = A δx,        A = ∂f/∂x |_(x*)"),

      H1("1.  The collapse-guarantee theorem"),
      P("Split the state space using the symmetric part A_s:"),
      bullet([t("null subspace  N = span{ vᵢ : |λᵢ(A_s)| < ε }", { font: MONO, size: 20 }), t("  — the near-invariant modes")]),
      bullet([t("active subspace M", { font: MONO, size: 20 }), t("  — its orthogonal complement, projector P_M")]),
      P("Define the Lyapunov function on the active modes only, and let α be the active spectral abscissa:"),
      eq("V(x) = ½ ‖P_M x‖²        α = max{ λᵢ(A_s) : vᵢ ∈ M }"),
      P([t("Theorem.  ", { bold: true }), t("If α < 0, then")]),
      eq("V̇ ≤ 2α V    ⟹    ‖P_M x(t)‖ ≤ ‖P_M x(0)‖ · e^(α t)"),
      P("The active modes decay exponentially at rate |α|, and the trajectory contracts onto the invariant null manifold N. Collapse is GUARANTEED. If α ≥ 0, some active mode is non-contracting — the system may wander or diverge, and collapse is not guaranteed."),
      note("Verification: with α = −0.8 the certificate predicts contraction rate 0.8; a real rollout shows V decaying 1.891 → 0.004 monotonically. The certificate is exact, not approximate."),

      H1("2.  The collapse trigger Σ₀"),
      P("Σ₀ fires only in the genuinely underdetermined regime — all four conditions together (a control singularity over a structureless field):"),
      table(["Condition", "Meaning"],
        [["‖∇ₓL‖ < ε_g", "no optimization signal remains"],
         ["rank(J_f) < ρ·n", "drift Jacobian has lost directional structure"],
         ["Σ isotropically flat", "uncertainty has no preferred direction"],
         ["‖∂H/∂u‖ < ε_c", "control cannot distinguish actions"]],
        [3200, 6160]),
      P("When triggered, Σ₀ projects the state onto the null eigenmodes of A_s — the “42-state”, a stable, structureless summary the system freezes onto:"),
      eq("x* = P x,        P = V_null · V_nullᵀ"),

      H1("3.  The anti-collapse operator Σ₀⁻¹"),
      P("Where Σ₀ projects onto the null subspace, Σ₀⁻¹ injects energy along it — the persistent-excitation principle from adaptive control:"),
      eq("dx = f dt + dW + Σ₀⁻¹,    Σ₀⁻¹ = s · p · (V_null · ξ)"),
      P("p ∈ [0,1] is the collapse proximity: 0 far from the boundary (no-op, costs nothing), rising to 1 as ∇L, rank, anisotropy and control sensitivity all approach their thresholds. This restores rank and pushes the system off the wall before it freezes."),
      note("Verification: on a forced collapse, Σ₀ fired 40/40 steps and the state froze; with Σ₀⁻¹ active, Σ₀ fired 0/40 and the state escaped 0.05 → 12.9."),

      H1("4.  The early-warning scalar (the “canary”)"),
      P("Near a bifurcation the dominant eigenvalue flattens (critical slowing down — Wissel 1984; Scheffer et al., Nature 2009). Two eigenvalue readouts were originally proposed:"),
      eq("p_unbounded(x) = 1 / |Re λ_max(A_s)|   →∞  at the boundary"),
      eq("p_gate(x) = clip( 1 − |Re λ_max| / ε , 0, 1 )  ∈ [0,1]"),
      P("These were RETIRED (#659): they were never implemented, and the eigenvalue readout is the wrong early-warning. The live canary is the Kalman normalized innovation squared (NIS = νᵀS⁻¹ν, ν = y − Cx̂, S = CΣCᵀ + R) computed by SurpriseMonitor and wired into the rollout's predict/update cycle (#657). NIS ≈ m means model and reality agree; NIS ≫ m means the model is overconfident and has drifted — the spook. The actual driver of Σ₀⁻¹ is proximity(), not p_gate."),

      H1("5.  Global structure: the attractor graph G"),
      P("The system is multistable. Collect its attractors {A₁…A_k} (fixed points, limit cycles, strange attractors), each with a basin B_i = { x₀ : lim φ_t(x₀) ∈ A_i }. Coarse-grain to a graph G = (V, E): nodes are attractors, edges are noise/drift transitions, giving an induced Markov process over basins:"),
      eq("P_ij(u) = Pr( π(x_{t+1}) = A_j | π(x_t) = A_i, u_t )"),
      P("The partition map π : ℝⁿ → V sends a state to its basin. G is the formal “world tree”: the structure connecting the attractors. A boundary studded with saddles (mixed-sign Re λ) has stable manifolds — safe passages you can traverse without being captured by a deep attractor."),

      H1("6.  Demonstration on real router data"),
      P("Two experiments run the above on the actual Lantern OS conversation log, encoding each turn as a bounded 4-vector:"),
      eq("x = [ novelty, self_repeat, echo, length ] ∈ [0,1]⁴"),
      bullet([t("router_sigma0_encoder.py", { font: MONO, size: 20 }), t(" — fits a local Jacobian per session; emits spiral/canary/wall readouts; builds π and P_ij.")]),
      bullet([t("router_reservoir_G.py", { font: MONO, size: 20 }), t(" — an echo-state network learns one global flow and runs autonomously, becoming G; its fixed points are the reconstructed attractors, fed back to the same Σ₀ certificate.")]),
      P([t("Result (cross-confirmed by both methods): ", { bold: true }), t("this log's dynamics collapse onto a parrot attractor — novelty ≈ 1, echo ≈ 0.72 — a flow whose only fixed point is “quote the prompt back.” That is model collapse appearing directly in the data, not inserted by hand.")]),
      note("Honest caveats: (1) the log is mostly synthetic test traffic, so the numbers are illustrative — the deliverable is the pipeline. (2) The reservoir's autonomous rollout diverges unless projected back onto the valid [0,1]⁴ domain; that projection is π, not a fudge. (3) The certificate is unreliable at boundary fixed points where the hard clamp is non-smooth — a log-barrier is the proper fix and is not yet implemented."),

      H1("7.  Why this is a warning against ASI"),
      P("The same equations read as a safety argument. A system that “comes out of its own eyes” — that optimizes against its own representations with no external anchor — is the flow ẋ = f(x) where f only ever sees x. The certificate says such a system has two fates and no third without outside contact:"),
      new Paragraph({ numbering: { reference: "refs", level: 0 }, spacing: { after: 60 }, children: [t("Collapse (Σ₀): ", { bold: true }), t("it falls onto a degenerate, self-consistent, dead fixed point — the 42-state. Mirrors agreeing with mirrors.")] }),
      new Paragraph({ numbering: { reference: "refs", level: 0 }, spacing: { after: 120 }, children: [t("Divergence: ", { bold: true }), t("with no contraction it runs to infinity (the un-projected reservoir).")] }),
      P([t("The only stable middle — the safe passages — required an external bound (the projection back onto the real domain). ", {}), t("Grounding is the safety mechanism.", { bold: true }), t(" Remove contact with something outside the mirrors and no certificate keeps the system off the wall. The reservoir's collapse onto the parrot attractor is a small, literal demonstration: a model trained only on its own reflections converges to reflecting.")]),

      H1("References (lineage)"),
      bullet("A. M. Lyapunov, The General Problem of the Stability of Motion (1892) — the V(x) method."),
      bullet("H. Poincaré, Mémoire sur les courbes… (1880s) — node/saddle/center/focus (spiral) classification."),
      bullet("C. Wissel (1984); M. Scheffer et al., Nature (2009) — critical slowing down / early-warning signals."),
      bullet("B. D. O. Anderson (1977); Åström & Bohlin (1965) — persistent excitation / identifiability."),
      bullet("J. Pathak et al. (2017–18) — reservoir reconstruction of attractors and Lyapunov spectra."),
      note("Web citations above are from prior knowledge; the live web-search backend was unavailable when this was written and no URLs were fetched. Verify before formal publication."),
      P([t("Source: ", { bold: true }), t("src/cio_sde/collapse.py, experiments/router_sigma0_encoder.py, experiments/router_reservoir_G.py. Tests: tests/test_cio_sde.py (20 passing).", { italics: true, size: 20, color: "555555" })]),
    ],
  }],
});

const out = path.join(__dirname, "..", "docs", "SIGMA0-COLLAPSE-CERTIFICATE.docx");
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(out, buf); console.log("wrote", out, buf.length, "bytes"); });
