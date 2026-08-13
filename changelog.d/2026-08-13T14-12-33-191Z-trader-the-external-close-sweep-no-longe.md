### Changed

- trader: the external-close sweep no longer invents exits from an unreadable position snapshot, and only tracks this engine's own symbols — an empty book at the 2026-08-13 open wrote 4 phantom exits and inflated the ledger to +$7,305 on a day equity fell $4,634
