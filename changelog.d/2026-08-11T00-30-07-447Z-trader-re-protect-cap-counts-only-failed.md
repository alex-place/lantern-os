### Changed

- trader: re-protect cap counts only FAILED stop placements (Inactive/needs_confirmation/rejected) — deliberately-cancelled lifecycle stops no longer starve re-protection (149 capped rows + naked-stop stretches on 2026-08-10)
