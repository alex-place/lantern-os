### Fixed

- trader: focusing the symbol an order ticket is already on no longer wipes the ticket. The ticket follows the focused symbol by starting a fresh one — quantity 1, no take-profit, no stop — and it did so even when the focus landed on the symbol it was already on. A chart's BUY opens a ticket without moving the focus, so clicking that same chart (or its watchlist row) after entering a quantity and a stop reset both without a word, and the order could go in without the stop. The ticket now moves only to a different symbol; BUY/SELL still open a fresh ticket.
