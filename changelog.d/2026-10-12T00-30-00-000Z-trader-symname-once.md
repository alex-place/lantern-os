### Fixed

- trader: the symbol panel asks for a symbol's name once. It re-renders several times while the answer is in flight and each render asked again — three identical symbol-info requests for SPY on every load; now one, through the same once-per-symbol path the positions table uses.
