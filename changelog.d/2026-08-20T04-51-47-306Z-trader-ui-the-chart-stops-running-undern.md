### Fixed

- trader-ui: the chart stops running underneath the docks, and closing the chat gives its space back. A grid item defaults to min-width:auto, and a leftover overlay-era padding-right pinned .main at 728px inside a 492px track — so the chart's right third was hidden behind the ticket and watchlist. The chat's own buttons were driving a display:none shell instead of the dock column (#3355)
