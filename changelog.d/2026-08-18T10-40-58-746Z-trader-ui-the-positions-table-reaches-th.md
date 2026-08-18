### Fixed

- trader-ui: the positions table reaches the edge of its panel again. The footer still carried the padding-right it needed when the order ticket and chat floated over it as overlays — 356px on a 512px footer, leaving a 156px content box. They are dock columns now, so the grid already reserves their space and the padding subtracted it a second time. That is why even an inline width:100% on the rows changed nothing: the containing block really was 156px (#3355)
