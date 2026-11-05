### Added

- trading: `TRADER_MAX_LOSS_RTH_ONLY=1` makes the max-loss cap act in regular hours only, off unless set. Outside regular hours a position past the cap places no order, keeps its stop and journals one `max_loss_held` row; the first regular-hours pass reads the price of that moment, so a position back above the cap stays held. A box that does not set the switch changes nothing. The risk it accepts: nothing sells in the dark, and a real overnight collapse is met at the open.
