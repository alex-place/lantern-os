### Research — Robin, rebuilt for LLM design

`research/robin_llm` is a working reimplementation of the Robin discovery pipeline
(arXiv:2505.13400) with the domain swapped to design changes on our own stack: literature over
the local arXiv corpus, assay selection, a baseline measured on this machine, candidate design
changes, sceptical per-candidate reviews, pairwise LLM judging ranked by Bradley-Terry-Luce, then
the top candidates actually executed and interpreted.

Four things Robin does not do. A proposal is only admitted if it maps to a knob some harness here
really exposes. An inert sham candidate is ranked alongside the real ones, and the run refuses its
own ranking if the sham places in the top half. Every assay carries a null control, and breaking
it outranks any headline gain. And each result carries a noise band computed from its own counts:
the first live round called +0.001 on a proportion with a 2-SE band of 0.021 an improvement, which
is the loop inventing a discovery out of seed variation.

The controller's design parameters are now readable from EC_* so the outer loop can move them
without editing the file under test, with a test asserting every advertised knob is connected.
