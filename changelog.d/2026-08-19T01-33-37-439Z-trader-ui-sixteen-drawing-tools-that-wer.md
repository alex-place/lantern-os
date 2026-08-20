### Fixed

- trader-ui: sixteen drawing tools that were in the menu but painted nothing now actually draw. When the catalogue went from 19 tools to 39 the new ones got names, icons, shortcuts and settings but no render case, so they armed, committed a drawing object and produced zero pixels. Info line, trend angle, cross line, flat channel, pitchfork, ABCD/XABCD/head-and-shoulders, fib channel, fib time zones, price range, date range, forecast, highlighter, callout and price label all render now (#3354)
