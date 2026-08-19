### Added

- trader: `TRADER_SHORT_EDGE=selective` — inverse-ETF entries are SELECTED on the three features that separated winning wrapper fires from losing ones (#3349): after 11:00 ET, wrapper drawdown from open > −1.5%, underlying session tape < +0.5%. Composite n=13, 62% WR, +1.70% avg (+0.60% leave-one-day-out) vs 47%/−0.36% for the fires that fail it. Every wrapper fire — allowed or vetoed — now logs all three features (`polarity_allow` / `polarity_veto` rows) so the live table grows regardless. Replaces `falling` as the operator's live mode; `falling` and `0` remain available
