### Fixed

- trader: **the long and short position tools size the position.** Account size, Risk percent and Lot size were offered in their settings and read by nothing, and the Position size switch showed nothing, so the one drawing tool whose whole job is planning a trade advertised position sizing and did none. It now works out the units the plan implies, by the same arithmetic the order ticket uses, and says what that risks. Risk and reward in R and the three prices are switches that work rather than decoration, and the target's own price is shown, which it never was.
