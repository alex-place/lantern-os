### Research — the mill now checks whether an idea is already done

A web-search red team of the first bench lists killed half of the hand triage: two ideas were
called novel because the local corpus retrieved nothing close, and one query each found the prior
art. Four more were already answered inside this repo, which no web search would ever surface.

So the mill gained a novelty audit with six verdicts, none of which means "novel" — `UNVERIFIED`
is the floor, and it carries the web queries that would have to come back empty first. It reads
this repository's own notebook (432 experiments, notes, ADRs and result files) alongside the arXiv
corpus and the papers each idea was generated from. The auditor is audited every run by two
planted ideas; if either slips through, all its verdicts are marked untrusted.

On the goal that produced the first list, the audit labels the top two ranked ideas ANSWERED-HERE
with the file that measured them.
