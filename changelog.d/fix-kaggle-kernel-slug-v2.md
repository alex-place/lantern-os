fix(training): Kaggle kernel slug v2 — title spaces, URL regex, new kernel_id

Three follow-up fixes after the ouro-training 409 conflict root-cause analysis:

1. Title hyphen → space: Kaggle strips hyphens from titles when slugifying
   ("ouro-qlora" → "ouroqlora" ≠ "ouro-qlora"). Using spaces instead:
   "ouro qlora" → slug "ouro-qlora" ✓. Eliminates the "title does not resolve
   to id" warning.

2. URL regex: Kaggle 2.x CLI omits /code/ from progress URLs
   (kaggle.com/user/slug vs kaggle.com/code/user/slug). Updated regex to
   match both: /kaggle\.com(?:\/code)?\/[^/]+\/([^\s"]+)/

3. kernel_id: Changed PCSF from lanternfounder/ouro-training (bound to the
   wrong slug by prior dispatches) to lanternfounder/ouro-qlora — the kernel
   that was created fresh and has a GPU-enabled v3 currently training.
