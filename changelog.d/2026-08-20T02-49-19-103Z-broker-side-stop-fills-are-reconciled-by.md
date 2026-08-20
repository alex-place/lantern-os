### Changed

- Broker-side stop fills are reconciled by order id: the engine remembers every protective stop it places (persisted across restarts) and asks the per-order status endpoint before booking a vanished position as closed externally
