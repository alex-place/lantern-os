"use strict";

/**
 * MLB run-total weather model — the Reason leg for the paper KXMLBTOTAL deck.
 *
 * Given a ballpark (kalshi-mlb-parks) and its game-time conditions (temperature, wind
 * speed + direction, precip probability), estimate how far the TRUE run total is tilted
 * from a neutral reference (70°F, calm) by weather alone: `weatherTiltRuns()`.
 *
 * ── HONESTY BOUNDARY (read before trusting an output) ────────────────────────────────
 * This is a PHYSICS-magnitude estimate of the *total* weather effect, NOT an edge. The
 * betting market's total ALREADY prices the modal part of it (books move MLB totals on
 * heat and wind every day). So a tilt is only *potential* edge where the market plausibly
 * UNDER-reacts — the tails: strong wind on a clear out/in axis, a retractable roof whose
 * likely state diverges from the pricing, or temperature extremes. The deck fires paper
 * hypotheses ONLY on those tails and logs them to a settled ledger, so the residual (how
 * much the market leaves on the table) can be MEASURED rather than assumed. Until that
 * ledger has resolved trades, every card is an unproven hypothesis. n=0 is honest.
 *
 * Coefficient magnitudes (kept deliberately conservative):
 *   - Temperature: run scoring rises ~1.5% per +10°F (Alan Nathan's carry physics +
 *     empirical box-score studies). On a ~9-run base that is ~0.013 runs/°F. Capped ±0.6.
 *   - Wind: ~0.10 runs per mph of wind blowing straight OUT to center, symmetric for IN
 *     (Wrigley/■ studies; Nathan). Only the component along the home→CF axis counts, and
 *     only when the roof is open and the park's CF azimuth is known. Capped ±1.5.
 *   - Precip: high rain probability ⇒ mild UNDER lean (shortened game) + postponement risk.
 *   - Altitude (Coors) is NOT in the tilt — it is fixed, universally known, and fully in
 *     the market baseline. Reported as context only.
 */

const REF_TEMP_F = 70;          // neutral reference temperature
const TEMP_RUNS_PER_F = 0.013;  // ~1.5%/10°F on a ~9-run base
const TEMP_CAP = 0.6;
const WIND_RUNS_PER_MPH_OUT = 0.10;
const WIND_CAP = 1.5;
const PRECIP_UNDER_AT = 0.5;    // ≥50% rain prob ⇒ shortened-game UNDER lean
const PRECIP_RUNS = -0.3;

// A retractable roof is inferred CLOSED (⇒ wind + temp neutralized) under conditions
// where clubs routinely close it: extreme heat or a real chance of rain.
const ROOF_CLOSE_TEMP_F = 95;
const ROOF_CLOSE_PRECIP = 0.4;

const TAIL_MIN_RUNS = 0.6;      // |tilt| below this on the slate ⇒ weather-quiet, stand down

function rad(d) { return (d * Math.PI) / 180; }

/**
 * Component of wind blowing OUT toward center field, in mph (negative = blowing IN).
 * NWS reports the direction wind comes FROM (meteorological); "out to CF" means the wind
 * travels from home plate toward center, i.e. its blowing-TOWARD bearing aligns with the
 * park's home→CF azimuth. Projection = speed · cos(Δbearing).
 */
function windOutComponentMph(windMph, windFromDeg, cfAzimuthDeg) {
  if (!Number.isFinite(windMph) || windMph <= 0) return 0;
  if (!Number.isFinite(windFromDeg) || !Number.isFinite(cfAzimuthDeg)) return 0;
  const toBearing = (windFromDeg + 180) % 360;             // direction wind blows toward
  let delta = Math.abs(toBearing - cfAzimuthDeg) % 360;
  if (delta > 180) delta = 360 - delta;
  return windMph * Math.cos(rad(delta));
}

/**
 * weatherTiltRuns — estimate the weather-driven shift in a game's run total.
 * @param {object} cond { tempF, windMph, windFromDeg, precipProb (0..1) }
 * @param {object} park  a kalshi-mlb-parks record (roof, cfAzimuthDeg, altitudeFt, ...)
 * @returns {{deltaRuns, direction, dominant, components, confidence, tail, roofState, notes}}
 */
function weatherTiltRuns(cond, park) {
  const tempF = Number(cond.tempF);
  const windMph = Number(cond.windMph);
  const windFromDeg = Number(cond.windFromDeg);
  const precipProb = Number.isFinite(cond.precipProb) ? cond.precipProb : 0;
  const roof = park && park.roof ? park.roof : "open";
  const notes = [];

  // Roof state: fixed/dome ⇒ always closed. Retractable ⇒ inferred from conditions.
  let roofState = "open";
  let roofSignal = false;
  if (roof === "fixed") { roofState = "closed"; }
  else if (roof === "retractable") {
    const hot = Number.isFinite(tempF) && tempF >= ROOF_CLOSE_TEMP_F;
    const wet = precipProb >= ROOF_CLOSE_PRECIP;
    if (hot || wet) {
      roofState = "likely-closed";
      roofSignal = true;                 // a discrete, sometimes-mispriced condition
      notes.push(`retractable roof likely CLOSED (${hot ? "heat" : ""}${hot && wet ? "+" : ""}${wet ? "rain" : ""}) → wind/temp neutralized`);
    } else {
      roofState = "likely-open";
    }
  }
  const enclosed = roofState === "closed" || roofState === "likely-closed";

  // Temperature carry (neutralized when enclosed — climate-controlled).
  let tempRuns = 0;
  if (Number.isFinite(tempF) && !enclosed) {
    tempRuns = clamp(TEMP_RUNS_PER_F * (tempF - REF_TEMP_F), -TEMP_CAP, TEMP_CAP);
  }

  // Wind out/in (needs known azimuth AND an open roof).
  let windRuns = 0, windOut = 0, windKnown = false;
  if (!enclosed && park && Number.isFinite(park.cfAzimuthDeg)) {
    windOut = windOutComponentMph(windMph, windFromDeg, park.cfAzimuthDeg);
    windRuns = clamp(WIND_RUNS_PER_MPH_OUT * windOut, -WIND_CAP, WIND_CAP);
    windKnown = true;
  } else if (!enclosed && park && park.cfAzimuthDeg == null && windMph >= 12) {
    notes.push(`strong wind ${Math.round(windMph)}mph but park CF orientation unknown → vector suppressed`);
  }

  // Precip: shortened-game UNDER lean + postponement flag.
  let precipRuns = 0, postponeRisk = false;
  if (precipProb >= PRECIP_UNDER_AT && !enclosed) {
    precipRuns = PRECIP_RUNS * (precipProb);
    postponeRisk = precipProb >= 0.7;
    if (postponeRisk) notes.push(`precip ${Math.round(precipProb * 100)}% → postponement/void risk`);
  }

  const deltaRuns = round2(tempRuns + windRuns + precipRuns);
  const components = {
    temp: round2(tempRuns),
    wind: round2(windRuns),
    precip: round2(precipRuns),
    windOutMph: round2(windOut),
  };
  const dominant = Object.entries({ temp: tempRuns, wind: windRuns, precip: precipRuns })
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0];

  const direction = deltaRuns > 0 ? "OVER" : deltaRuns < 0 ? "UNDER" : "NEUTRAL";

  // Confidence in the SIGNAL TYPE (not in profit): strong wind on a known axis is the
  // most reliable, roof-state divergence next, temperature-only the weakest (most priced).
  let confidence = 0.3;
  if (windKnown && Math.abs(windRuns) >= 0.5) confidence = 0.7;
  else if (roofSignal) confidence = 0.55;
  else if (Math.abs(tempRuns) >= 0.5) confidence = 0.4;

  // Tail = worth a paper hypothesis: a materially non-modal signal driven by wind, roof,
  // or a temperature extreme. Pure small-temp nights are NOT tails (fully priced) → stand down.
  const tail =
    (windKnown && Math.abs(windRuns) >= 0.5) ||
    roofSignal ||
    (Math.abs(tempRuns) >= 0.5) ||
    postponeRisk;

  return { deltaRuns, direction, dominant, components, confidence, tail, roofState, roofSignal, postponeRisk, windKnown, notes };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function round2(x) { return Math.round(x * 100) / 100; }

// ── self-test ─────────────────────────────────────────────────────────────────────
function selfTest() {
  const fails = [];
  const openAxis = { roof: "open", cfAzimuthDeg: 0, altitudeFt: 20 };       // CF due north
  const dome = { roof: "fixed", cfAzimuthDeg: 0, altitudeFt: 10 };
  const retract = { roof: "retractable", cfAzimuthDeg: 0, altitudeFt: 1080 };

  // Wind FROM south (180°) blows toward north (0°) = straight OUT to a due-north CF → OVER.
  const out = weatherTiltRuns({ tempF: 75, windMph: 15, windFromDeg: 180, precipProb: 0 }, openAxis);
  if (!(out.components.windOutMph > 14)) fails.push(`wind-out projection wrong: ${out.components.windOutMph}`);
  if (!(out.direction === "OVER" && out.tail)) fails.push(`strong wind out should be OVER+tail: ${JSON.stringify(out)}`);

  // Wind FROM north (0°) blows toward south = straight IN → UNDER.
  const inn = weatherTiltRuns({ tempF: 75, windMph: 15, windFromDeg: 0, precipProb: 0 }, openAxis);
  if (!(inn.direction === "UNDER" && inn.components.wind < -0.5)) fails.push(`wind in should be UNDER: ${JSON.stringify(inn.components)}`);

  // Crosswind FROM east (90°) → blows toward west, perpendicular to N-S axis → ~0 wind runs.
  const cross = weatherTiltRuns({ tempF: 72, windMph: 15, windFromDeg: 90, precipProb: 0 }, openAxis);
  if (Math.abs(cross.components.wind) > 0.05) fails.push(`crosswind should be ~0: ${cross.components.wind}`);

  // Dome neutralizes wind AND temp.
  const d = weatherTiltRuns({ tempF: 100, windMph: 20, windFromDeg: 180, precipProb: 0 }, dome);
  if (!(d.components.wind === 0 && d.components.temp === 0 && !d.tail)) fails.push(`dome should neutralize: ${JSON.stringify(d.components)}`);

  // Retractable in extreme heat → inferred closed, roof signal, neutralized.
  const r = weatherTiltRuns({ tempF: 104, windMph: 10, windFromDeg: 180, precipProb: 0 }, retract);
  if (!(r.roofSignal && r.components.temp === 0)) fails.push(`retractable heat should close+neutralize: ${JSON.stringify(r)}`);

  // Modal calm mild night → no tail (stand down).
  const modal = weatherTiltRuns({ tempF: 74, windMph: 4, windFromDeg: 200, precipProb: 0.1 }, openAxis);
  if (modal.tail) fails.push(`modal night should NOT be a tail: ${JSON.stringify(modal)}`);

  // Unknown azimuth suppresses the wind vector even in strong wind.
  const noAz = weatherTiltRuns({ tempF: 74, windMph: 18, windFromDeg: 180, precipProb: 0 }, { roof: "open", cfAzimuthDeg: null });
  if (noAz.components.wind !== 0) fails.push(`null azimuth must suppress wind vector: ${noAz.components.wind}`);

  return { ok: fails.length === 0, fails };
}

module.exports = { weatherTiltRuns, windOutComponentMph, selfTest, TAIL_MIN_RUNS };

if (require.main === module) {
  const r = selfTest();
  process.stdout.write(`MLB weather-model self-test: ${r.ok ? "PASS" : "FAIL"}\n`);
  if (!r.ok) { for (const f of r.fails) process.stdout.write("  - " + f + "\n"); process.exit(1); }
}
