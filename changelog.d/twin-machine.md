### The twin machine, built as a test — and run live

`lib/twin-machine.js` is the pure core of docs/TWIN-MACHINE-DESIGN.md: A answers, B predicts
where A is wrong, and **the one rule is code, not convention** — A's answer reaches the caller
only through B's gate, A cannot change B's verdict, B fails closed, reality overrides B in both
directions and grades it. Three verdicts (pass / halt / pin), a forced freshness probe on a
cadence B does not control, and `perturbationTest()` — the §9 discipline: independence of two
B's is tested by whether they *move* under a hidden perturbation, not by agreement statistics.

13 contract tests on a simulated world with a known truth: A alone 56% right → answers the twin
passes 76% right, B Brier 0.18; and a blind-B control scores exactly 0.25 (coin flip), which is
what makes the positive number mean something.

`lib/twin-machine-bind.js` attaches real models over the existing verify transport. B is built
against the gloss trap on purpose: never asked how confident it is, never shown A's confidence
as a weight, asked instead to list concrete ways the answer could be wrong and emit one number.

**Live, on 15 questions with known answers (`experiments/twin_machine_live.js`):** B halted A on
exactly the two questions A got wrong (1234×5678 → p=0.95; sum of 40 primes → p=0.75), zero
over-halts, A alone 75% → twin-passed 90%, Brier 0.075. One miss: B named A's wrong pi digit in
its own reasoning and passed it anyway at p=0.10. **And the pin path does not work with a
prose-reasoning B:** three unreachable questions, zero pins — a frontier model asked "could any
action settle this?" says yes, a little, every time. That is the result the design predicted,
and it is the first concrete thing the in-house B has to do that the rented one cannot.
