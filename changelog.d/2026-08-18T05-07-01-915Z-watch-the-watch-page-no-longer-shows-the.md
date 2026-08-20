### Fixed

- watch: the Watch page no longer shows the 'Nearest: S/R' support-resistance line that was removed from the trader months ago. watch.html carries its own copy of the ticker-card renderer, and the commit that removed the line touched stock-trader.html only, so Watch kept rendering it. A parity test now fails when the two hand-rolled renderers diverge on the fields they are meant to share (#3351)
