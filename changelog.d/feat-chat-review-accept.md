### Close the work → review → accept loop in chat: accept/reject a reviewed PR inline

`!review #N` (and the `!prs` browser's *Review →*) rendered a PR's diff + Σ₀ verdict but
offered no way to act on it — so "review a PR in chat, then accept it in chat" dead-ended at
GitHub. The Approve / Discard actions only existed on a *fresh* autowork run panel, keyed to
that run's `prUrl` (#1503), so any PR you didn't just generate was un-actionable.

Now a completed `!review #N` attaches the same **✓ Approve & merge / ✕ Discard** actions
(`POST /api/convergence/pr-action`, keyed by PR number) to the review itself. The full loop —
autowork *works* an issue → you *review* the draft PR → you *accept* it — now runs in one
surface (dream-chat) without leaving for GitHub. The server already tags the review turn's
done event `source:"review"`; the client keys off that + the PR number from the sent text.
