### Fixed

- trader-ui: the indicator picker no longer lets you add the same indicator twice by accident. An indicator that is on the chart leaves the add list, and a second click opens its settings instead of cloning it. Deliberate multiple copies (EMA 9 + EMA 21 + EMA 200) moved to a + button on the active row, which seeds the copy with a different period so it is visibly its own line rather than an overlay on its twin (#3333)
