### Research — an OpenReview leg, and the verdict it still does not produce

The audit could not see conference submissions, which is where the paper that killed one of its
two surviving ideas lives. OpenReview api2 is now a third search leg and finds that paper as its
top result for the right query.

Wiring it exposed four more defects: the judge's window was a flat slice that showed twelve arXiv
results and nothing else, OpenReview returns mostly untitled replies so the fetch had to go four
times deeper, one distinctive pair reproduced the positional bias already fixed for arXiv, and the
mill's own output lists were being indexed as prior work so an idea matched the list it came from.

The idea still audits as UNVERIFIED, with the note naming its prior art as the top hit. Recorded
as the measured limit rather than tuned away: the auditor errs toward UNVERIFIED, which is the
safe direction, and is the reason "novel" is not in its vocabulary.
