### Fixed

- trader: **the crosshair reads a date on daily and longer bars.** It always printed a clock time, so a weekly bar read "Jun 26, 12:00 AM" and a monthly bar on a chart spanning 2007–2026 read "Oct 1, 12:00 AM" — the clock was noise and the year was the missing fact. Daily, weekly and monthly bars now read "Jun 26, 2025"; intraday bars keep the clock the axis reads.
