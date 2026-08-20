### Fixed

- trader-ui: the dock rail icons render again — writing ico() calls into static HTML printed them as literal text instead of drawing SVG; elements now declare data-ico and are painted at load. The watchlist symbol sits next to its icon rather than floating away from the figures: the slack moved to a spacer between the name and the numbers, and the panel is back to 340px (#3355)
