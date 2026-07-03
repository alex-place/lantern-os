feat(help): add an FAQ page and make it the first link in the Knowledge Center

New `/faq.html` — a grouped, accordion-style Frequently Asked Questions page
(Getting started, Privacy & your data, How it works, Plans & billing) built only
from site.css tokens, with nav/footer via site-chrome.js and native `<details>`
accordions for keyboard + screen-reader access. Every answer links to an existing
guide (README, QUICKSTART, PROVIDERS, KEYSTONE-LIMITATIONS, PRIVACY_GOVERNANCE,
pricing) — all verified 200 in a local preview. The Knowledge Center's "Start
here" grid now leads with an FAQ card; "What's new" is preserved as the second
card so the release note keeps its only entry point. Registered `faq.html` as an
EXTENSION (meta) surface so the surface-boundary contract test stays green.
Strengthens the Remember stage — grounded, self-serve help in one place.
