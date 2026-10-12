### Fixed

- trader: the session clock on the range strip no longer says "wknd" on a weekday evening. After 20:00 ET its last branch had no countdown, and the label printed "wknd" for that — so every Monday-to-Thursday evening read "Closed · wknd". It now counts to the next 04:00 pre-market ("Closed · 7h 00m to pre" at 21:00 on a Tuesday); Friday night and the weekend still read "wknd".
