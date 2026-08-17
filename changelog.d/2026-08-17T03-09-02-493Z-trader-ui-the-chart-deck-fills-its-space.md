### Fixed

- trader-ui: the chart deck fills its space again — fixed layouts inscribed the largest SQUARE that fit the deck, so a single chart on a 936x499 area drew a 499x499 panel and left 437px of width empty (47%), and the denser modes wasted an axis the same way (4-up 438px of width, 3-up 193px of height). Grid tracks are equal 1fr fractions now: every panel is still identical to its neighbours, and all seven layouts measure 0px unused on both axes
