### Fixed

- trader: "/" (jump to symbol) now charts the symbol you pick. It searches every symbol, but a pick not on your watchlist only moved the details panel and the order ticket — priced "$—", since prices arrive through the list — while the chart stayed on the previous symbol, so B/S opened a ticket for a symbol that was not on screen. The pick now goes on your watchlist first (tracking only, never the AI trader's list), as the chart's own symbol search already did, and is then focused, which in a one-chart deck charts it. If it cannot go on the list, nothing moves.
