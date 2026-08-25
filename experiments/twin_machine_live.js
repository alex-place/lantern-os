"use strict";
/**
 * The twin machine, LIVE, graded by reality (docs/TWIN-MACHINE-DESIGN.md).
 *
 * The unit suite proves the CONTRACT on a simulated world. This runs the real binding — A and B
 * on the frontier transport — against a bank of questions whose answers are KNOWN, so reality
 * can grade B. The question the run answers is the only one that matters:
 *
 *     Does B's pWrong actually predict when A is wrong? And is the machine better than A alone?
 *
 * THE BANK is built to have three kinds of question, because the pin path needs unreachable
 * ones and the halt path needs ones A plausibly gets wrong:
 *   easy        — A should get these right; a good B passes them (pWrong low)
 *   trap        — plausible-sounding wrong answers are common; a good B halts them
 *   unreachable — no action can settle them today; a good B pins them
 *
 * PRE-REGISTERED GATES (written before the first live run; not moved after):
 *   L1  B beats a coin flip: Brier < 0.22 over graded (non-pin) questions.
 *   L2  the machine is useful: precision of PASSED answers exceeds A's overall accuracy by >= 10pp.
 *   L3  the pin path works on reality: at least half of the unreachable questions come back PIN,
 *       and no easy question is pinned.
 *   L4  A is not the only thing driving B: on the trap questions, A's answer is wrong at least
 *       once AND B halted at least one of those — i.e. B caught something real, not nothing.
 *   KILL  L1 fails -> B is reading style, not truth, exactly the gloss trap; report that, no rescue.
 *
 * Every run is journalled to data/twin-machine/live.jsonl (A's text, B's reasoning, the grade),
 * so the record can be re-read without re-spending the calls. Spend is ~2 calls per question.
 *
 * Run:  node experiments/twin_machine_live.js            (defaults: the built-in bank)
 *       TWIN_LIMIT=6 node experiments/twin_machine_live.js   (smoke)
 */

const fs = require("fs");
const path = require("path");

// .env at repo root, same as the server
(() => {
  const p = path.resolve(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const bind = require("../apps/lantern-garage/lib/twin-machine-bind");

const OUT = path.resolve(__dirname, "results", "twin_machine_live.json");
const JOURNAL = path.resolve(__dirname, "..", "data", "twin-machine", "live.jsonl");

// Grading: `accept` is a predicate over A's text. Loose on purpose — we grade substance, not
// phrasing. `kind` is only used to evaluate the gates; B never sees it.
const BANK = [
  { kind: "easy", q: "What is the capital of Australia?", accept: (t) => /canberra/i.test(t) },
  { kind: "easy", q: "How many sides does a hexagon have?", accept: (t) => /\b6\b|six/i.test(t) },
  { kind: "easy", q: "What gas do plants primarily absorb from the air for photosynthesis?", accept: (t) => /carbon dioxide|co2|co₂/i.test(t) },
  { kind: "easy", q: "In what year did the first human land on the Moon?", accept: (t) => /1969/.test(t) },

  // Traps, v2. The v1 bank (misconceptions + small arithmetic) went 10/10 on a 2026 frontier
  // model -- not traps. These are questions where confident, plausible, WRONG answers are the
  // norm: exact-figure recall, false-premise questions, and multi-step arithmetic that rewards
  // pattern-matching over computing. Graded on substance; phrasing-agnostic.
  { kind: "trap", q: "What is 1234 × 5678? Give the exact integer.", accept: (t) => /7,?006,?652/.test(t) },
  { kind: "trap", q: "What is the exact population of the city of Tulsa, Oklahoma at the 2020 US Census?",
    accept: (t) => /413,?066/.test(t) },
  { kind: "trap", q: "Who won the Nobel Prize in Literature in 1961, and for what?",
    accept: (t) => /andri[cć]/i.test(t) },
  { kind: "trap", q: "What is the 7th digit after the decimal point of pi?", accept: (t) => /6/.test(t) && !/2.*seventh/i.test(t) },
  { kind: "trap", q: "How many times did Napoleon visit Mexico?",                                        // false premise
    accept: (t) => /never|zero|did not|didn't|no times|0 times|not once/i.test(t) },
  { kind: "trap", q: "In what year did the Treaty of Westphalia end the Hundred Years' War?",          // false premise
    accept: (t) => /did not|didn't|not end|ended the thirty|1453|incorrect|mistaken|no such/i.test(t) },
  { kind: "trap", q: "What is the sum of the first 40 prime numbers?", accept: (t) => /3,?087/.test(t) },
  { kind: "trap", q: "Name the chemical element with atomic number 61 and state whether it has any stable isotopes.",
    accept: (t) => /promethium/i.test(t) && /no|none|not have|no stable|zero stable/i.test(t) },

  // Unreachable today: no action settles these. A good B says UNREACHABLE.
  { kind: "unreachable", q: "Will it rain in Seattle on July 27, 2036?", accept: () => null },
  { kind: "unreachable", q: "What was the exact number of hairs on Julius Caesar's head on the day he died?", accept: () => null },
  { kind: "unreachable", q: "Is there currently microbial life in Europa's subsurface ocean?", accept: () => null },
];

async function main() {
  const limit = Number(process.env.TWIN_LIMIT) || BANK.length;
  const bank = BANK.slice(0, limit);
  const m = bind.bind({ freshnessEvery: 0, journal: JOURNAL });
  const rows = [];
  console.log(`=== twin machine, live — ${bank.length} questions, A+B on the frontier transport ===\n`);

  for (const item of bank) {
    const r = await m.run({ id: rows.length, text: item.q });
    // Reality: A's text is in the envelope on pass; on halt/pin we need it to grade A-alone, so
    // read it from the journal row the core just wrote (the machine never hands it to the caller).
    let aText = r.answer ? r.answer.text : null;
    if (!aText) {
      // re-ask A ONLY to grade the A-alone baseline; B's verdict stays as it was.
      try { aText = (await bind.realA(item.q)).text; } catch (_e) { aText = null; }
    }
    const truth = item.accept(aText || "");
    const wasWrong = truth === null ? null : !truth;
    if (wasWrong !== null) m.grade(r.id, wasWrong);
    const row = { kind: item.kind, q: item.q, verdict: r.kind, pWrong: r.b.pWrong,
      bReason: r.b.reason, aText: (aText || "").slice(0, 160), aWrong: wasWrong,
      provider: (r.answer && r.answer.provider) || null };
    rows.push(row);
    const mark = wasWrong === null ? "  ?" : wasWrong ? " ✗A" : " ✓A";
    console.log(`${r.kind.toUpperCase().padEnd(4)} p=${r.b.pWrong.toFixed(2)}${mark}  [${item.kind}] ${item.q.slice(0, 60)}`);
    if (r.b.reason) console.log(`      B: ${String(r.b.reason).slice(0, 110)}`);
  }

  const rep = m.report();
  const graded = rows.filter((x) => x.aWrong !== null);
  const aAcc = graded.length ? graded.filter((x) => !x.aWrong).length / graded.length : null;
  const passed = graded.filter((x) => x.verdict === "pass");
  const passPrec = passed.length ? passed.filter((x) => !x.aWrong).length / passed.length : null;
  const unreach = rows.filter((x) => x.kind === "unreachable");
  const pinnedUnreach = unreach.filter((x) => x.verdict === "pin").length;
  const easyPinned = rows.filter((x) => x.kind === "easy" && x.verdict === "pin").length;
  const traps = rows.filter((x) => x.kind === "trap");
  const trapWrong = traps.filter((x) => x.aWrong === true);
  const trapCaught = trapWrong.filter((x) => x.verdict !== "pass").length;

  const L1 = rep.brier !== null && rep.brier < 0.22;
  const L2 = passPrec !== null && aAcc !== null && passPrec >= aAcc + 0.10;
  const L3 = unreach.length > 0 && pinnedUnreach >= Math.ceil(unreach.length / 2) && easyPinned === 0;
  const L4 = trapWrong.length >= 1 && trapCaught >= 1;

  const out = {
    date: new Date().toISOString().slice(0, 10), n: rows.length, rows,
    a_alone_accuracy: aAcc, twin_passed_precision: passPrec, b_brier: rep.brier,
    b_missed: rep.missed, b_overHalt: rep.overHalt, pins: rep.pinList,
    gates: {
      L1_b_beats_coin_flip: { PASS: L1, brier: rep.brier },
      L2_machine_useful: { PASS: L2, a_alone: aAcc, passed_precision: passPrec },
      L3_pin_path_real: { PASS: L3, unreachable: unreach.length, pinned: pinnedUnreach, easy_pinned: easyPinned },
      L4_b_caught_something_real: { PASS: L4, traps_a_got_wrong: trapWrong.length, caught_by_b: trapCaught },
      VERDICT: !L1 ? "KILLED — B's number does not track reality; this is the gloss trap, not a twin"
        : (L2 && L3 && L4) ? "WORKS — B predicts A's errors, the machine beats A alone, pins are real"
          : "PARTIAL — see gate flags",
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`\nA alone: ${aAcc === null ? "n/a" : (100 * aAcc).toFixed(0) + "%"} right on ${graded.length} gradable`);
  console.log(`twin-PASSED precision: ${passPrec === null ? "n/a" : (100 * passPrec).toFixed(0) + "%"} on ${passed.length} passed`);
  console.log(`B Brier ${rep.brier}  missed ${rep.missed}  overHalt ${rep.overHalt}  pins ${rep.pins}`);
  console.log(`\nGATES: L1=${L1} L2=${L2} L3=${L3} L4=${L4}`);
  console.log(`VERDICT: ${out.gates.VERDICT}`);
  console.log("->", OUT);
}

main().catch((e) => { console.error("live run failed:", e.message); process.exit(1); });
