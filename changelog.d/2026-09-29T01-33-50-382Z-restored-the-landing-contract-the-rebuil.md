### Fixed

- Restored the landing contract the rebuild had broken: the served markup carries the unisona.ai brand again, the assistant CTA keeps the stable home-chat marker, and the journal is reachable from the home page — labelled as needing an account, because journal.html is not in auth-gate's public list and a signed-out click bounces to sign-in. The journal assertion itself was pinned to the pre-#2751 name dream-journal and now checks the route the card actually points at.
