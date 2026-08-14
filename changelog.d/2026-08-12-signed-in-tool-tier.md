### Added

- chat: **a signed-in access tier for tools** (`user_safe`). Chat tools had two tiers — `guest_safe` (anyone) and operator-only, where "operator" means un-proxied loopback or the operator token. On the hosted site there are no operators, so every real customer was denied every non-guest tool, *including tools about their own account*. The new middle tier lets a signed-in user run tools scoped to their own state: `trader_config`, `trader_alerts`, `trader_alert_create`, `trader_alert_delete`, and `trader_pause`. Signed-in users now see 16 tools instead of 11; operators are unchanged at 46.

### Fixed

- chat: the advertised tool set now matches the execution gate on **all three** provider builders (Anthropic, OpenAI, Gemini) via one shared helper, so a model is never offered a tool its own gate would refuse.
- chat: a signed-out caller hitting a `user_safe` tool gets `sign_in_required` — the honest reason — instead of the misleading "requires operator access".

### Security

- Plan entitlements are re-checked inside `user_safe` tools (`_hasCapability`, fails closed on an unknown role), because those tools reach per-user stores directly and would otherwise bypass the route-level gate — chat can never hand a Free user a Pro feature.
- `trader_journal` and `trader_skips` deliberately stay **operator-only**: the autopilot writes one shared ledger with no per-user attribution, so serving them to a hosted user would answer their question with the house book. Per-user attribution in the ledger is the prerequisite for opening those up; a gate flag alone would be a data leak.
- `trader_pause` is deliberately **not** plan-gated — stopping is risk-reducing and must never be withheld from someone whose account is being traded.
