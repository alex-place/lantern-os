### Fixed
- **Risk-reducing sells now clear IBKR order warnings.** In the first fully-armed
  session the engine made 13 correct exit decisions and executed **none** — every order
  returned `needs_confirmation` because IBKR raised warnings and the code refused to
  confirm them. A max-loss sell decided at −16.9% was still open at −18.9%, and an AMD
  take-profit at +3.9% gave the entire gain back (−3.7%). Exits and protective stops
  (which only ever *reduce* exposure) now opt into `acceptWarnings`; **entries still
  surface warnings for a human**, which is what the original guard was protecting.
- **The overnight book only defers to positions it opened itself.** Its no-commingling
  check vetoed the QQQ capitulation sleeve because *some other* strategy's legacy QQQ
  shares sat in the account. Unrelated or stale holdings are not this engine's business
  — it manages only what it opened. Additionally the check no longer applies at all on
  the **options** tier: holding QQQ shares cannot make a QQQ *call* exit ambiguous.
