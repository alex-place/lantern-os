Add a `list_pull_requests` native chat tool so the assistant can list open PRs.

After the #2303 pure-LLM refactor removed deterministic keyword routing, "show me
prs" fell through to the model, which had only `github_issue` (single-by-number) and
no way to *list* PRs — so it hallucinated a GitHub call and returned "Not Found (HTTP
404)". The new tool shells the same shell-free `gh pr list` the `/api/dream/prs` route
uses (guest-safe, read-only), closing the Act-stage gap: advertised == executed ==
trainable (ADR-0008).
