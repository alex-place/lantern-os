### Fixed

- journal: **closing the Share sheet while it is still loading no longer throws.** Open, then Escape before the options arrived, and the arriving reply wrote into a sheet that no longer existed — an uncaught error in the console on every such close, and a stale reply that could paint into a sheet opened again a moment later. A reply now belongs to the sheet that asked for it and is dropped if that sheet has closed.
