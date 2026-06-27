// Convergence Oracle (Node) — time-banded observer slices, for the chat hot-path.
// Node port of src/convergence/oracle.py (canonical + tested). The server can't spawn python
// (`spawn python ENOENT`), so the chat grounds in-process. Keep the two in sync.
//
// Grounds every question on the two pins of cosmic time — the big bang (t=0, entropy minimum)
// and the heat death (~10^100 yr, entropy maximum). Each band is an observer slice carrying
// KNOWNs (with sources) and UNKNOWNs; the boundary pins (the singularity, the ultimate fate)
// are never bluffed. See docs/research/convergence-oracle.md.

const NOW = "Stelliferous era (NOW)";

const BANDS = {
  "Planck epoch": {
    t_label: "< 10⁻⁴³ s", entropy: "minimum", direction: "boundary",
    knowns: [{ claim: "the Planck time t_P ≈ 5.39×10⁻⁴⁴ s bounds where known physics applies",
               confidence: 0.9, source: "standard cosmology" }],
    unknowns: ["quantum gravity (no tested theory)", "the initial singularity",
               "whether 'before the big bang' is even meaningful"],
  },
  "Inflation": {
    t_label: "≈ 10⁻³⁶–10⁻³² s", entropy: "minimum", direction: "forward",
    knowns: [{ claim: "a brief exponential expansion explains flatness, horizon uniformity, and the seeds of structure",
               confidence: 0.75, source: "Guth 1981; Planck 2018" }],
    unknowns: ["the identity of the inflaton field"],
  },
  "Nucleosynthesis (BBN)": {
    t_label: "≈ 1 s – 20 min", entropy: "low", direction: "forward",
    knowns: [{ claim: "primordial ~75% H / ~25% helium-4 + trace D/Li are set by big-bang nucleosynthesis",
               confidence: 0.93, source: "BBN; Planck 2018" }],
    unknowns: ["the origin of the matter–antimatter asymmetry (baryogenesis)"],
  },
  "Recombination / CMB": {
    t_label: "≈ 380,000 yr", entropy: "low", direction: "forward",
    knowns: [{ claim: "the universe became transparent at z≈1089; the CMB is directly observed at 2.7255 K",
               confidence: 0.98, source: "Planck Collaboration 2018, arXiv:1807.06209" }],
    unknowns: [],
  },
  "First stars → reionization": {
    t_label: "≈ 1e8 – 1e9 yr", entropy: "rising", direction: "forward",
    knowns: [{ claim: "the first stars and galaxies form and reionize the intergalactic medium",
               confidence: 0.8, source: "observational cosmology (JWST, SDSS)" }],
    unknowns: ["the detailed reionization history", "Population III (first-star) properties"],
  },
  [NOW]: {
    t_label: "≈ 1e9 – 1e14 yr · now 13.787 Gyr", entropy: "rising", direction: "both",
    knowns: [{ claim: "the universe is 13.787 ± 0.020 Gyr old (~68% dark energy / 27% dark matter / 5% baryons) and its expansion is accelerating",
               confidence: 0.95, source: "Planck 2018; Riess 1998 / Perlmutter 1999" }],
    unknowns: ["the nature of dark matter", "the nature of dark energy (constant Λ vs evolving)"],
  },
  "Degenerate era": {
    t_label: "≈ 1e14 – 1e40 yr", entropy: "high", direction: "backward",
    knowns: [{ claim: "star formation ceases; only stellar remnants remain — the 2nd law forces the universe toward equilibrium",
               confidence: 0.85, source: "Adams & Laughlin 1997, arXiv:astro-ph/9701131" }],
    unknowns: ["the proton lifetime (>~10³⁴ yr, unmeasured) — whether/when ordinary matter dissolves"],
  },
  "Black hole era": {
    t_label: "≈ 1e40 – 1e100 yr", entropy: "very high", direction: "backward",
    knowns: [{ claim: "black holes dominate the mass budget, then evaporate via Hawking radiation",
               confidence: 0.7, source: "Adams & Laughlin 1997; Hawking 1974" }],
    unknowns: ["the black-hole information paradox", "final-state quantum-gravity physics"],
  },
  "Dark era / heat death": {
    t_label: "> 1e100 yr", entropy: "maximum", direction: "boundary",
    knowns: [{ claim: "the universe approaches maximum entropy — thermodynamic equilibrium with no usable energy left to do work (heat death)",
               confidence: 0.7, source: "Adams & Laughlin 1997; Dyson 1979" }],
    unknowns: ["the ultimate fate IS the open question: heat death (constant Λ) vs Big Rip (phantom dark energy) vs vacuum decay (metastable Higgs) — depends on dark energy",
               "whether a future low-entropy fluctuation/bounce is possible"],
  },
};

const KEYMAP = [
  [["before the big bang", "singularity", "planck", "quantum gravity", "begin", "t=0",
    "start of time", "first instant"], "Planck epoch"],
  [["inflation", "flatness", "horizon problem"], "Inflation"],
  [["nucleosynthesis", "helium", "abundance", "antimatter", "baryogenesis"], "Nucleosynthesis (BBN)"],
  [["cmb", "microwave background", "recombination", "transparent"], "Recombination / CMB"],
  [["first star", "reionization", "population iii", "first galax"], "First stars → reionization"],
  // NOW band: real cosmology anchors only. The bare words "now"/"today"/"current"
  // were removed (#1275) — they are not cosmology keywords and matched everyday
  // requests ("fix this bug now", "my schedule today"), grounding them in dark
  // energy. The no-match case already returns no grounding (#1268, sliceFor→null).
  [["how old", "age of the universe", "dark energy", "dark matter"], NOW],
  [["proton decay", "white dwarf", "remnant", "stars stop", "star formation end"], "Degenerate era"],
  [["black hole", "hawking", "evaporat"], "Black hole era"],
  [["heat death", "end of the universe", "ultimate fate", "fate of the universe", "fate of everything",
    "big rip", "vacuum decay", "final state", "how does it end", "how will the universe end",
    "end of time"], "Dark era / heat death"],
];

function sliceFor(question) {
  const q = String(question || "").toLowerCase();
  for (const [keys, band] of KEYMAP) {
    if (keys.some((k) => q.includes(k))) return Object.assign({ band }, BANDS[band]);
  }
  return null;   // not a cosmology/deep-time question — no slice, no forced grounding
}

// The grounding block injected into the prompt — only for questions that actually
// match a cosmic-time band. Earlier this defaulted every unmatched question to the
// NOW band, so unrelated chat turns ("give me a picture of X") got a cosmology
// grounding block prepended, and the model would respond to that injected context
// instead of (or alongside) the real question. #1268
function formatGrounding(question) {
  const s = sliceFor(question);
  if (!s) return "";
  const lines = [
    "Convergence Oracle — time-banded grounding for this question. Cite the KNOWN facts (with " +
    "their sources) as evidence and be honest about the UNKNOWNs; never bluff the boundaries " +
    "(the singularity, the ultimate fate):",
    `observer slice: ${s.band} (${s.t_label}) · entropy ${s.entropy} · grounded ${s.direction}`,
    "KNOWN:",
    ...s.knowns.map((k) => `  ✓ ${k.claim}  [conf ${k.confidence}; ${k.source}]`),
    "UNKNOWN:",
    ...(s.unknowns.length ? s.unknowns.map((u) => `  ? ${u}`) : ["  (none in this band — directly observed)"]),
  ];
  return lines.join("\n");
}

module.exports = { sliceFor, formatGrounding, BANDS, NOW };
