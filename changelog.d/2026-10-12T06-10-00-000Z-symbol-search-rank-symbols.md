### Fixed

- trader: a partial symbol finds the company again. #3768's shorter-name tie-break (meant for company-name searches) also applied to symbol matches, where the funds built on a stock usually have the shorter names — "NVD" put "ProShares Ultra NVDA" and a Roundhill fund above NVDA, and "TSL" put TSLI above TSLA. The tie-break now applies to name matches only; symbol matches keep the broker list's order, as before.
