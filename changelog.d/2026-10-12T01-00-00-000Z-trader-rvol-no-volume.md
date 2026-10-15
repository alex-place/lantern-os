### Fixed

- trader: relative volume is shown only when there is volume to measure. With no prior volume to average, the symbol panel's RVOL fell back to 1 — and Yahoo reports every extended-hours and weekend 5-minute bar with volume 0, so off-hours every symbol read 'RVOL 1.00×', the RVOL sort was a tie, and orders placed then were auto-tagged in the trade journal with that made-up figure. Now it is absent, as it already was for a symbol with too little history.
