feat(brand): ship the unbound-webs mandala as the site mark

Replaces `apps/lantern-garage/public/mandala.svg` — the nav logo on every
page — with the founder-tuned "unbound webs" variant, exported verbatim from
the mandala workbench (specimen artifact) and shipped unmodified.

Recipe vs the previous mark: twelve spires lose their 12-gon and shrink to
x0.82, flipped clockwise at 20s; expanding web keeps its outline at x1.07,
flipped counter-clockwise and slowed to 60s; star web loses its outline at
x1.14, clockwise 40.5s; the inner star is removed. Gradient stops, 5s sweep,
stroke 1.4 and vertex dots unchanged. Pose-repeat period 1620s (was 1260s).

Same file mechanism as before (CSS keyframes + SMIL inside the SVG document,
zero script), so it animates in `<img>` context on all embedding pages.
XML-validated; no code parses the asset's internals (tests style the img
element only).
