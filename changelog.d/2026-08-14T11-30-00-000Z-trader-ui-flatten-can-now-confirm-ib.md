### Fixed

- trader-ui: Flatten can now complete when IBKR raises order warnings — the button dead-ended ("re-submit with acceptWarnings:true") because the route never forwarded the flag the bridge has supported since 2026-07-27. The user is shown IBKR's own warning text and the resubmit carries `acceptWarnings` only after they confirm; sells only, strict boolean, buys always keep surfacing warnings (P0-8)
