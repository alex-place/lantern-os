### Fixed
- **Working orders can now be canceled** (`DELETE /api/trading/orders/:id`) — user
  testing found manual limit orders could be placed but never canceled (only Kalshi
  had a cancel route). Routes by order-id shape (Alpaca UUID vs numeric IBKR) with an
  honest cross-broker fallback; the first cut resolved the preferred-broker facade,
  which "canceled" an Alpaca order against IBKR and reported success — caught by
  verifying order state on the broker, now covered in the handler comment.
