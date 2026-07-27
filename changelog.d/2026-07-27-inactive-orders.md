### Fixed
- **IBKR `Inactive` orders are no longer reported as `open`.** IBKR parks an order at
  `Inactive` when it was submitted but never transmitted — e.g. it hit the order-warning
  gate and nothing confirmed it. The `/api/trading/orders` normalizer mapped
  `inactive → open`, so **972 inert orders looked like live resting orders**: it made a
  reviewer report a 25× oversell exposure that did not exist, and the orders are not even
  cancellable (`"Order is inactive"`). They now normalize to `inactive`.
- **The re-protect pass caps its retries.** A stop that never transmits is correctly not
  counted as protection, but the pass then retried every scan forever — 972 inert stop
  attempts, ~33 per symbol. After 3 attempts it stops adding and records *why* in the
  skip list, so the underlying failure surfaces instead of being buried under duplicates.
